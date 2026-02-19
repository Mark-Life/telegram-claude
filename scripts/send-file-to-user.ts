#!/usr/bin/env bun

const BLOCKED_PATTERNS = [
  /^\.env/,
  /^\.env\..+/,
  /^credentials/i,
  /^secrets/i,
  /\.pem$/,
  /\.key$/,
]

const filePath = process.argv[2]
if (!filePath) {
  console.error("Usage: send-file-to-user.ts <filepath>")
  process.exit(1)
}

const botToken = process.env.BOT_TOKEN
const chatId = process.env.TELEGRAM_CHAT_ID
if (!botToken || !chatId) {
  console.error("Missing BOT_TOKEN or TELEGRAM_CHAT_ID env vars")
  process.exit(1)
}

const file = Bun.file(filePath)
if (!(await file.exists())) {
  console.error(`File not found: ${filePath}`)
  process.exit(1)
}

const basename = filePath.split("/").pop() ?? ""
const blocked = BLOCKED_PATTERNS.some((p) => p.test(basename))
if (blocked) {
  console.error(`Blocked: ${basename} matches sensitive file pattern`)
  process.exit(1)
}

const form = new FormData()
form.append("chat_id", chatId)
form.append("document", file, basename)

const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
  method: "POST",
  body: form,
})

const data = await res.json()
if (!data.ok) {
  console.error(`Telegram API error: ${JSON.stringify(data)}`)
  process.exit(1)
}

console.log(`Sent ${basename} to chat ${chatId}`)
