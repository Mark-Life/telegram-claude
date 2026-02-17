import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy"
import { readdirSync, statSync } from "fs"
import { join, basename } from "path"
import { runClaude, stopClaude, hasActiveProcess } from "./claude"
import { streamToTelegram } from "./telegram"
import { transcribeAudio } from "./transcribe"
import { listSessions, listAllSessions, getSessionProject } from "./history"

type UserState = {
  activeProject: string
  sessions: Map<string, string>
  pinnedMessageId?: number
}

const userStates = new Map<number, UserState>()
const HISTORY_PAGE_SIZE = 5

/** Escape HTML special characters for Telegram */
function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Keyboard shown when no prompt is running */
function idleKeyboard() {
  return new Keyboard()
    .text("/projects").text("/history").row()
    .text("/new").text("/help").row()
    .resized().persistent()
}

/** Keyboard shown while a prompt is running */
function runningKeyboard() {
  return new Keyboard()
    .text("/stop").row()
    .resized().persistent()
}

/** Extract reply-to-message text and prepend it as context */
function buildPromptWithReplyContext(ctx: Context, userText: string) {
  const replyText = ctx.message?.reply_to_message?.text
  if (!replyText) return userText
  const truncated = replyText.length > 2000 ? replyText.slice(0, 2000) + "..." : replyText
  return `[Replying to: ${truncated}]\n\n${userText}`
}

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
  const botId = parseInt(token.split(":")[0], 10)
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.id === botId) return
    if (ctx.from.id !== allowedUserId) {
      console.log(`Auth rejected: from=${ctx.from.id} allowed=${allowedUserId}`)
      await ctx.reply("Telegram User is Unauthorized.")
      return
    }
    await next()
  })

  bot.command("start", async (ctx) => {
    const state = getState(ctx.from!.id)
    const project = state.activeProject || "(none)"
    await ctx.reply(`Claude Code bot ready.\nActive project: ${project}\n\nCommands:\n/projects - switch project\n/history - resume a past session\n/stop - kill active process\n/status - current state\n/new - reset session`, { reply_markup: idleKeyboard() })
  })

  bot.command("projects", async (ctx) => {
    const projects = listProjects(projectsDir)
    if (projects.length === 0) {
      await ctx.reply(`No projects found in ${projectsDir}`, { reply_markup: idleKeyboard() })
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
    const chatId = ctx.chat!.id
    state.activeProject = fullPath
    await ctx.answerCallbackQuery({ text: `Switched to ${displayName}` })
    const msg = await ctx.editMessageText(`Active project: ${displayName}`)
    if (state.pinnedMessageId) {
      await ctx.api.unpinChatMessage(chatId, state.pinnedMessageId).catch(() => {})
    }
    const pinnedId = typeof msg === "object" && "message_id" in msg ? msg.message_id : undefined
    if (pinnedId) {
      await ctx.api.pinChatMessage(chatId, pinnedId, { disable_notification: true }).catch(() => {})
      state.pinnedMessageId = pinnedId
    }
  })

  bot.command("stop", async (ctx) => {
    const stopped = stopClaude(ctx.from!.id)
    await ctx.reply(stopped ? "Process stopped." : "No active process.", { reply_markup: idleKeyboard() })
  })

  bot.command("status", async (ctx) => {
    const state = getState(ctx.from!.id)
    const project = state.activeProject
      ? state.activeProject === projectsDir ? "general" : basename(state.activeProject)
      : "(none)"
    const running = hasActiveProcess(ctx.from!.id) ? "Yes" : "No"
    const sessionCount = state.sessions.size

    await ctx.reply(`Project: ${project}\nRunning: ${running}\nSessions: ${sessionCount}`, { reply_markup: idleKeyboard() })
  })

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "<b>Commands:</b>",
        "/projects — switch active project",
        "/history — resume a past session",
        "/new — start fresh conversation",
        "/stop — kill active process",
        "/status — show current state",
        "/help — show this message",
        "",
        "Send any text or voice message to chat with Claude in the active project.",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: idleKeyboard() },
    )
  })

  bot.command("new", async (ctx) => {
    const state = getState(ctx.from!.id)
    if (!state.activeProject) {
      state.activeProject = projectsDir
    }
    state.sessions.delete(state.activeProject)
    await ctx.reply("Session cleared. Next message starts a fresh conversation.", { reply_markup: idleKeyboard() })
  })

  /** Build paginated history message with inline keyboard */
  function buildHistoryMessage(state: UserState, page: number) {
    const isGlobal = !state.activeProject
    const sessions = isGlobal
      ? listAllSessions()
      : listSessions(state.activeProject)

    if (sessions.length === 0) return null

    const totalPages = Math.ceil(sessions.length / HISTORY_PAGE_SIZE)
    const safePage = Math.max(0, Math.min(page, totalPages - 1))
    const pageSlice = sessions.slice(safePage * HISTORY_PAGE_SIZE, (safePage + 1) * HISTORY_PAGE_SIZE)

    const keyboard = new InlineKeyboard()
    for (const s of pageSlice) {
      const date = new Date(s.lastActiveAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      const prefix = isGlobal ? `[${s.projectName}] ` : ""
      const maxSummary = isGlobal ? 30 : 40
      const label = `${date} — ${prefix}${s.summary.slice(0, maxSummary)}`
      keyboard.text(label, `session:${s.sessionId}`).row()
    }

    const navRow: { text: string; data: string }[] = []
    if (safePage > 0) navRow.push({ text: "<< Prev", data: `history:${safePage - 1}` })
    if (safePage < totalPages - 1) navRow.push({ text: "Next >>", data: `history:${safePage + 1}` })
    if (navRow.length > 0) {
      for (const btn of navRow) keyboard.text(btn.text, btn.data)
      keyboard.row()
    }

    const pageIndicator = totalPages > 1 ? ` (${safePage + 1}/${totalPages})` : ""
    const title = isGlobal
      ? `Recent sessions (all projects)${pageIndicator}:`
      : `Sessions for <b>${escapeHtml(state.activeProject === projectsDir ? "general" : basename(state.activeProject))}</b>${pageIndicator}:`

    return { text: title, keyboard }
  }

  bot.command("history", async (ctx) => {
    const state = getState(ctx.from!.id)
    const result = buildHistoryMessage(state, 0)

    if (!result) {
      const isGlobal = !state.activeProject
      await ctx.reply(isGlobal ? "No session history found." : "No session history found for this project.", { reply_markup: idleKeyboard() })
      return
    }

    await ctx.reply(result.text, {
      reply_markup: result.keyboard,
      parse_mode: "HTML",
    })
  })

  bot.callbackQuery(/^history:(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match![1], 10)
    const state = getState(ctx.from!.id)
    const result = buildHistoryMessage(state, page)

    if (!result) {
      await ctx.answerCallbackQuery({ text: "No sessions found" })
      return
    }

    await ctx.editMessageText(result.text, {
      reply_markup: result.keyboard,
      parse_mode: "HTML",
    })
    await ctx.answerCallbackQuery()
  })

  bot.callbackQuery(/^session:(.+)$/, async (ctx) => {
    const sessionId = ctx.match![1]
    const state = getState(ctx.from!.id)

    const cachedProject = getSessionProject(sessionId)
    if (!state.activeProject && cachedProject) {
      state.activeProject = cachedProject
    }

    if (!state.activeProject) {
      await ctx.answerCallbackQuery({ text: "No project selected" })
      return
    }

    state.sessions.set(state.activeProject, sessionId)
    const chatId = ctx.chat!.id
    const projectName = basename(state.activeProject)
    await ctx.answerCallbackQuery({ text: "Session resumed" })
    const msg = await ctx.editMessageText(`Resumed session in <b>${escapeHtml(projectName)}</b>. Next message continues this conversation.`, { parse_mode: "HTML" })
    if (state.pinnedMessageId) {
      await ctx.api.unpinChatMessage(chatId, state.pinnedMessageId).catch(() => {})
    }
    const pinnedId = typeof msg === "object" && "message_id" in msg ? msg.message_id : undefined
    if (pinnedId) {
      await ctx.api.pinChatMessage(chatId, pinnedId, { disable_notification: true }).catch(() => {})
      state.pinnedMessageId = pinnedId
    }
  })

  /** Send a prompt to Claude and stream the response */
  async function handlePrompt(ctx: Context, prompt: string) {
    const state = getState(ctx.from!.id)

    if (!state.activeProject) {
      await ctx.reply("No project selected. Use /projects to pick one.", { reply_markup: idleKeyboard() })
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
    const prompt = buildPromptWithReplyContext(ctx, ctx.message.text)
    handlePrompt(ctx, prompt).catch((e) => console.error("handlePrompt error:", e))
  })

  bot.on("message:voice", async (ctx) => {
    const state = getState(ctx.from!.id)

    if (!state.activeProject) {
      await ctx.reply("No project selected. Use /projects to pick one.", { reply_markup: idleKeyboard() })
      return
    }

    let prompt: string
    try {
      const file = await ctx.getFile()
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
      const res = await fetch(url)
      const buffer = Buffer.from(await res.arrayBuffer())

      const status = await ctx.reply("Transcribing...", {
        reply_parameters: { message_id: ctx.message.message_id },
      })
      prompt = await transcribeAudio(buffer, "voice.ogg")
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, `<blockquote>${prompt}</blockquote>`, { parse_mode: "HTML" })
    } catch (e) {
      console.error("Voice transcription error:", e)
      await ctx.reply(`Transcription failed: ${e instanceof Error ? e.message : "unknown error"}`)
      return
    }

    const fullPrompt = buildPromptWithReplyContext(ctx, prompt)
    handlePrompt(ctx, fullPrompt).catch((e) => console.error("handlePrompt error:", e))
  })

  return bot
}
