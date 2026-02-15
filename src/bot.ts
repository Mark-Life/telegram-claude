import { Bot, InlineKeyboard } from "grammy"
import { readdirSync, statSync } from "fs"
import { join, basename } from "path"
import { runClaude, stopClaude, hasActiveProcess } from "./claude"
import { streamToTelegram } from "./telegram"

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
    for (const name of projects) {
      keyboard.text(name, `project:${name}`).row()
    }
    await ctx.reply("Select a project:", { reply_markup: keyboard })
  })

  bot.callbackQuery(/^project:(.+)$/, async (ctx) => {
    const name = ctx.match![1]
    const fullPath = join(projectsDir, name)

    try {
      statSync(fullPath)
    } catch {
      await ctx.answerCallbackQuery({ text: "Project not found" })
      return
    }

    const state = getState(ctx.from!.id)
    state.activeProject = fullPath
    await ctx.answerCallbackQuery({ text: `Switched to ${name}` })
    await ctx.editMessageText(`Active project: ${name}`)
  })

  bot.command("stop", async (ctx) => {
    const stopped = stopClaude(ctx.from!.id)
    await ctx.reply(stopped ? "Process stopped." : "No active process.")
  })

  bot.command("status", async (ctx) => {
    const state = getState(ctx.from!.id)
    const project = state.activeProject ? basename(state.activeProject) : "(none)"
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

  // Text messages -> Claude
  bot.on("message:text", async (ctx) => {
    const state = getState(ctx.from!.id)

    if (!state.activeProject) {
      await ctx.reply("No project selected. Use /projects to pick one.")
      return
    }

    const prompt = ctx.message.text
    const sessionId = state.sessions.get(state.activeProject)
    const projectName = basename(state.activeProject)

    const events = runClaude(ctx.from!.id, prompt, state.activeProject, sessionId)
    const result = await streamToTelegram(ctx, events, projectName)

    if (result.sessionId) {
      state.sessions.set(state.activeProject, result.sessionId)
    }
  })

  return bot
}
