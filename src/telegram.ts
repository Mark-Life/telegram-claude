import type { Context } from "grammy"
import type { ClaudeEvent } from "./claude"

const MAX_MSG_LENGTH = 4000
const EDIT_INTERVAL_MS = 1500
const TYPING_INTERVAL_MS = 5000

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

/** Try editing with HTML, fall back to plain text */
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

type MessageMode = "text" | "tools" | "thinking" | "none"

type StreamOptions = {
  replyMarkup?: import("grammy").Keyboard
}

/** Stream Claude events into separate Telegram messages by type */
export async function streamToTelegram(
  ctx: Context,
  events: AsyncGenerator<ClaudeEvent>,
  projectName: string,
  options?: StreamOptions
): Promise<StreamResult> {
  const chatId = ctx.chat!.id
  const result: StreamResult = {}

  let mode: MessageMode = "none"
  let messageId = 0
  let accumulated = ""
  let lastEditTime = 0
  let pendingEdit = false
  let toolLines: string[] = []
  let lastTextMessageId = 0

  let firstMessageSent = false

  /** Send a new Telegram message and track its ID */
  const sendNew = async (text: string, parseMode?: "HTML") => {
    const opts: Record<string, unknown> = {}
    if (parseMode) opts.parse_mode = parseMode
    if (!firstMessageSent && options?.replyMarkup) {
      opts.reply_markup = options.replyMarkup
      firstMessageSent = true
    }
    const sent = await ctx.api.sendMessage(chatId, text, opts)
    messageId = sent.message_id
    lastEditTime = 0
    pendingEdit = false
    return sent
  }

  /** Finalize the current text message (split-safe edit) */
  const flushText = async (final = false) => {
    if (!accumulated) return

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
      await sendNew("...")
      text = accumulated
    }

    await safeEditMessage(ctx, chatId, messageId, markdownToTelegramHtml(text), text)
  }

  /** Update the tools message with current tool lines */
  const flushTools = async () => {
    if (toolLines.length === 0) return
    const lines = toolLines.map((l) => `<i>${escapeHtml(l)}</i>`).join("\n")
    const text = toolLines.length >= 4
      ? `<blockquote expandable>${lines}</blockquote>`
      : lines
    await safeEditMessage(ctx, chatId, messageId, text, toolLines.join("\n"))
  }

  /** Switch to a new mode, finalizing the previous one */
  const switchMode = async (newMode: MessageMode) => {
    if (mode === "text" && accumulated) {
      await flushText(true)
      lastTextMessageId = messageId
    }
    if (mode === "tools") {
      await flushTools()
    }
    mode = newMode
    accumulated = ""
    toolLines = []
  }

  const editTimer = setInterval(async () => {
    if (pendingEdit && mode === "text") await flushText().catch(() => {})
  }, EDIT_INTERVAL_MS)

  const typingTimer = setInterval(() => {
    ctx.api.sendChatAction(chatId, "typing").catch(() => {})
  }, TYPING_INTERVAL_MS)
  ctx.api.sendChatAction(chatId, "typing").catch(() => {})

  try {
    for await (const event of events) {
      if (event.kind === "text_delta") {
        if (mode !== "text") {
          await switchMode("text")
          await sendNew("...")
        }
        accumulated += event.text
        await flushText().catch(() => {})
      } else if (event.kind === "tool_use") {
        if (mode !== "tools") {
          await switchMode("tools")
          await sendNew("...")
        }
        const label = event.input ? `${event.name}: ${event.input}` : event.name
        toolLines.push(label)
        await flushTools().catch(() => {})
      } else if (event.kind === "thinking_start") {
        await switchMode("thinking")
        await sendNew("<i>Thinking...</i>", "HTML")
      } else if (event.kind === "thinking_done") {
        if (mode === "thinking") {
          const secs = (event.durationMs / 1000).toFixed(1)
          await safeEditMessage(ctx, chatId, messageId, `<i>Thought for ${secs}s</i>`).catch(() => {})
        }
        mode = "none"
      } else if (event.kind === "result") {
        result.sessionId = event.sessionId
        result.cost = event.cost
        result.durationMs = event.durationMs
        result.turns = event.turns
        if (!accumulated && event.text) {
          if (mode !== "text") {
            await switchMode("text")
            await sendNew("...")
          }
          accumulated = event.text
        }
      } else if (event.kind === "error") {
        if (mode !== "text") {
          await switchMode("text")
          await sendNew("...")
        }
        accumulated += `\n\n[Error: ${event.message}]`
      }
    }
  } finally {
    clearInterval(editTimer)
    clearInterval(typingTimer)
  }

  // Final edit on the last text message with footer
  if (mode === "text" && accumulated) {
    lastTextMessageId = messageId
  }

  if (lastTextMessageId && accumulated) {
    const html = markdownToTelegramHtml(accumulated)
    const footer = formatFooter(projectName, result)
    const display = footer ? `${html}\n\n${footer}` : html
    const rawFooter = formatFooterPlain(projectName, result)
    const rawDisplay = rawFooter ? `${accumulated}\n\n${rawFooter}` : accumulated
    await safeEditMessage(ctx, chatId, lastTextMessageId, display || "...", rawDisplay || "...").catch(() => {})
  } else if (!lastTextMessageId && (result.cost !== undefined || result.durationMs !== undefined)) {
    // No text message was sent -- send footer as standalone
    const footer = formatFooter(projectName, result)
    if (footer) await ctx.api.sendMessage(chatId, footer, { parse_mode: "HTML" }).catch(() => {})
  }

  return result
}

/** Format metadata footer as HTML */
function formatFooter(projectName: string, result: StreamResult) {
  const meta: string[] = []
  if (projectName) meta.push(`Project: ${escapeHtml(projectName)}`)
  if (result.cost !== undefined) meta.push(`Cost: $${result.cost.toFixed(4)}`)
  if (result.durationMs !== undefined) {
    const secs = (result.durationMs / 1000).toFixed(1)
    meta.push(`Time: ${secs}s`)
  }
  if (result.turns !== undefined && result.turns > 1) meta.push(`Turns: ${result.turns}`)
  return meta.length > 0 ? `<i>${meta.join(" | ")}</i>` : ""
}

/** Format metadata footer as plain text */
function formatFooterPlain(projectName: string, result: StreamResult) {
  const meta: string[] = []
  if (projectName) meta.push(`Project: ${projectName}`)
  if (result.cost !== undefined) meta.push(`Cost: $${result.cost.toFixed(4)}`)
  if (result.durationMs !== undefined) {
    const secs = (result.durationMs / 1000).toFixed(1)
    meta.push(`Time: ${secs}s`)
  }
  if (result.turns !== undefined && result.turns > 1) meta.push(`Turns: ${result.turns}`)
  return meta.join(" | ")
}
