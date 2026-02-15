import type { Context } from "grammy"
import type { ClaudeEvent } from "./claude"

const MAX_MSG_LENGTH = 4000
const EDIT_INTERVAL_MS = 1500

/** Escape text for Telegram MarkdownV2 */
function escapeMarkdownV2(text: string) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1")
}

/** Try sending with MarkdownV2, fall back to plain text */
async function safeEditMessage(ctx: Context, chatId: number, messageId: number, text: string, rawText?: string) {
  const displayText = text || "..."
  try {
    await ctx.api.editMessageText(chatId, messageId, displayText, { parse_mode: "MarkdownV2" })
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

      await safeEditMessage(ctx, chatId, messageId, escapeMarkdownV2(chunk), chunk)
      const next = await ctx.api.sendMessage(chatId, "...")
      messageId = next.message_id
      text = accumulated
    }

    const display = final ? formatFinalMessage(text, projectName, result) : escapeMarkdownV2(text)
    const rawDisplay = final ? formatFinalMessagePlain(text, projectName, result) : text
    await safeEditMessage(ctx, chatId, messageId, display || "\\.\\.\\.", rawDisplay || "...")
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
  const escaped = escapeMarkdownV2(text)
  const parts = [escaped]

  const meta: string[] = []
  if (projectName) meta.push(`Project: ${escapeMarkdownV2(projectName)}`)
  if (result.cost !== undefined) meta.push(`Cost: $${result.cost.toFixed(4)}`)
  if (result.durationMs !== undefined) {
    const secs = (result.durationMs / 1000).toFixed(1)
    meta.push(`Time: ${secs}s`)
  }
  if (result.turns !== undefined && result.turns > 1) meta.push(`Turns: ${result.turns}`)

  if (meta.length > 0) {
    parts.push("")
    parts.push(`_${meta.join(" \\| ")}_`)
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
