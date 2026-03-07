import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { Bot, type Context, InlineKeyboard, Keyboard } from "grammy";
import {
  getActiveProcessKeys,
  hasActiveProcess,
  runClaude,
  stopClaude,
} from "./claude";
import {
  getCurrentBranch,
  getGitHubUrl,
  listBranches,
  listOpenPRs,
} from "./git";
import {
  clearSessionCache,
  getSessionProject,
  listAllSessions,
} from "./history";
import {
  loadPersistedState,
  setActiveProject,
  setStateForumMode,
  updateSession,
} from "./state";
import { splitText, streamToTelegram } from "./telegram";
import { ensureTopic, getProjectForThread } from "./topics";
import { transcribeAudio } from "./transcribe";

interface QueuedMessage {
  ctx: Context;
  prompt: string;
}

interface ComposeMessage {
  content: string;
  type: "text" | "voice" | "forwarded" | "file" | "photo";
}

interface PendingPlan {
  planPath: string;
  projectPath: string;
  sessionId?: string;
}

interface UserState {
  activeProject: string;
  composeMessages?: ComposeMessage[];
  composeStatusMessageId?: number;
  key: number;
  pendingPlan?: PendingPlan;
  queue: QueuedMessage[];
  queueStatusMessageId?: number;
  sessions: Map<string, string>;
}

const userStates = new Map<number, UserState>();
const HISTORY_PAGE_SIZE = 5;
const MAX_COMPOSE_MESSAGES = 50;
const MEDIA_GROUP_DEBOUNCE_MS = 500;

interface MediaGroupEntry {
  caption: string;
  ctx: Context;
  photos: { fileId: string; filename: string }[];
  timer: ReturnType<typeof setTimeout>;
}

/** Pending media groups keyed by media_group_id */
const mediaGroupBuffers = new Map<string, MediaGroupEntry>();

/** Escape HTML special characters for Telegram */
function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Persistent reply keyboard with all commands */
const mainKeyboard = new Keyboard()
  .text("Projects")
  .text("History")
  .row()
  .text("Stop")
  .text("New")
  .row()
  .text("Compose")
  .row()
  .resized()
  .persistent();

/** Extract reply-to-message text and prepend it as context (skip bot's own messages) */
function buildPromptWithReplyContext(
  ctx: Context,
  userText: string,
  botId?: number
) {
  const replyText = ctx.message?.reply_to_message?.text;
  if (!replyText) {
    return userText;
  }
  if (botId && ctx.message?.reply_to_message?.from?.id === botId) {
    return userText;
  }
  const truncated =
    replyText.length > 2000 ? `${replyText.slice(0, 2000)}...` : replyText;
  return `[Replying to: ${truncated}]\n\n${userText}`;
}

/** Extract user ID from context (safe after access-control middleware) */
function getUserId(ctx: Context) {
  if (!ctx.from) {
    throw new Error("No user context");
  }
  return ctx.from.id;
}

let _forumMode = false;

/** Set forum mode flag (called from createBot) */
function setForumMode(enabled: boolean) {
  _forumMode = enabled;
}

/** Get the state key: threadId in forum mode, userId in private mode */
function getStateKey(ctx: Context) {
  if (_forumMode) {
    return (
      ctx.message?.message_thread_id ??
      ctx.callbackQuery?.message?.message_thread_id ??
      0
    );
  }
  return getUserId(ctx);
}

/** Get thread ID for routing replies in forum mode */
function getThreadId(ctx: Context): number | undefined {
  if (!_forumMode) {
    return undefined;
  }
  return (
    ctx.message?.message_thread_id ??
    ctx.callbackQuery?.message?.message_thread_id ??
    undefined
  );
}

/** Reply with thread-awareness: adds message_thread_id in forum mode */
function replyToCtx(
  ctx: Context,
  text: string,
  other?: Record<string, unknown>
) {
  const threadId = getThreadId(ctx);
  const threadOpts = threadId ? { message_thread_id: threadId } : {};
  return ctx.reply(text, { ...other, ...threadOpts });
}

/** Get or create user state */
function getState(id: number): UserState {
  let state = userStates.get(id);
  if (!state) {
    const persisted = loadPersistedState(id);
    state = {
      activeProject: persisted?.activeProject ?? "",
      key: id,
      sessions: persisted?.sessions ?? new Map(),
      queue: [],
    };
    userStates.set(id, state);
  }
  return state;
}

/** List project directories */
function listProjects(projectsDir: string) {
  try {
    return readdirSync(projectsDir)
      .filter((name) => {
        try {
          return statSync(join(projectsDir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** Clears stale compose state and logs memory usage */
export function cleanupStaleState() {
  for (const [, state] of userStates) {
    if (state.composeMessages && state.queue.length === 0) {
      state.composeMessages = undefined;
      state.composeStatusMessageId = undefined;
    }
  }
  clearSessionCache();
  const mem = process.memoryUsage();
  console.log(
    `[cleanup] rss=${(mem.rss / 1024 / 1024).toFixed(1)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`
  );
}

/** Create and configure the bot */
export function createBot(
  token: string,
  allowedUserId: number,
  chatId: number,
  forumMode: boolean,
  projectsDir: string
) {
  const bot = new Bot(token);
  setForumMode(forumMode);
  setStateForumMode(forumMode);

  bot.command("chatid", async (ctx) => {
    await replyToCtx(ctx, `Chat ID: <code>${ctx.chat.id}</code>`, {
      parse_mode: "HTML",
    });
  });

  // Access control middleware
  const botId = Number.parseInt(token.split(":")[0], 10);
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.id === botId) {
      return;
    }
    if (ctx.from.id !== allowedUserId) {
      console.log(
        `Auth rejected: from=${ctx.from.id} allowed=${allowedUserId}`
      );
      await replyToCtx(ctx, "Telegram User is Unauthorized.");
      return;
    }
    await next();
  });

  const buttonToCommand: Record<string, string> = {
    Projects: "/projects",
    History: "/history",
    Stop: "/stop",
    New: "/new",
    Compose: "/compose",
  };
  bot.use((ctx, next) => {
    const text = ctx.message?.text;
    if (text && text in buttonToCommand) {
      const cmd = buttonToCommand[text];
      ctx.message!.text = cmd;
      ctx.message!.entities = [
        { type: "bot_command", offset: 0, length: cmd.length },
      ];
    }
    return next();
  });

  // Compose mode interceptor: capture non-command messages when composing
  // Media group photos pass through to the photo handler for batching
  bot.on("message", async (ctx, next) => {
    const state = getState(getStateKey(ctx));
    if (!state.composeMessages) {
      return next();
    }
    if (ctx.message?.text?.startsWith("/")) {
      return next();
    }
    if (ctx.message?.photo && ctx.message.media_group_id) {
      return next();
    }
    await collectComposeMessage(ctx, state);
  });

  bot.command("start", async (ctx) => {
    const state = getState(getStateKey(ctx));
    const project = state.activeProject || "(none)";
    await replyToCtx(
      ctx,
      `Claude Code bot ready.\nActive project: ${project}\n\nCommands:\n/projects - switch project\n/history - resume a past session\n/stop - kill active process\n/status - current state\n/new - reset session`,
      { reply_markup: mainKeyboard }
    );
  });

  bot.command("projects", async (ctx) => {
    const projects = listProjects(projectsDir);
    if (projects.length === 0) {
      await replyToCtx(ctx, `No projects found in ${projectsDir}`, {
        reply_markup: mainKeyboard,
      });
      return;
    }

    const keyboard = new InlineKeyboard();
    keyboard.text("General (all projects)", "project:__general__").row();
    for (const name of projects) {
      keyboard.text(name, `project:${name}`).row();
    }
    await replyToCtx(ctx, "Select a project:", { reply_markup: keyboard });
  });

  bot.callbackQuery(/^project:(.+)$/, async (ctx) => {
    const name = ctx.match?.[1];
    const isGeneral = name === "__general__";
    const fullPath = isGeneral ? projectsDir : join(projectsDir, name);
    const displayName = isGeneral ? "general (all projects)" : name;

    if (!isGeneral) {
      try {
        statSync(fullPath);
      } catch {
        await ctx.answerCallbackQuery({ text: "Project not found" });
        return;
      }
    }

    if (forumMode && !isGeneral) {
      const threadId = await ensureTopic(ctx.api, chatId, fullPath);
      const topicState = getState(threadId);
      setActiveProject(topicState, fullPath);
      await ctx.answerCallbackQuery({
        text: `Topic created for ${displayName}`,
      });
      await ctx.editMessageText(
        `Project <b>${escapeHtml(displayName)}</b> — send messages in its topic.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const stateKey = getStateKey(ctx);
    const state = getState(stateKey);
    setActiveProject(state, fullPath);
    state.queue = [];
    state.pendingPlan = undefined;
    state.composeMessages = undefined;
    await cleanupQueueStatus(state, ctx);
    await cleanupComposeStatus(state, ctx);
    await ctx.answerCallbackQuery({ text: `Switched to ${displayName}` });
    const ghUrl = isGeneral ? null : getGitHubUrl(fullPath);
    const projectLabel = ghUrl
      ? `<a href="${escapeHtml(ghUrl)}">${escapeHtml(displayName)}</a>`
      : escapeHtml(displayName);
    const branch = isGeneral ? null : getCurrentBranch(fullPath);
    const branchSuffix = branch ? ` [${escapeHtml(branch)}]` : "";
    const editedMsg = await ctx.editMessageText(
      `Active project: ${projectLabel}${branchSuffix}`,
      { parse_mode: "HTML" }
    );
    if (!forumMode) {
      const msgChatId = ctx.chat!.id;
      await ctx.api.unpinAllChatMessages(msgChatId).catch(() => {});
      const pinnedId =
        typeof editedMsg === "object" && "message_id" in editedMsg
          ? editedMsg.message_id
          : undefined;
      if (pinnedId) {
        await ctx.api
          .pinChatMessage(msgChatId, pinnedId, { disable_notification: true })
          .catch(() => {});
      }
    }
  });

  bot.command("stop", async (ctx) => {
    if (forumMode && !getThreadId(ctx)) {
      const activeKeys = getActiveProcessKeys();
      if (activeKeys.length === 0) {
        await replyToCtx(ctx, "No active processes.", {
          reply_markup: mainKeyboard,
        });
        return;
      }
      const keyboard = new InlineKeyboard();
      for (const key of activeKeys) {
        const projectPath = getProjectForThread(key);
        const name = projectPath ? basename(projectPath) : `thread:${key}`;
        keyboard.text(`Stop: ${name}`, `force_send:${key}`).row();
      }
      await replyToCtx(ctx, "Active processes:", {
        reply_markup: keyboard,
      });
      return;
    }

    const stateKey = getStateKey(ctx);
    const state = getState(stateKey);
    const stopped = stopClaude(stateKey);
    const hadQueue = state.queue.length > 0;
    state.queue = [];
    state.pendingPlan = undefined;
    state.composeMessages = undefined;
    await cleanupQueueStatus(state, ctx);
    await cleanupComposeStatus(state, ctx);
    const msg = stopped
      ? `Process stopped.${hadQueue ? " Queue cleared." : ""}`
      : "No active process.";
    await replyToCtx(ctx, msg, { reply_markup: mainKeyboard });
  });

  bot.command("status", async (ctx) => {
    if (forumMode && !getThreadId(ctx)) {
      const activeKeys = getActiveProcessKeys();
      if (activeKeys.length === 0) {
        await replyToCtx(ctx, "No active processes.", {
          reply_markup: mainKeyboard,
        });
        return;
      }
      const lines = activeKeys.map((key) => {
        const projectPath = getProjectForThread(key);
        const name = projectPath ? basename(projectPath) : `thread:${key}`;
        return `- ${name}: running`;
      });
      await replyToCtx(ctx, `<b>Active processes:</b>\n${lines.join("\n")}`, {
        parse_mode: "HTML",
        reply_markup: mainKeyboard,
      });
      return;
    }

    const stateKey = getStateKey(ctx);
    const state = getState(stateKey);
    const project = state.activeProject
      ? state.activeProject === projectsDir
        ? "general"
        : basename(state.activeProject)
      : "(none)";
    const running = hasActiveProcess(stateKey) ? "Yes" : "No";
    const sessionCount = state.sessions.size;
    const branch =
      state.activeProject && state.activeProject !== projectsDir
        ? getCurrentBranch(state.activeProject)
        : null;
    const branchLine = branch ? `\nBranch: ${branch}` : "";
    const queueLine =
      state.queue.length > 0 ? `\nQueued: ${state.queue.length}` : "";
    const composeLine = state.composeMessages
      ? `\nComposing: ${state.composeMessages.length} messages`
      : "";

    await replyToCtx(
      ctx,
      `Project: ${project}\nRunning: ${running}\nSessions: ${sessionCount}${branchLine}${queueLine}${composeLine}`,
      { reply_markup: mainKeyboard }
    );
  });

  bot.command("help", async (ctx) => {
    await replyToCtx(
      ctx,
      [
        "<b>Commands:</b>",
        "/projects — switch active project",
        "/history — resume a past session",
        "/new — start fresh conversation",
        "/stop — kill active process",
        "/status — show current state",
        "/branch — show current git branch",
        "/pr — list open pull requests",
        "/compose — start collecting messages",
        "/send — send composed messages",
        "/cancel — cancel compose mode",
        "/help — show this message",
        "",
        "Send any text or voice message to chat with Claude in the active project.",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: mainKeyboard }
    );
  });

  bot.command("branch", async (ctx) => {
    const state = getState(getStateKey(ctx));
    if (!state.activeProject || state.activeProject === projectsDir) {
      await replyToCtx(ctx, "No project selected or in general mode.", {
        reply_markup: mainKeyboard,
      });
      return;
    }

    const current = getCurrentBranch(state.activeProject);
    if (!current) {
      await replyToCtx(ctx, "Not a git repository.", {
        reply_markup: mainKeyboard,
      });
      return;
    }

    const branches = listBranches(state.activeProject);
    const projectName = basename(state.activeProject);
    const others = (branches ?? []).filter((b) => b !== current);
    const visible = others.slice(0, 10);
    const collapsed = others.slice(10);
    const lines = [
      `<b>${escapeHtml(projectName)}</b>`,
      `Current: <code>${escapeHtml(current)}</code>`,
    ];
    if (visible.length > 0) {
      lines.push("", ...visible.map((b) => `<code>${escapeHtml(b)}</code>`));
    }
    if (collapsed.length > 0) {
      const collapsedLines = collapsed
        .map((b) => `<code>${escapeHtml(b)}</code>`)
        .join("\n");
      lines.push(`\n<blockquote expandable>${collapsedLines}</blockquote>`);
    }
    // listBranches caps at 50; if we got exactly 50 others, there are likely more
    if (others.length >= 49) {
      lines.push("<i>...showing most recent branches only</i>");
    }
    await replyToCtx(ctx, lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: mainKeyboard,
    });
  });

  bot.command("pr", async (ctx) => {
    const state = getState(getStateKey(ctx));
    if (!state.activeProject || state.activeProject === projectsDir) {
      await replyToCtx(ctx, "No project selected or in general mode.", {
        reply_markup: mainKeyboard,
      });
      return;
    }

    const prs = listOpenPRs(state.activeProject);
    if (prs === null) {
      await replyToCtx(ctx, "Could not fetch PRs. Is gh CLI authenticated?", {
        reply_markup: mainKeyboard,
      });
      return;
    }
    if (prs.length === 0) {
      await replyToCtx(ctx, "No open PRs.", { reply_markup: mainKeyboard });
      return;
    }

    const lines = prs.map(
      (pr) =>
        `#${pr.number} <a href="${escapeHtml(pr.url)}">${escapeHtml(pr.title)}</a> (<code>${escapeHtml(pr.headRefName)}</code>)`
    );
    await replyToCtx(ctx, lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: mainKeyboard,
    });
  });

  bot.command("new", async (ctx) => {
    const state = getState(getStateKey(ctx));
    if (!state.activeProject) {
      setActiveProject(state, projectsDir);
    }
    updateSession(state, state.activeProject);
    state.queue = [];
    state.pendingPlan = undefined;
    state.composeMessages = undefined;
    await cleanupQueueStatus(state, ctx);
    await cleanupComposeStatus(state, ctx);
    await replyToCtx(
      ctx,
      "Session cleared. Next message starts a fresh conversation.",
      { reply_markup: mainKeyboard }
    );
  });

  bot.command("compose", async (ctx) => {
    const stateKey = getStateKey(ctx);
    const state = getState(stateKey);
    if (state.composeMessages) {
      await replyToCtx(
        ctx,
        `Already composing (${state.composeMessages.length} messages). /send when done.`
      );
      return;
    }
    state.composeMessages = [];
    const keyboard = new InlineKeyboard()
      .text("Send", `compose_send:${stateKey}`)
      .text("Cancel", `compose_cancel:${stateKey}`);
    const msg = await replyToCtx(
      ctx,
      "Compose mode. Send messages — /send when done.",
      { reply_markup: keyboard }
    );
    state.composeStatusMessageId = msg.message_id;
  });

  /** Execute send: combine composed messages and send to Claude */
  async function executeSend(ctx: Context, state: UserState) {
    if (!state.composeMessages) {
      await replyToCtx(ctx, "Not in compose mode.", {
        reply_markup: mainKeyboard,
      });
      return;
    }
    if (state.composeMessages.length === 0) {
      state.composeMessages = undefined;
      await cleanupComposeStatus(state, ctx);
      await replyToCtx(ctx, "Nothing to send. Compose cancelled.", {
        reply_markup: mainKeyboard,
      });
      return;
    }
    const combined = state.composeMessages.map((m) => m.content).join("\n\n");
    state.composeMessages = undefined;
    await cleanupComposeStatus(state, ctx);
    handlePrompt(ctx, combined).catch((e) =>
      console.error("handlePrompt error:", e)
    );
  }

  /** Execute cancel: discard composed messages */
  async function executeCancel(ctx: Context, state: UserState) {
    if (!state.composeMessages) {
      await replyToCtx(ctx, "Not in compose mode.", {
        reply_markup: mainKeyboard,
      });
      return;
    }
    const count = state.composeMessages.length;
    state.composeMessages = undefined;
    await cleanupComposeStatus(state, ctx);
    await replyToCtx(ctx, `Compose cancelled. ${count} message(s) discarded.`, {
      reply_markup: mainKeyboard,
    });
  }

  bot.command("send", async (ctx) => {
    const state = getState(getStateKey(ctx));
    await executeSend(ctx, state);
  });

  bot.command("cancel", async (ctx) => {
    const state = getState(getStateKey(ctx));
    await executeCancel(ctx, state);
  });

  bot.callbackQuery(/^compose_send:(.+)$/, async (ctx) => {
    const state = getState(getStateKey(ctx));
    await ctx.answerCallbackQuery();
    await executeSend(ctx, state);
  });

  bot.callbackQuery(/^compose_cancel:(.+)$/, async (ctx) => {
    const state = getState(getStateKey(ctx));
    await ctx.answerCallbackQuery();
    await executeCancel(ctx, state);
  });

  /** Build paginated history message with inline keyboard */
  function buildHistoryMessage(page: number) {
    const sessions = listAllSessions();

    if (sessions.length === 0) {
      return null;
    }

    const totalPages = Math.ceil(sessions.length / HISTORY_PAGE_SIZE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const pageSlice = sessions.slice(
      safePage * HISTORY_PAGE_SIZE,
      (safePage + 1) * HISTORY_PAGE_SIZE
    );

    const keyboard = new InlineKeyboard();
    for (const s of pageSlice) {
      const date = new Date(s.lastActiveAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const label = `${date} — [${s.projectName}] ${s.summary.slice(0, 30)}`;
      keyboard.text(label, `session:${s.sessionId}`).row();
    }

    const navRow: { text: string; data: string }[] = [];
    if (safePage > 0) {
      navRow.push({ text: "<< Prev", data: `history:${safePage - 1}` });
    }
    if (safePage < totalPages - 1) {
      navRow.push({ text: "Next >>", data: `history:${safePage + 1}` });
    }
    if (navRow.length > 0) {
      for (const btn of navRow) {
        keyboard.text(btn.text, btn.data);
      }
      keyboard.row();
    }

    const pageIndicator =
      totalPages > 1 ? ` (${safePage + 1}/${totalPages})` : "";
    return { text: `All sessions${pageIndicator}:`, keyboard };
  }

  bot.command("history", async (ctx) => {
    const result = buildHistoryMessage(0);

    if (!result) {
      await replyToCtx(ctx, "No session history found.", {
        reply_markup: mainKeyboard,
      });
      return;
    }

    await replyToCtx(ctx, result.text, {
      reply_markup: result.keyboard,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(/^history:(\d+)$/, async (ctx) => {
    const page = Number.parseInt(ctx.match?.[1], 10);
    const result = buildHistoryMessage(page);

    if (!result) {
      await ctx.answerCallbackQuery({ text: "No sessions found" });
      return;
    }

    await ctx.editMessageText(result.text, {
      reply_markup: result.keyboard,
      parse_mode: "HTML",
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^session:(.+)$/, async (ctx) => {
    const sessionId = ctx.match?.[1];
    const state = getState(getStateKey(ctx));

    const cachedProject = getSessionProject(sessionId);
    if (cachedProject) {
      setActiveProject(state, cachedProject);
    }

    if (!state.activeProject) {
      await ctx.answerCallbackQuery({ text: "No project selected" });
      return;
    }

    updateSession(state, state.activeProject, sessionId);
    const projectName = basename(state.activeProject);
    await ctx.answerCallbackQuery({ text: "Session resumed" });
    await ctx.editMessageText(
      `Resumed session in <b>${escapeHtml(projectName)}</b>. Next message continues this conversation.`,
      { parse_mode: "HTML" }
    );
    if (!forumMode) {
      const msgChatId = ctx.chat!.id;
      await ctx.api.unpinAllChatMessages(msgChatId).catch(() => {});
    }
  });

  bot.callbackQuery(/^force_send:(.+)$/, async (ctx) => {
    const stateKey = getStateKey(ctx);
    const stopped = stopClaude(stateKey);
    await ctx.answerCallbackQuery({
      text: stopped ? "Stopping current task..." : "No active process",
    });
  });

  bot.callbackQuery(/^clear_queue:(.+)$/, async (ctx) => {
    const stateKey = getStateKey(ctx);
    const state = getState(stateKey);
    const count = state.queue.length;
    state.queue = [];
    await cleanupQueueStatus(state, ctx);
    await ctx.answerCallbackQuery({
      text:
        count > 0 ? `Cleared ${count} queued message(s).` : "Queue is empty.",
    });
  });

  /** Read plan file and send to user with action buttons */
  async function presentPlan(
    ctx: Context,
    stateKey: number,
    state: UserState,
    result: { planPath?: string; sessionId?: string }
  ) {
    const planPath = result.planPath!;
    let planContent: string;
    try {
      planContent = readFileSync(planPath, "utf-8");
    } catch {
      await replyToCtx(ctx, "Could not read plan file.", {
        reply_markup: mainKeyboard,
      });
      return;
    }

    state.pendingPlan = {
      planPath,
      sessionId: result.sessionId,
      projectPath: state.activeProject,
    };

    const threadId = getThreadId(ctx);
    const threadOpts = threadId ? { message_thread_id: threadId } : {};
    const chunks = splitText(planContent);
    for (const chunk of chunks) {
      await ctx.api.sendMessage(ctx.chat!.id, chunk, threadOpts);
    }

    const keyboard = new InlineKeyboard()
      .text("Execute (new session)", `plan_new:${stateKey}`)
      .row()
      .text("Execute (keep context)", `plan_resume:${stateKey}`)
      .row()
      .text("Modify plan", `plan_modify:${stateKey}`);

    await ctx.api.sendMessage(
      ctx.chat!.id,
      "Plan ready. How would you like to proceed?",
      { reply_markup: keyboard, ...threadOpts }
    );
  }

  bot.callbackQuery(/^plan_new:(.+)$/, async (ctx) => {
    const stateKey = getStateKey(ctx);
    const state = getState(stateKey);
    const plan = state.pendingPlan;
    if (!plan) {
      await ctx.answerCallbackQuery({ text: "No pending plan" });
      return;
    }

    let planContent: string;
    try {
      planContent = readFileSync(plan.planPath, "utf-8");
    } catch {
      await ctx.answerCallbackQuery({ text: "Could not read plan file" });
      state.pendingPlan = undefined;
      return;
    }

    setActiveProject(state, plan.projectPath);
    updateSession(state, plan.projectPath);
    state.pendingPlan = undefined;
    await ctx.answerCallbackQuery({ text: "Executing plan (new session)..." });
    await ctx.editMessageText("Executing plan (new session)...");

    const prompt = `Execute the following plan. Do not re-enter plan mode.\n\n${planContent}`;
    runAndDrain(ctx, prompt, state, stateKey).catch((e) =>
      console.error("plan_new error:", e)
    );
  });

  bot.callbackQuery(/^plan_resume:(.+)$/, async (ctx) => {
    const stateKey = getStateKey(ctx);
    const state = getState(stateKey);
    const plan = state.pendingPlan;
    if (!plan) {
      await ctx.answerCallbackQuery({ text: "No pending plan" });
      return;
    }

    setActiveProject(state, plan.projectPath);
    if (plan.sessionId) {
      updateSession(state, plan.projectPath, plan.sessionId);
    }
    state.pendingPlan = undefined;
    await ctx.answerCallbackQuery({
      text: "Executing plan (keeping context)...",
    });
    await ctx.editMessageText("Executing plan (keeping context)...");

    const prompt =
      "The plan has been approved. Proceed with execution. Do not re-enter plan mode.";
    runAndDrain(ctx, prompt, state, stateKey).catch((e) =>
      console.error("plan_resume error:", e)
    );
  });

  bot.callbackQuery(/^plan_modify:(.+)$/, async (ctx) => {
    const stateKey = getStateKey(ctx);
    const state = getState(stateKey);
    if (!state.pendingPlan) {
      await ctx.answerCallbackQuery({ text: "No pending plan" });
      return;
    }
    const cancelKeyboard = new InlineKeyboard().text(
      "Cancel",
      `plan_cancel:${stateKey}`
    );
    await ctx.answerCallbackQuery({ text: "Send your feedback" });
    await ctx.editMessageText(
      "Send your feedback. Next message will continue the conversation with plan context.",
      { reply_markup: cancelKeyboard }
    );
  });

  bot.callbackQuery(/^plan_cancel:(.+)$/, async (ctx) => {
    const stateKey = getStateKey(ctx);
    const state = getState(stateKey);
    if (!state.pendingPlan) {
      await ctx.answerCallbackQuery({ text: "No pending plan" });
      return;
    }
    const keyboard = new InlineKeyboard()
      .text("Execute (new session)", `plan_new:${stateKey}`)
      .row()
      .text("Execute (keep context)", `plan_resume:${stateKey}`)
      .row()
      .text("Modify plan", `plan_modify:${stateKey}`);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Plan ready. How would you like to proceed?", {
      reply_markup: keyboard,
    });
  });

  /** Send a prompt to Claude and stream the response */
  async function handlePrompt(ctx: Context, prompt: string) {
    const stateKey = getStateKey(ctx);
    const state = getState(stateKey);

    if (forumMode) {
      const threadId = getThreadId(ctx);
      if (threadId) {
        const projectForThread = getProjectForThread(threadId);
        if (projectForThread && state.activeProject !== projectForThread) {
          setActiveProject(state, projectForThread);
        }
      }
    }

    if (!state.activeProject) {
      setActiveProject(state, projectsDir);
      await replyToCtx(
        ctx,
        "No project selected. Using General (all projects).",
        {
          reply_markup: mainKeyboard,
        }
      );
    }

    if (state.pendingPlan) {
      const plan = state.pendingPlan;
      setActiveProject(state, plan.projectPath);
      if (plan.sessionId) {
        updateSession(state, plan.projectPath, plan.sessionId);
      }
      state.pendingPlan = undefined;
      const feedbackPrompt = `Plan feedback from user: ${prompt}\n\nRevise the plan based on this feedback. Do not execute yet — present the updated plan.`;
      await runAndDrain(ctx, feedbackPrompt, state, stateKey);
      return;
    }

    if (hasActiveProcess(stateKey)) {
      state.queue.push({ prompt, ctx });
      await sendOrUpdateQueueStatus(ctx, state);
      return;
    }

    await runAndDrain(ctx, prompt, state, stateKey);
  }

  /** Run a Claude prompt and drain any queued messages afterward */
  async function runAndDrain(
    ctx: Context,
    prompt: string,
    state: UserState,
    processKey: number
  ) {
    let currentCtx = ctx;
    let currentPrompt = prompt;
    while (true) {
      const sessionId = state.sessions.get(state.activeProject);
      const projectName =
        state.activeProject === projectsDir
          ? "general"
          : basename(state.activeProject);
      const branchName =
        state.activeProject !== projectsDir
          ? getCurrentBranch(state.activeProject)
          : null;
      const threadId = getThreadId(currentCtx);
      try {
        const events = runClaude(
          processKey,
          currentPrompt,
          state.activeProject,
          currentCtx.chat!.id,
          sessionId
        );
        const result = await streamToTelegram(currentCtx, events, projectName, {
          branchName,
          threadId,
        });
        if (result.sessionId) {
          updateSession(state, state.activeProject, result.sessionId);
        }
        if (result.planPath) {
          stopClaude(processKey);
          await presentPlan(currentCtx, processKey, state, result);
          return;
        }
      } catch (e) {
        console.error("runAndDrain error:", e);
      }
      if (state.queue.length === 0) {
        break;
      }
      const next = state.queue.shift()!;
      currentPrompt = next.prompt;
      currentCtx = next.ctx;
      if (state.queue.length === 0) {
        await cleanupQueueStatus(state, currentCtx);
      }
      const remaining = state.queue.length;
      const queueInfo = remaining > 0 ? ` | ${remaining} more in queue` : "";
      const preview =
        currentPrompt.length > 200
          ? `${currentPrompt.slice(0, 200)}...`
          : currentPrompt;
      await replyToCtx(
        currentCtx,
        `<b>▶ Processing queued message</b>${queueInfo}\n<pre>${escapeHtml(preview)}</pre>`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
  }

  /** Send or update the "Message queued" status message with Force Send button */
  async function sendOrUpdateQueueStatus(ctx: Context, state: UserState) {
    const stateKey = getStateKey(ctx);
    const text = `Message queued (${state.queue.length} in queue)`;
    const keyboard = new InlineKeyboard()
      .text("Force Send — stops current task", `force_send:${stateKey}`)
      .row()
      .text("Clear Queue", `clear_queue:${stateKey}`);
    if (state.queueStatusMessageId) {
      await ctx.api
        .editMessageText(ctx.chat!.id, state.queueStatusMessageId, text, {
          reply_markup: keyboard,
        })
        .catch(() => {});
    } else {
      const msg = await replyToCtx(ctx, text, { reply_markup: keyboard });
      state.queueStatusMessageId = msg.message_id;
    }
  }

  /** Delete the queue status message if it exists */
  async function cleanupQueueStatus(state: UserState, ctx: Context) {
    if (state.queueStatusMessageId) {
      await ctx.api
        .deleteMessage(ctx.chat!.id, state.queueStatusMessageId)
        .catch(() => {});
      state.queueStatusMessageId = undefined;
    }
  }

  /** Send or update compose mode status message with inline buttons */
  async function updateComposeStatus(ctx: Context, state: UserState) {
    const stateKey = getStateKey(ctx);
    const count = state.composeMessages?.length ?? 0;
    const text = `Composing (${count} message${count !== 1 ? "s" : ""})`;
    const keyboard = new InlineKeyboard()
      .text("Send", `compose_send:${stateKey}`)
      .text("Cancel", `compose_cancel:${stateKey}`);
    if (state.composeStatusMessageId) {
      await ctx.api
        .editMessageText(ctx.chat!.id, state.composeStatusMessageId, text, {
          reply_markup: keyboard,
        })
        .catch(() => {});
    } else {
      const msg = await replyToCtx(ctx, text, { reply_markup: keyboard });
      state.composeStatusMessageId = msg.message_id;
    }
  }

  /** Delete the compose status message if it exists */
  async function cleanupComposeStatus(state: UserState, ctx: Context) {
    if (state.composeStatusMessageId) {
      await ctx.api
        .deleteMessage(ctx.chat!.id, state.composeStatusMessageId)
        .catch(() => {});
      state.composeStatusMessageId = undefined;
    }
  }

  /** Collect a message into compose queue based on its type */
  async function collectComposeMessage(ctx: Context, state: UserState) {
    const messages = state.composeMessages!;
    if (messages.length >= MAX_COMPOSE_MESSAGES) {
      await replyToCtx(
        ctx,
        `Compose limit reached (${MAX_COMPOSE_MESSAGES} messages). Use /send to submit or /stop to clear.`
      );
      return;
    }
    try {
      if (ctx.message?.voice) {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        const res = await fetch(url);
        const buffer = Buffer.from(await res.arrayBuffer());
        const status = await replyToCtx(ctx, "Transcribing...", {
          reply_parameters: { message_id: ctx.message.message_id },
        });
        const transcription = await transcribeAudio(buffer, "voice.ogg");
        const maxDisplay = 3800;
        const displayText =
          transcription.length > maxDisplay
            ? `${transcription.slice(0, maxDisplay)}... (truncated)`
            : transcription;
        await ctx.api.editMessageText(
          ctx.chat!.id,
          status.message_id,
          `<blockquote>${escapeHtml(displayText)}</blockquote>`,
          { parse_mode: "HTML" }
        );
        messages.push({ type: "voice", content: transcription });
      } else if (ctx.message?.document) {
        const doc = ctx.message.document;
        const filename = doc.file_name ?? `file_${Date.now()}`;
        const dest = await saveUploadedFile(ctx, filename);
        const caption = ctx.message.caption ?? "";
        messages.push({
          type: "file",
          content: `[File: ${filename} saved at ${dest}]\n${caption}`.trim(),
        });
      } else if (ctx.message?.photo) {
        const photos = ctx.message.photo;
        const largest = photos.at(-1)!;
        const filename = `photo_${Date.now()}.jpg`;
        const dest = await saveUploadedFile(ctx, filename, largest.file_id);
        const caption = ctx.message.caption ?? "";
        messages.push({
          type: "photo",
          content: `[Photo saved at ${dest}]\n${caption}`.trim(),
        });
      } else if (ctx.message?.forward_origin) {
        const origin = ctx.message.forward_origin;
        let senderName = "unknown";
        if (origin.type === "user") {
          senderName = origin.sender_user.first_name;
        } else if (origin.type === "channel") {
          senderName = origin.chat.title;
        } else if (origin.type === "hidden_user") {
          senderName = origin.sender_user_name;
        }
        const text = ctx.message.text ?? ctx.message.caption ?? "";
        messages.push({
          type: "forwarded",
          content: `[Forwarded from ${senderName}]\n${text}`,
        });
      } else if (ctx.message?.text) {
        messages.push({ type: "text", content: ctx.message.text });
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "unknown error";
      await replyToCtx(ctx, `Error collecting message: ${errMsg}`).catch(
        () => {}
      );
      return;
    }
    await updateComposeStatus(ctx, state);
  }

  bot.on("message:text", (ctx) => {
    if (forumMode && !getThreadId(ctx)) {
      replyToCtx(
        ctx,
        "Send messages in a project topic. Use /projects to see available projects."
      ).catch(() => {});
      return;
    }
    const prompt = buildPromptWithReplyContext(ctx, ctx.message.text, botId);
    handlePrompt(ctx, prompt).catch((e) =>
      console.error("handlePrompt error:", e)
    );
  });

  bot.on("message:voice", async (ctx) => {
    if (forumMode && !getThreadId(ctx)) {
      await replyToCtx(
        ctx,
        "Send messages in a project topic. Use /projects to see available projects."
      );
      return;
    }
    const state = getState(getStateKey(ctx));

    if (!state.activeProject) {
      setActiveProject(state, projectsDir);
      await replyToCtx(
        ctx,
        "No project selected. Using General (all projects).",
        {
          reply_markup: mainKeyboard,
        }
      );
    }

    let prompt: string;
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const res = await fetch(url);
      const buffer = Buffer.from(await res.arrayBuffer());

      const status = await replyToCtx(ctx, "Transcribing...", {
        reply_parameters: { message_id: ctx.message.message_id },
      });
      prompt = await transcribeAudio(buffer, "voice.ogg");
      const maxDisplay = 3800;
      const displayText =
        prompt.length > maxDisplay
          ? `${prompt.slice(0, maxDisplay)}... (truncated)`
          : prompt;
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `<blockquote>${escapeHtml(displayText)}</blockquote>`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      console.error("Voice transcription error:", e);
      await replyToCtx(
        ctx,
        `Transcription failed: ${e instanceof Error ? e.message : "unknown error"}`
      );
      return;
    }

    const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
    handlePrompt(ctx, fullPrompt).catch((e) =>
      console.error("handlePrompt error:", e)
    );
  });

  /** Download a Telegram file and save to project's user-sent-files dir */
  async function saveUploadedFile(
    ctx: Context,
    filename: string,
    fileId?: string
  ) {
    const state = getState(getStateKey(ctx));
    if (!state.activeProject) {
      setActiveProject(state, projectsDir);
      await replyToCtx(
        ctx,
        "No project selected. Using General (all projects).",
        {
          reply_markup: mainKeyboard,
        }
      );
    }

    const file = fileId ? await ctx.api.getFile(fileId) : await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());

    const dir = join(state.activeProject, "user-sent-files");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, basename(filename));
    writeFileSync(dest, buffer);
    return dest;
  }

  bot.on("message:document", async (ctx) => {
    if (forumMode && !getThreadId(ctx)) {
      await replyToCtx(
        ctx,
        "Send files in a project topic. Use /projects to see available projects."
      );
      return;
    }
    const doc = ctx.message.document;
    const filename = doc.file_name ?? `file_${Date.now()}`;

    try {
      const dest = await saveUploadedFile(ctx, filename);
      if (!dest) {
        return;
      }

      const caption = ctx.message.caption ?? "See the attached file.";
      const prompt = `${caption}\n\n[File: ${filename} saved at ${dest}]`;
      const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
      handlePrompt(ctx, fullPrompt).catch((e) =>
        console.error("handlePrompt error:", e)
      );
    } catch (e) {
      console.error("Document upload error:", e);
      await replyToCtx(
        ctx,
        `File upload failed: ${e instanceof Error ? e.message : "unknown error"}`
      );
    }
  });

  /** Flush a completed media group: save all photos and send as one prompt */
  async function flushMediaGroup(groupId: string) {
    const group = mediaGroupBuffers.get(groupId);
    mediaGroupBuffers.delete(groupId);
    if (!group) {
      return;
    }

    const { ctx, photos, caption } = group;
    const state = getState(getUserId(ctx));

    try {
      const photoParts: string[] = [];
      for (const photo of photos) {
        const dest = await saveUploadedFile(ctx, photo.filename, photo.fileId);
        photoParts.push(`[Photo saved at ${dest}]`);
      }
      const text = caption || "See the attached photos.";
      const prompt = `${text}\n\n${photoParts.join("\n")}`;

      if (state.composeMessages) {
        for (const part of photoParts) {
          state.composeMessages.push({
            type: "photo",
            content: `${part}\n${caption}`.trim(),
          });
        }
        await updateComposeStatus(ctx, state);
      } else {
        const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
        handlePrompt(ctx, fullPrompt).catch((e) =>
          console.error("handlePrompt error:", e)
        );
      }
    } catch (e) {
      console.error("Media group upload error:", e);
      await replyToCtx(
        ctx,
        `Photo upload failed: ${e instanceof Error ? e.message : "unknown error"}`
      );
    }
  }

  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos.at(-1)!;
    const filename = `photo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`;
    const mediaGroupId = ctx.message.media_group_id;

    if (mediaGroupId) {
      const existing = mediaGroupBuffers.get(mediaGroupId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.photos.push({ fileId: largest.file_id, filename });
        if (ctx.message.caption) {
          existing.caption = ctx.message.caption;
        }
        existing.timer = setTimeout(
          () => flushMediaGroup(mediaGroupId),
          MEDIA_GROUP_DEBOUNCE_MS
        );
      } else {
        const timer = setTimeout(
          () => flushMediaGroup(mediaGroupId),
          MEDIA_GROUP_DEBOUNCE_MS
        );
        mediaGroupBuffers.set(mediaGroupId, {
          photos: [{ fileId: largest.file_id, filename }],
          caption: ctx.message.caption ?? "",
          ctx,
          timer,
        });
      }
      return;
    }

    // Single photo (no media group)
    try {
      const dest = await saveUploadedFile(ctx, filename, largest.file_id);
      if (!dest) {
        return;
      }

      const caption = ctx.message.caption ?? "See the attached photo.";
      const prompt = `${caption}\n\n[Photo saved at ${dest}]`;
      const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
      handlePrompt(ctx, fullPrompt).catch((e) =>
        console.error("handlePrompt error:", e)
      );
    } catch (e) {
      console.error("Photo upload error:", e);
      await replyToCtx(
        ctx,
        `Photo upload failed: ${e instanceof Error ? e.message : "unknown error"}`
      );
    }
  });

  return bot;
}
