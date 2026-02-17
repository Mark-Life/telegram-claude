import { createBot } from "./bot"
import { stopAll } from "./claude"

const BOT_TOKEN = process.env.BOT_TOKEN
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID
const GROQ_API_KEY = process.env.GROQ_API_KEY
const PROJECTS_DIR = process.env.PROJECTS_DIR || "/home/agent/projects"

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN env var")
  process.exit(1)
}
if (!ALLOWED_USER_ID) {
  console.error("Missing ALLOWED_USER_ID env var")
  process.exit(1)
}
if (!GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY env var")
  process.exit(1)
}

const userId = parseInt(ALLOWED_USER_ID, 10)
if (isNaN(userId)) {
  console.error("ALLOWED_USER_ID must be a number")
  process.exit(1)
}

const bot = createBot(BOT_TOKEN, userId, PROJECTS_DIR)

bot.catch((err) => {
  console.error("Bot error:", err)
})

let shuttingDown = false
const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  console.log("Shutting down...")
  stopAll()
  bot.stop()
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

bot.start({
  onStart: () => console.log("Bot started"),
})
