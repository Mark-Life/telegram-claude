import { Bot, InlineKeyboard, type Context } from "grammy"
import { readdirSync, statSync } from "fs"
import { join, basename } from "path"
import { runClaude, stopClaude, hasActiveProcess } from "./claude"
import { streamToTelegram } from "./telegram"
import { transcribeAudio } from "./transcribe"

type UserState = {
  activeProject: string
  sessions: Map<string, string>
}

const userStates = new Map<number, UserState>()

/** Get or create user state */
function getState(userId: number): UserState {
  let state = userStates.get(userId)
  if (!state) {
    state = { activeProject: "", sessions: new Map() }
    userStates.set(userId, state)
  }
  return state
}

/** List project directories */
function listProjects(projectsDir: string) {
  try {
    return readdirSync(projectsDir)
      .filter((name) => {
        try {
          return statSync(join(projectsDir, name)).isDirectory()
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    return []
  }
}

/** Create and configure the bot */
export function createBot(token: string, allowedUserId: number, projectsDir: string) {
  const bot = new Bot(token)

  // Access control middleware
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== allowedUserId) {
      await ctx.reply("Unauthorized.")
      return
    }
    await next()
  })

  bot.command("start", async (ctx) => {
    const state = getState(ctx.from!.id)
    const project = state.activeProject || "(none)"
    await ctx.reply(`Claude Code bot ready.\nActive project: ${project}\n\nCommands:\n/projects - switch project\n/stop - kill active process\n/status - current state\n/new - reset session`)
  })

  bot.command("projects", async (ctx) => {
    const projects = listProjects(projectsDir)
    if (projects.length === 0) {
      await ctx.reply(`No projects found in ${projectsDir}`)
      return
    }

    const keyboard = new InlineKeyboard()
    keyboard.text("General (all projects)", "project:__general__").row()
    for (const name of projects) {
      keyboard.text(name, `project:${name}`).row()
    }
    await ctx.reply("Select a project:", { reply_markup: keyboard })
  })

  bot.callbackQuery(/^project:(.+)$/, async (ctx) => {
    const name = ctx.match![1]
    const isGeneral = name === "__general__"
    const fullPath = isGeneral ? projectsDir : join(projectsDir, name)
    const displayName = isGeneral ? "general (all projects)" : name

    if (!isGeneral) {
      try {
        statSync(fullPath)
      } catch {
        await ctx.answerCallbackQuery({ text: "Project not found" })
        return
      }
    }

    const state = getState(ctx.from!.id)
    state.activeProject = fullPath
    await ctx.answerCallbackQuery({ text: `Switched to ${displayName}` })
    await ctx.editMessageText(`Active project: ${displayName}`)
  })

  bot.command("stop", async (ctx) => {
    const stopped = stopClaude(ctx.from!.id)
    await ctx.reply(stopped ? "Process stopped." : "No active process.")
  })

  bot.command("status", async (ctx) => {
    const state = getState(ctx.from!.id)
    const project = state.activeProject
      ? state.activeProject === projectsDir ? "general" : basename(state.activeProject)
      : "(none)"
    const running = hasActiveProcess(ctx.from!.id) ? "Yes" : "No"
    const sessionCount = state.sessions.size

    await ctx.reply(`Project: ${project}\nRunning: ${running}\nSessions: ${sessionCount}`)
  })

  bot.command("new", async (ctx) => {
    const state = getState(ctx.from!.id)
    if (state.activeProject) {
      state.sessions.delete(state.activeProject)
    }
    await ctx.reply("Session cleared. Next message starts a fresh conversation.")
  })

  /** Send a prompt to Claude and stream the response */
  async function handlePrompt(ctx: Context, prompt: string) {
    const state = getState(ctx.from!.id)

    if (!state.activeProject) {
      await ctx.reply("No project selected. Use /projects to pick one.")
      return
    }

    const sessionId = state.sessions.get(state.activeProject)
    const projectName = state.activeProject === projectsDir ? "general" : basename(state.activeProject)

    const events = runClaude(ctx.from!.id, prompt, state.activeProject, sessionId)
    const result = await streamToTelegram(ctx, events, projectName)

    if (result.sessionId) {
      state.sessions.set(state.activeProject, result.sessionId)
    }
  }

  bot.on("message:text", (ctx) => {
    handlePrompt(ctx, ctx.message.text).catch((e) => console.error("handlePrompt error:", e))
  })

  bot.on("message:voice", async (ctx) => {
    const state = getState(ctx.from!.id)

    if (!state.activeProject) {
      await ctx.reply("No project selected. Use /projects to pick one.")
      return
    }

    const file = await ctx.getFile()
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    const res = await fetch(url)
    const buffer = Buffer.from(await res.arrayBuffer())

    const status = await ctx.reply("Transcribing...")
    const prompt = await transcribeAudio(buffer, "voice.ogg")
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `[Voice] ${prompt}`)

    handlePrompt(ctx, prompt).catch((e) => console.error("handlePrompt error:", e))
  })

  return bot
}
