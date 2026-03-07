import { cleanupStaleState, createBot } from "./bot";
import { stopAll } from "./claude";
import { loadTopicMappings } from "./topics";

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PROJECTS_DIR = process.env.PROJECTS_DIR || "/home/agent/projects";

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN env var");
  process.exit(1);
}
if (!ALLOWED_USER_ID) {
  console.error("Missing ALLOWED_USER_ID env var");
  process.exit(1);
}
if (!GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY env var");
  process.exit(1);
}

const userId = Number.parseInt(ALLOWED_USER_ID, 10);
if (Number.isNaN(userId)) {
  console.error("ALLOWED_USER_ID must be a number");
  process.exit(1);
}

const chatId = ALLOWED_CHAT_ID ? Number.parseInt(ALLOWED_CHAT_ID, 10) : userId;
if (Number.isNaN(chatId)) {
  console.error("ALLOWED_CHAT_ID must be a number");
  process.exit(1);
}

const forumMode = chatId < 0;

if (forumMode) {
  loadTopicMappings();
  console.log(`Forum mode enabled (chat ${chatId})`);
}

const CLEANUP_INTERVAL = 3 * 60 * 1000;

const bot = createBot(BOT_TOKEN, userId, chatId, forumMode, PROJECTS_DIR);

bot.catch((err) => {
  console.error("Bot error:", err);
});

let shuttingDown = false;
let cleanupTimer: ReturnType<typeof setInterval> | undefined;
const shutdown = () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log("Shutting down...");
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }
  stopAll();
  bot.stop();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

bot.start({
  onStart: () => {
    console.log("Bot started");
    cleanupTimer = setInterval(cleanupStaleState, CLEANUP_INTERVAL);
    const commands = [
      { command: "projects", description: "Switch active project" },
      { command: "history", description: "Resume a past session" },
      { command: "new", description: "Start fresh conversation" },
      { command: "stop", description: "Kill active process" },
      { command: "status", description: "Show current state" },
      { command: "branch", description: "Show current git branch" },
      { command: "pr", description: "List open pull requests" },
      { command: "help", description: "Show available commands" },
      { command: "compose", description: "Start collecting messages" },
      { command: "send", description: "Send composed messages" },
      { command: "cancel", description: "Cancel compose mode" },
      { command: "chatid", description: "Show chat ID" },
    ];
    const scopes = [
      { type: "default" as const },
      { type: "all_private_chats" as const },
      { type: "all_group_chats" as const },
      { type: "all_chat_administrators" as const },
    ];
    Promise.all(
      scopes.map((scope) => bot.api.setMyCommands(commands, { scope }))
    ).catch((e) => console.error("Failed to set bot commands:", e));
    bot.api
      .sendMessage(chatId, `Bot started at ${new Date().toLocaleString()}`)
      .catch((e) => console.error("Failed to send startup message:", e));
  },
});
