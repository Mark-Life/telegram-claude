import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy"
import { readdirSync, statSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"
import { runClaude, stopClaude, hasActiveProcess } from "./claude"
import { streamToTelegram } from "./telegram"
import { transcribeAudio } from "./transcribe"
import { listAllSessions, getSessionProject } from "./history"
import { getGitHubUrl, getCurrentBranch, listBranches, listOpenPRs, createWorktree, removeWorktree } from "./git"

type QueuedMessage = { prompt: string; ctx: Context; targetCwd: string }

type WorktreeInfo = { path: string; branch: string; projectPath: string }

type PendingPlan = {
  planPath: string
  sessionId?: string
  projectPath: string
}

type UserState = {
  activeProject: string
  activeWorktree?: string
  worktrees: Map<string, WorktreeInfo>
  sessions: Map<string, string>
  queue: QueuedMessage[]
  queueStatusMessageId?: number
  pendingPlan?: PendingPlan
}

const userStates = new Map<number, UserState>()
const HISTORY_PAGE_SIZE = 5

/** Escape HTML special characters for Telegram */
function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Persistent reply keyboard with all commands */
const mainKeyboard = new Keyboard()
  .text("Projects").text("Worktrees").row()
  .text("History").text("New").row()
  .text("Stop").row()
  .resized().persistent()

/** Extract reply-to-message text and prepend it as context (skip bot's own messages) */
function buildPromptWithReplyContext(ctx: Context, userText: string, botId?: number) {
  const replyText = ctx.message?.reply_to_message?.text
  if (!replyText) return userText
  if (botId && ctx.message?.reply_to_message?.from?.id === botId) return userText
  const truncated = replyText.length > 2000 ? replyText.slice(0, 2000) + "..." : replyText
  return `[Replying to: ${truncated}]\n\n${userText}`
}

/** Get or create user state */
function getState(userId: number): UserState {
  let state = userStates.get(userId)
  if (!state) {
    state = { activeProject: "", worktrees: new Map(), sessions: new Map(), queue: [] }
    userStates.set(userId, state)
  }
  return state
}

/** Get the effective working directory: worktree path if active, else activeProject */
function getEffectiveCwd(state: UserState) {
  if (state.activeWorktree) {
    const wt = state.worktrees.get(state.activeWorktree)
    if (wt) return wt.path
  }
  return state.activeProject
}

/** Get display name: "project/worktree" if worktree active, else project basename */
function getEffectiveProjectName(state: UserState, projectsDir: string) {
  if (state.activeWorktree) {
    const wt = state.worktrees.get(state.activeWorktree)
    if (wt) return `${basename(wt.projectPath)}/${state.activeWorktree}`
  }
  return state.activeProject === projectsDir ? "general" : basename(state.activeProject)
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

  const buttonToCommand: Record<string, string> = {
    Projects: "/projects",
    Worktrees: "/wt",
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
    state.activeWorktree = undefined
    state.worktrees.clear()
    state.queue = []
    state.pendingPlan = undefined
    await cleanupQueueStatus(state, ctx)
    await ctx.answerCallbackQuery({ text: `Switched to ${displayName}` })
    const ghUrl = isGeneral ? null : getGitHubUrl(fullPath)
    const projectLabel = ghUrl
      ? `<a href="${escapeHtml(ghUrl)}">${escapeHtml(displayName)}</a>`
      : escapeHtml(displayName)
    const branch = isGeneral ? null : getCurrentBranch(fullPath)
    const branchSuffix = branch ? ` [${escapeHtml(branch)}]` : ""
    const msg = await ctx.editMessageText(`Active project: ${projectLabel}${branchSuffix}`, { parse_mode: "HTML" })
    await ctx.api.unpinAllChatMessages(chatId).catch(() => {})
    const pinnedId = typeof msg === "object" && "message_id" in msg ? msg.message_id : undefined
    if (pinnedId) {
      await ctx.api.pinChatMessage(chatId, pinnedId, { disable_notification: true }).catch(() => {})
    }
  })

  bot.command("stop", async (ctx) => {
    const userId = ctx.from!.id
    const state = getState(userId)
    const stopped = stopClaude(userId)
    const hadQueue = state.queue.length > 0
    state.queue = []
    state.pendingPlan = undefined
    await cleanupQueueStatus(state, ctx)
    const msg = stopped ? "Process stopped." + (hadQueue ? " Queue cleared." : "") : "No active process."
    await ctx.reply(msg, { reply_markup: mainKeyboard })
  })

  bot.command("status", async (ctx) => {
    const userId = ctx.from!.id
    const state = getState(userId)
    const project = state.activeProject
      ? state.activeProject === projectsDir ? "general" : basename(state.activeProject)
      : "(none)"
    const effectiveCwd = getEffectiveCwd(state)
    const running = hasActiveProcess(userId, effectiveCwd) ? "Yes" : "No"
    const sessionCount = state.sessions.size
    const branch = effectiveCwd && effectiveCwd !== projectsDir ? getCurrentBranch(effectiveCwd) : null
    const branchLine = branch ? `\nBranch: ${branch}` : ""
    const queueLine = state.queue.length > 0 ? `\nQueued: ${state.queue.length}` : ""
    const wtLine = state.activeWorktree ? `\nWorktree: ${state.activeWorktree}` : ""
    const wtCountLine = state.worktrees.size > 0 ? `\nWorktrees: ${state.worktrees.size}` : ""

    await ctx.reply(`Project: ${project}${wtLine}\nRunning: ${running}\nSessions: ${sessionCount}${branchLine}${queueLine}${wtCountLine}`, { reply_markup: mainKeyboard })
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
        "/wt — manage git worktrees",
        "/branch — show current git branch",
        "/pr — list open pull requests",
        "/help — show this message",
        "",
        "Send any text or voice message to chat with Claude in the active project.",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: mainKeyboard },
    )
  })

  bot.command("branch", async (ctx) => {
    const state = getState(ctx.from!.id)
    if (!state.activeProject || state.activeProject === projectsDir) {
      await ctx.reply("No project selected or in general mode.", { reply_markup: mainKeyboard })
      return
    }

    const current = getCurrentBranch(state.activeProject)
    if (!current) {
      await ctx.reply("Not a git repository.", { reply_markup: mainKeyboard })
      return
    }

    const branches = listBranches(state.activeProject)
    const projectName = basename(state.activeProject)
    const others = (branches ?? []).filter((b) => b !== current)
    const visible = others.slice(0, 10)
    const collapsed = others.slice(10)
    const lines = [`<b>${escapeHtml(projectName)}</b>`, `Current: <code>${escapeHtml(current)}</code>`]
    if (visible.length > 0) {
      lines.push("", ...visible.map((b) => `<code>${escapeHtml(b)}</code>`))
    }
    if (collapsed.length > 0) {
      const collapsedLines = collapsed.map((b) => `<code>${escapeHtml(b)}</code>`).join("\n")
      lines.push(`\n<blockquote expandable>${collapsedLines}</blockquote>`)
    }
    // listBranches caps at 50; if we got exactly 50 others, there are likely more
    if (others.length >= 49) {
      lines.push(`<i>...showing most recent branches only</i>`)
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: mainKeyboard })
  })

  bot.command("pr", async (ctx) => {
    const state = getState(ctx.from!.id)
    if (!state.activeProject || state.activeProject === projectsDir) {
      await ctx.reply("No project selected or in general mode.", { reply_markup: mainKeyboard })
      return
    }

    const prs = listOpenPRs(state.activeProject)
    if (prs === null) {
      await ctx.reply("Could not fetch PRs. Is gh CLI authenticated?", { reply_markup: mainKeyboard })
      return
    }
    if (prs.length === 0) {
      await ctx.reply("No open PRs.", { reply_markup: mainKeyboard })
      return
    }

    const lines = prs.map((pr) => `#${pr.number} <a href="${escapeHtml(pr.url)}">${escapeHtml(pr.title)}</a> (<code>${escapeHtml(pr.headRefName)}</code>)`)
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: mainKeyboard })
  })

  const MAX_WORKTREES = 5
  const WORKTREES_BASE = join(projectsDir, ".worktrees")

  bot.command("wt", async (ctx) => {
    const userId = ctx.from!.id
    const state = getState(userId)
    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? []
    const sub = args[0]

    if (!state.activeProject || state.activeProject === projectsDir) {
      await ctx.reply("Worktrees require a git project.", { reply_markup: mainKeyboard })
      return
    }

    if (!sub) {
      // List worktrees
      if (state.worktrees.size === 0) {
        await ctx.reply("No active worktrees.\nUse /wt new [name] to create one.", { reply_markup: mainKeyboard })
        return
      }
      const keyboard = new InlineKeyboard()
      for (const [name, wt] of state.worktrees) {
        const active = state.activeWorktree === name ? " *" : ""
        keyboard.text(`${name} [${wt.branch}]${active}`, `wt_switch:${name}`)
          .text("Remove", `wt_rm:${name}`).row()
      }
      keyboard.text("Back to main", "wt_switch:__main__").row()
      await ctx.reply("Worktrees:", { reply_markup: keyboard })
      return
    }

    if (sub === "new") {
      const name = args[1] || `task-${Date.now()}`
      if (state.worktrees.size >= MAX_WORKTREES) {
        await ctx.reply(`Max ${MAX_WORKTREES} worktrees. Remove one first.`, { reply_markup: mainKeyboard })
        return
      }
      const worktreePath = join(WORKTREES_BASE, basename(state.activeProject), name)
      const branchName = `wt/${name}`
      try {
        createWorktree(state.activeProject, worktreePath, branchName)
      } catch (e) {
        await ctx.reply(`Failed to create worktree: ${e instanceof Error ? e.message : "unknown error"}`, { reply_markup: mainKeyboard })
        return
      }
      state.worktrees.set(name, { path: worktreePath, branch: branchName, projectPath: state.activeProject })
      state.activeWorktree = name
      await ctx.reply(`Worktree <b>${escapeHtml(name)}</b> created on branch <code>${escapeHtml(branchName)}</code>`, { parse_mode: "HTML", reply_markup: mainKeyboard })
      return
    }

    if (sub === "rm") {
      const name = args[1]
      if (!name) {
        await ctx.reply("Usage: /wt rm <name>", { reply_markup: mainKeyboard })
        return
      }
      const wt = state.worktrees.get(name)
      if (!wt) {
        await ctx.reply(`Worktree "${name}" not found.`, { reply_markup: mainKeyboard })
        return
      }
      stopClaude(userId, wt.path)
      state.queue = state.queue.filter((q) => q.targetCwd !== wt.path)
      try { removeWorktree(wt.projectPath, wt.path) } catch {}
      state.worktrees.delete(name)
      if (state.activeWorktree === name) state.activeWorktree = undefined
      state.sessions.delete(wt.path)
      await ctx.reply(`Worktree "${name}" removed.`, { reply_markup: mainKeyboard })
      return
    }

    if (sub === "switch") {
      const name = args[1]
      if (!name) {
        await ctx.reply("Usage: /wt switch <name>", { reply_markup: mainKeyboard })
        return
      }
      if (name === "main") {
        state.activeWorktree = undefined
        await ctx.reply("Switched back to main project directory.", { reply_markup: mainKeyboard })
        return
      }
      const wt = state.worktrees.get(name)
      if (!wt) {
        await ctx.reply(`Worktree "${name}" not found.`, { reply_markup: mainKeyboard })
        return
      }
      state.activeWorktree = name
      await ctx.reply(`Switched to worktree <b>${escapeHtml(name)}</b> [<code>${escapeHtml(wt.branch)}</code>]`, { parse_mode: "HTML", reply_markup: mainKeyboard })
      return
    }

    await ctx.reply("Usage: /wt [new|rm|switch] [name]", { reply_markup: mainKeyboard })
  })

  bot.callbackQuery(/^wt_switch:(.+)$/, async (ctx) => {
    const name = ctx.match![1]
    const state = getState(ctx.from.id)
    if (name === "__main__") {
      state.activeWorktree = undefined
      await ctx.answerCallbackQuery({ text: "Switched to main" })
      await ctx.editMessageText("Switched back to main project directory.")
      return
    }
    const wt = state.worktrees.get(name)
    if (!wt) {
      await ctx.answerCallbackQuery({ text: "Worktree not found" })
      return
    }
    state.activeWorktree = name
    await ctx.answerCallbackQuery({ text: `Switched to ${name}` })
    await ctx.editMessageText(`Active worktree: ${name} [${wt.branch}]`)
  })

  bot.callbackQuery(/^wt_rm:(.+)$/, async (ctx) => {
    const name = ctx.match![1]
    const userId = ctx.from.id
    const state = getState(userId)
    const wt = state.worktrees.get(name)
    if (!wt) {
      await ctx.answerCallbackQuery({ text: "Worktree not found" })
      return
    }
    stopClaude(userId, wt.path)
    state.queue = state.queue.filter((q) => q.targetCwd !== wt.path)
    try { removeWorktree(wt.projectPath, wt.path) } catch {}
    state.worktrees.delete(name)
    if (state.activeWorktree === name) state.activeWorktree = undefined
    state.sessions.delete(wt.path)
    await ctx.answerCallbackQuery({ text: `Removed ${name}` })
    await ctx.editMessageText(`Worktree "${name}" removed.`)
  })

  bot.command("new", async (ctx) => {
    const state = getState(ctx.from!.id)
    if (!state.activeProject) {
      state.activeProject = projectsDir
    }
    const effectiveCwd = getEffectiveCwd(state)
    state.sessions.delete(effectiveCwd)
    state.queue = []
    state.pendingPlan = undefined
    await cleanupQueueStatus(state, ctx)
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
    await ctx.api.unpinAllChatMessages(chatId).catch(() => {})
    const pinnedId = typeof msg === "object" && "message_id" in msg ? msg.message_id : undefined
    if (pinnedId) {
      await ctx.api.pinChatMessage(chatId, pinnedId, { disable_notification: true }).catch(() => {})
    }
  })

  bot.callbackQuery(/^force_send:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id
    const stopped = stopClaude(userId)
    await ctx.answerCallbackQuery({
      text: stopped ? "Stopping current task..." : "No active process",
    })
  })

  bot.callbackQuery(/^clear_queue:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id
    const state = getState(userId)
    const count = state.queue.length
    state.queue = []
    await cleanupQueueStatus(state, ctx)
    await ctx.answerCallbackQuery({ text: count > 0 ? `Cleared ${count} queued message(s).` : "Queue is empty." })
  })

  /** Read plan file and send to user with action buttons */
  async function presentPlan(ctx: Context, userId: number, state: UserState, result: { planPath?: string; sessionId?: string }) {
    const planPath = result.planPath!
    let planContent: string
    try {
      planContent = readFileSync(planPath, "utf-8")
    } catch {
      await ctx.reply("Could not read plan file.", { reply_markup: mainKeyboard })
      return
    }

    state.pendingPlan = {
      planPath,
      sessionId: result.sessionId,
      projectPath: getEffectiveCwd(state),
    }

    const maxLen = 4000
    const display = planContent.length > maxLen
      ? planContent.slice(0, maxLen) + "\n... (truncated)"
      : planContent

    await ctx.api.sendMessage(ctx.chat!.id, display)

    const keyboard = new InlineKeyboard()
      .text("Execute (new session)", `plan_new:${userId}`).row()
      .text("Execute (keep context)", `plan_resume:${userId}`).row()
      .text("Modify plan", `plan_modify:${userId}`)

    await ctx.api.sendMessage(ctx.chat!.id, "Plan ready. How would you like to proceed?", { reply_markup: keyboard })
  }

  bot.callbackQuery(/^plan_new:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id
    const state = getState(userId)
    const plan = state.pendingPlan
    if (!plan) {
      await ctx.answerCallbackQuery({ text: "No pending plan" })
      return
    }

    let planContent: string
    try {
      planContent = readFileSync(plan.planPath, "utf-8")
    } catch {
      await ctx.answerCallbackQuery({ text: "Could not read plan file" })
      state.pendingPlan = undefined
      return
    }

    state.sessions.delete(plan.projectPath)
    state.pendingPlan = undefined
    await ctx.answerCallbackQuery({ text: "Executing plan (new session)..." })
    await ctx.editMessageText("Executing plan (new session)...")

    const prompt = `Execute the following plan. Do not re-enter plan mode.\n\n${planContent}`
    runAndDrain(ctx, prompt, state, userId, plan.projectPath).catch((e) => console.error("plan_new error:", e))
  })

  bot.callbackQuery(/^plan_resume:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id
    const state = getState(userId)
    const plan = state.pendingPlan
    if (!plan) {
      await ctx.answerCallbackQuery({ text: "No pending plan" })
      return
    }

    if (plan.sessionId) {
      state.sessions.set(plan.projectPath, plan.sessionId)
    }
    state.pendingPlan = undefined
    await ctx.answerCallbackQuery({ text: "Executing plan (keeping context)..." })
    await ctx.editMessageText("Executing plan (keeping context)...")

    const prompt = "The plan has been approved. Proceed with execution. Do not re-enter plan mode."
    runAndDrain(ctx, prompt, state, userId, plan.projectPath).catch((e) => console.error("plan_resume error:", e))
  })

  bot.callbackQuery(/^plan_modify:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id
    const state = getState(userId)
    if (!state.pendingPlan) {
      await ctx.answerCallbackQuery({ text: "No pending plan" })
      return
    }
    const cancelKeyboard = new InlineKeyboard()
      .text("Cancel", `plan_cancel:${userId}`)
    await ctx.answerCallbackQuery({ text: "Send your feedback" })
    await ctx.editMessageText("Send your feedback. Next message will continue the conversation with plan context.", { reply_markup: cancelKeyboard })
  })

  bot.callbackQuery(/^plan_cancel:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id
    const state = getState(userId)
    if (!state.pendingPlan) {
      await ctx.answerCallbackQuery({ text: "No pending plan" })
      return
    }
    const keyboard = new InlineKeyboard()
      .text("Execute (new session)", `plan_new:${userId}`).row()
      .text("Execute (keep context)", `plan_resume:${userId}`).row()
      .text("Modify plan", `plan_modify:${userId}`)
    await ctx.answerCallbackQuery()
    await ctx.editMessageText("Plan ready. How would you like to proceed?", { reply_markup: keyboard })
  })

  /** Send a prompt to Claude and stream the response */
  async function handlePrompt(ctx: Context, prompt: string) {
    const state = getState(ctx.from!.id)

    if (!state.activeProject) {
      state.activeProject = projectsDir
      await ctx.reply("No project selected. Using General (all projects).", { reply_markup: mainKeyboard })
    }

    const userId = ctx.from!.id
    const effectiveCwd = getEffectiveCwd(state)

    if (state.pendingPlan) {
      const plan = state.pendingPlan
      if (plan.sessionId) {
        state.sessions.set(plan.projectPath, plan.sessionId)
      }
      state.pendingPlan = undefined
      const feedbackPrompt = `Plan feedback from user: ${prompt}\n\nRevise the plan based on this feedback. Do not execute yet — present the updated plan.`
      await runAndDrain(ctx, feedbackPrompt, state, userId, plan.projectPath)
      return
    }

    if (hasActiveProcess(userId, effectiveCwd)) {
      state.queue.push({ prompt, ctx, targetCwd: effectiveCwd })
      await sendOrUpdateQueueStatus(ctx, state)
      return
    }

    await runAndDrain(ctx, prompt, state, userId, effectiveCwd)
  }

  /** Run a Claude prompt and drain any queued messages afterward */
  async function runAndDrain(ctx: Context, prompt: string, state: UserState, userId: number, effectiveCwd?: string) {
    let currentCtx = ctx
    let currentPrompt = prompt
    let cwd = effectiveCwd ?? getEffectiveCwd(state)
    while (true) {
      const sessionId = state.sessions.get(cwd)
      const wtEntry = [...state.worktrees.values()].find((w) => w.path === cwd)
      const projectName = wtEntry
        ? `${basename(wtEntry.projectPath)}/${basename(cwd)}`
        : cwd === projectsDir ? "general" : basename(cwd)
      const branchName = cwd !== projectsDir ? getCurrentBranch(cwd) : null
      try {
        const events = runClaude(userId, currentPrompt, cwd, currentCtx.chat!.id, sessionId)
        const result = await streamToTelegram(currentCtx, events, projectName, { branchName })
        if (result.sessionId) {
          state.sessions.set(cwd, result.sessionId)
        }
        if (result.planPath) {
          stopClaude(userId, cwd)
          await presentPlan(currentCtx, userId, state, result)
          return
        }
      } catch (e) {
        console.error("runAndDrain error:", e)
      }
      const idx = state.queue.findIndex((q) => q.targetCwd === cwd)
      if (idx === -1) break
      const next = state.queue.splice(idx, 1)[0]
      currentPrompt = next.prompt
      currentCtx = next.ctx
      if (state.queue.length === 0) await cleanupQueueStatus(state, currentCtx)
      const remaining = state.queue.filter((q) => q.targetCwd === cwd).length
      const queueInfo = remaining > 0 ? ` | ${remaining} more in queue` : ""
      const preview = currentPrompt.length > 200 ? currentPrompt.slice(0, 200) + "..." : currentPrompt
      await currentCtx.reply(`<b>▶ Processing queued message</b>${queueInfo}\n<pre>${escapeHtml(preview)}</pre>`, { parse_mode: "HTML" }).catch(() => {})
    }
  }

  /** Send or update the "Message queued" status message with Force Send button */
  async function sendOrUpdateQueueStatus(ctx: Context, state: UserState) {
    const text = `Message queued (${state.queue.length} in queue)`
    const keyboard = new InlineKeyboard()
      .text("Force Send — stops current task", `force_send:${ctx.from!.id}`).row()
      .text("Clear Queue", `clear_queue:${ctx.from!.id}`)
    if (state.queueStatusMessageId) {
      await ctx.api.editMessageText(ctx.chat!.id, state.queueStatusMessageId, text, { reply_markup: keyboard }).catch(() => {})
    } else {
      const msg = await ctx.reply(text, { reply_markup: keyboard })
      state.queueStatusMessageId = msg.message_id
    }
  }

  /** Delete the queue status message if it exists */
  async function cleanupQueueStatus(state: UserState, ctx: Context) {
    if (state.queueStatusMessageId) {
      await ctx.api.deleteMessage(ctx.chat!.id, state.queueStatusMessageId).catch(() => {})
      state.queueStatusMessageId = undefined
    }
  }

  bot.on("message:text", (ctx) => {
    const prompt = buildPromptWithReplyContext(ctx, ctx.message.text, botId)
    handlePrompt(ctx, prompt).catch((e) => console.error("handlePrompt error:", e))
  })

  bot.on("message:voice", async (ctx) => {
    const state = getState(ctx.from!.id)

    if (!state.activeProject) {
      state.activeProject = projectsDir
      await ctx.reply("No project selected. Using General (all projects).", { reply_markup: mainKeyboard })
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

    const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId)
    handlePrompt(ctx, fullPrompt).catch((e) => console.error("handlePrompt error:", e))
  })

  /** Download a Telegram file and save to project's user-sent-files dir */
  async function saveUploadedFile(ctx: Context, filename: string, fileId?: string) {
    const state = getState(ctx.from!.id)
    if (!state.activeProject) {
      state.activeProject = projectsDir
      await ctx.reply("No project selected. Using General (all projects).", { reply_markup: mainKeyboard })
    }

    const file = fileId ? await ctx.api.getFile(fileId) : await ctx.getFile()
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    const res = await fetch(url)
    const buffer = Buffer.from(await res.arrayBuffer())

    const dir = join(getEffectiveCwd(state), "user-sent-files")
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, basename(filename))
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
      const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId)
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
      const dest = await saveUploadedFile(ctx, filename, largest.file_id)
      if (!dest) return

      const caption = ctx.message.caption ?? "See the attached photo."
      const prompt = `${caption}\n\n[Photo saved at ${dest}]`
      const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId)
      handlePrompt(ctx, fullPrompt).catch((e) => console.error("handlePrompt error:", e))
    } catch (e) {
      console.error("Photo upload error:", e)
      await ctx.reply(`Photo upload failed: ${e instanceof Error ? e.message : "unknown error"}`)
    }
  })

  return bot
}
