import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy"
import { readdirSync, statSync, mkdirSync, writeFileSync } from "fs"
import { execSync } from "child_process"
import { join, basename } from "path"
import { runClaude, stopClaude, hasActiveProcess } from "./claude"
import { streamToTelegram } from "./telegram"
import { transcribeAudio } from "./transcribe"
import { listAllSessions, getSessionProject } from "./history"

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

/** Persistent reply keyboard with all commands */
const mainKeyboard = new Keyboard()
  .text("Projects").text("History").row()
  .text("Stop").text("New").row()
  .resized().persistent()

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

/** Get GitHub HTTPS URL for a project directory, or null if unavailable */
function getGitHubUrl(projectPath: string) {
  try {
    const raw = execSync("git remote get-url origin", { cwd: projectPath, timeout: 3000 })
      .toString()
      .trim()
    // SSH: git@github.com:user/repo.git -> https://github.com/user/repo
    const sshMatch = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
    if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`
    // HTTPS: strip trailing .git
    try {
      const url = new URL(raw)
      url.pathname = url.pathname.replace(/\.git$/, "")
      return url.toString()
    } catch {
      return null
    }
  } catch {
    return null
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

  const buttonToCommand: Record<string, string> = {
    Projects: "/projects",
    History: "/history",
    Stop: "/stop",
    New: "/new",
  }
  bot.use((ctx, next) => {
    const text = ctx.message?.text
    if (text && text in buttonToCommand) {
      const cmd = buttonToCommand[text]
      ctx.message!.text = cmd
      ctx.message!.entities = [{ type: "bot_command", offset: 0, length: cmd.length }]
    }
    return next()
  })

  bot.command("start", async (ctx) => {
    const state = getState(ctx.from!.id)
    const project = state.activeProject || "(none)"
    await ctx.reply(`Claude Code bot ready.\nActive project: ${project}\n\nCommands:\n/projects - switch project\n/history - resume a past session\n/stop - kill active process\n/status - current state\n/new - reset session`, { reply_markup: mainKeyboard })
  })

  bot.command("projects", async (ctx) => {
    const projects = listProjects(projectsDir)
    if (projects.length === 0) {
      await ctx.reply(`No projects found in ${projectsDir}`, { reply_markup: mainKeyboard })
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
    const ghUrl = isGeneral ? null : getGitHubUrl(fullPath)
    const projectLabel = ghUrl
      ? `<a href="${escapeHtml(ghUrl)}">${escapeHtml(displayName)}</a>`
      : escapeHtml(displayName)
    const msg = await ctx.editMessageText(`Active project: ${projectLabel}`, { parse_mode: "HTML" })
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
    await ctx.reply(stopped ? "Process stopped." : "No active process.", { reply_markup: mainKeyboard })
  })

  bot.command("status", async (ctx) => {
    const state = getState(ctx.from!.id)
    const project = state.activeProject
      ? state.activeProject === projectsDir ? "general" : basename(state.activeProject)
      : "(none)"
    const running = hasActiveProcess(ctx.from!.id) ? "Yes" : "No"
    const sessionCount = state.sessions.size

    await ctx.reply(`Project: ${project}\nRunning: ${running}\nSessions: ${sessionCount}`, { reply_markup: mainKeyboard })
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
      { parse_mode: "HTML", reply_markup: mainKeyboard },
    )
  })

  bot.command("new", async (ctx) => {
    const state = getState(ctx.from!.id)
    if (!state.activeProject) {
      state.activeProject = projectsDir
    }
    state.sessions.delete(state.activeProject)
    await ctx.reply("Session cleared. Next message starts a fresh conversation.", { reply_markup: mainKeyboard })
  })

  /** Build paginated history message with inline keyboard */
  function buildHistoryMessage(page: number) {
    const sessions = listAllSessions()

    if (sessions.length === 0) return null

    const totalPages = Math.ceil(sessions.length / HISTORY_PAGE_SIZE)
    const safePage = Math.max(0, Math.min(page, totalPages - 1))
    const pageSlice = sessions.slice(safePage * HISTORY_PAGE_SIZE, (safePage + 1) * HISTORY_PAGE_SIZE)

    const keyboard = new InlineKeyboard()
    for (const s of pageSlice) {
      const date = new Date(s.lastActiveAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      const label = `${date} — [${s.projectName}] ${s.summary.slice(0, 30)}`
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
    return { text: `All sessions${pageIndicator}:`, keyboard }
  }

  bot.command("history", async (ctx) => {
    const result = buildHistoryMessage(0)

    if (!result) {
      await ctx.reply("No session history found.", { reply_markup: mainKeyboard })
      return
    }

    await ctx.reply(result.text, {
      reply_markup: result.keyboard,
      parse_mode: "HTML",
    })
  })

  bot.callbackQuery(/^history:(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match![1], 10)
    const result = buildHistoryMessage(page)

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
    if (cachedProject) {
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
      await ctx.reply("No project selected. Use /projects to pick one.", { reply_markup: mainKeyboard })
      return
    }

    const sessionId = state.sessions.get(state.activeProject)
    const projectName = state.activeProject === projectsDir ? "general" : basename(state.activeProject)

    const events = runClaude(ctx.from!.id, prompt, state.activeProject, ctx.chat!.id, sessionId)
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
      await ctx.reply("No project selected. Use /projects to pick one.", { reply_markup: mainKeyboard })
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
      const maxDisplay = 3800
      const displayText = prompt.length > maxDisplay
        ? prompt.slice(0, maxDisplay) + "... (truncated)"
        : prompt
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, `<blockquote>${escapeHtml(displayText)}</blockquote>`, { parse_mode: "HTML" })
    } catch (e) {
      console.error("Voice transcription error:", e)
      await ctx.reply(`Transcription failed: ${e instanceof Error ? e.message : "unknown error"}`)
      return
    }

    const fullPrompt = buildPromptWithReplyContext(ctx, prompt)
    handlePrompt(ctx, fullPrompt).catch((e) => console.error("handlePrompt error:", e))
  })

  /** Download a Telegram file and save to project's user-sent-files dir */
  async function saveUploadedFile(ctx: Context, filename: string) {
    const state = getState(ctx.from!.id)
    if (!state.activeProject) {
      await ctx.reply("No project selected. Use /projects to pick one.", { reply_markup: mainKeyboard })
      return null
    }

    const file = await ctx.getFile()
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    const res = await fetch(url)
    const buffer = Buffer.from(await res.arrayBuffer())

    const dir = join(state.activeProject, "user-sent-files")
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, filename)
    writeFileSync(dest, buffer)
    return dest
  }

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document
    const filename = doc.file_name ?? `file_${Date.now()}`

    try {
      const dest = await saveUploadedFile(ctx, filename)
      if (!dest) return

      const caption = ctx.message.caption ?? "See the attached file."
      const prompt = `${caption}\n\n[File: ${filename} saved at ${dest}]`
      const fullPrompt = buildPromptWithReplyContext(ctx, prompt)
      handlePrompt(ctx, fullPrompt).catch((e) => console.error("handlePrompt error:", e))
    } catch (e) {
      console.error("Document upload error:", e)
      await ctx.reply(`File upload failed: ${e instanceof Error ? e.message : "unknown error"}`)
    }
  })

  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo
    const largest = photos[photos.length - 1]
    const filename = `photo_${Date.now()}.jpg`

    try {
      // Override ctx.getFile to use the largest photo's file_id
      const origGetFile = ctx.getFile.bind(ctx)
      ctx.getFile = () => ctx.api.getFile(largest.file_id) as ReturnType<typeof origGetFile>

      const dest = await saveUploadedFile(ctx, filename)
      if (!dest) return

      const caption = ctx.message.caption ?? "See the attached photo."
      const prompt = `${caption}\n\n[Photo saved at ${dest}]`
      const fullPrompt = buildPromptWithReplyContext(ctx, prompt)
      handlePrompt(ctx, fullPrompt).catch((e) => console.error("handlePrompt error:", e))
    } catch (e) {
      console.error("Photo upload error:", e)
      await ctx.reply(`Photo upload failed: ${e instanceof Error ? e.message : "unknown error"}`)
    }
  })

  return bot
}
