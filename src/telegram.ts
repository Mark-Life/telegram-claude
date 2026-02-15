import type { Context } from "grammy"
import type { ClaudeEvent } from "./claude"

const MAX_MSG_LENGTH = 4000
const EDIT_INTERVAL_MS = 1500

/** Escape HTML special characters */
function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Convert standard Markdown to Telegram-compatible HTML */
function markdownToTelegramHtml(md: string) {
  const codeBlocks: string[] = []

  let text = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ""))
    const html = lang
      ? `<pre><code class="language-${lang}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`
    codeBlocks.push(html)
    return `\x00CB${codeBlocks.length - 1}\x00`
  })

  const inlineCodes: string[] = []
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00IC${inlineCodes.length - 1}\x00`
  })

  text = escapeHtml(text)

  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
  text = text.replace(/\*(.+?)\*/g, "<i>$1</i>")
  text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>")
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>")
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
  text = text.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>")
  text = text.replace(/<\/blockquote>\n<blockquote>/g, "\n")

  text = text.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCodes[parseInt(idx)])
  text = text.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)])

  return text
}

/** Try sending with HTML, fall back to plain text */
async function safeEditMessage(ctx: Context, chatId: number, messageId: number, text: string, rawText?: string) {
  const displayText = text || "..."
  try {
    await ctx.api.editMessageText(chatId, messageId, displayText, { parse_mode: "HTML" })
  } catch {
    try {
      await ctx.api.editMessageText(chatId, messageId, rawText ?? displayText)
    } catch (err: any) {
      if (!err?.description?.includes("message is not modified")) throw err
    }
  }
}

type StreamResult = {
  sessionId?: string
  cost?: number
  durationMs?: number
  turns?: number
}

/** Stream Claude events into progressively-edited Telegram messages */
export async function streamToTelegram(
  ctx: Context,
  events: AsyncGenerator<ClaudeEvent>,
  projectName: string
): Promise<StreamResult> {
  const chatId = ctx.chat!.id
  const sent = await ctx.reply("...")
  let messageId = sent.message_id
  let accumulated = ""
  let lastEditTime = 0
  let pendingEdit = false
  const result: StreamResult = {}

  const doEdit = async (final = false) => {
    const now = Date.now()
    if (!final && now - lastEditTime < EDIT_INTERVAL_MS) {
      pendingEdit = true
      return
    }
    pendingEdit = false
    lastEditTime = now

    let text = accumulated
    if (text.length > MAX_MSG_LENGTH) {
      const cutPoint = text.lastIndexOf("\n", MAX_MSG_LENGTH)
      const splitAt = cutPoint > MAX_MSG_LENGTH * 0.5 ? cutPoint : MAX_MSG_LENGTH
      const chunk = text.slice(0, splitAt)
      accumulated = text.slice(splitAt)

      await safeEditMessage(ctx, chatId, messageId, markdownToTelegramHtml(chunk), chunk)
      const next = await ctx.api.sendMessage(chatId, "...")
      messageId = next.message_id
      text = accumulated
    }

    const display = final ? formatFinalMessage(text, projectName, result) : markdownToTelegramHtml(text)
    const rawDisplay = final ? formatFinalMessagePlain(text, projectName, result) : text
    await safeEditMessage(ctx, chatId, messageId, display || "...", rawDisplay || "...")
  }

  const editTimer = setInterval(async () => {
    if (pendingEdit) await doEdit().catch(() => {})
  }, EDIT_INTERVAL_MS)

  try {
    for await (const event of events) {
      if (event.kind === "text_delta") {
        accumulated += event.text
        await doEdit().catch(() => {})
      } else if (event.kind === "result") {
        result.sessionId = event.sessionId
        result.cost = event.cost
        result.durationMs = event.durationMs
        result.turns = event.turns
        if (!accumulated) accumulated = event.text
      } else if (event.kind === "error") {
        accumulated += `\n\n[Error: ${event.message}]`
      }
    }
  } finally {
    clearInterval(editTimer)
  }

  await doEdit(true).catch(() => {})
  return result
}

/** Format the final message with metadata footer */
function formatFinalMessage(text: string, projectName: string, result: StreamResult) {
  const html = markdownToTelegramHtml(text)
  const parts = [html]

  const meta: string[] = []
  if (projectName) meta.push(`Project: ${escapeHtml(projectName)}`)
  if (result.cost !== undefined) meta.push(`Cost: $${result.cost.toFixed(4)}`)
  if (result.durationMs !== undefined) {
    const secs = (result.durationMs / 1000).toFixed(1)
    meta.push(`Time: ${secs}s`)
  }
  if (result.turns !== undefined && result.turns > 1) meta.push(`Turns: ${result.turns}`)

  if (meta.length > 0) {
    parts.push("")
    parts.push(`<i>${meta.join(" | ")}</i>`)
  }

  return parts.join("\n")
}

/** Plain text version of final message (used as fallback) */
function formatFinalMessagePlain(text: string, projectName: string, result: StreamResult) {
  const parts = [text]
  const meta: string[] = []
  if (projectName) meta.push(`Project: ${projectName}`)
  if (result.cost !== undefined) meta.push(`Cost: $${result.cost.toFixed(4)}`)
  if (result.durationMs !== undefined) {
    const secs = (result.durationMs / 1000).toFixed(1)
    meta.push(`Time: ${secs}s`)
  }
  if (result.turns !== undefined && result.turns > 1) meta.push(`Turns: ${result.turns}`)
  if (meta.length > 0) {
    parts.push("")
    parts.push(meta.join(" | "))
  }
  return parts.join("\n")
}
