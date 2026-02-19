import type { Context } from "grammy"
import { Marked } from "marked"
import type { ClaudeEvent } from "./claude"

const MAX_MSG_LENGTH = 4000
const EDIT_INTERVAL_MS = 1500
const TYPING_INTERVAL_MS = 5000

/** Escape HTML special characters */
function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Marked instance with Telegram-compatible HTML renderer */
const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const escaped = escapeHtml(text)
      return lang
        ? `\n<pre><code class="language-${lang}">${escaped}</code></pre>\n`
        : `\n<pre>${escaped}</pre>\n`
    },
    blockquote({ tokens }) {
      return `<blockquote>${this.parser.parse(tokens).trim()}</blockquote>\n`
    },
    heading({ tokens }) {
      return `<b>${this.parser.parseInline(tokens)}</b>\n`
    },
    hr() {
      return "\n"
    },
    list({ items, ordered }) {
      return items.map((item, i) => {
        const bullet = ordered ? `${i + 1}. ` : "- "
        const content = this.parser.parse(item.tokens).trim()
        return `${bullet}${content}`
      }).join("\n") + "\n"
    },
    listitem(item) {
      return this.parser.parse(item.tokens).trim()
    },
    paragraph({ tokens }) {
      return `${this.parser.parseInline(tokens)}\n`
    },
    table({ header, rows }) {
      const headerText = header.map((cell) => this.parser.parseInline(cell.tokens)).join(" | ")
      const rowTexts = rows.map((row) =>
        row.map((cell) => this.parser.parseInline(cell.tokens)).join(" | "),
      )
      return `<pre>${escapeHtml(headerText)}\n${escapeHtml(rowTexts.join("\n"))}</pre>\n`
    },
    tablerow({ text }) {
      return text
    },
    tablecell(token) {
      return this.parser.parseInline(token.tokens)
    },
    strong({ tokens }) {
      return `<b>${this.parser.parseInline(tokens)}</b>`
    },
    em({ tokens }) {
      return `<i>${this.parser.parseInline(tokens)}</i>`
    },
    codespan({ text }) {
      return `<code>${escapeHtml(text)}</code>`
    },
    br() {
      return "\n"
    },
    del({ tokens }) {
      return `<s>${this.parser.parseInline(tokens)}</s>`
    },
    link({ href, tokens }) {
      return `<a href="${escapeHtml(href)}">${this.parser.parseInline(tokens)}</a>`
    },
    image({ text }) {
      return text
    },
    space() {
      return ""
    },
    html({ text }) {
      return escapeHtml(text)
    },
    def() {
      return ""
    },
    checkbox({ checked }) {
      return checked ? "[x] " : "[ ] "
    },
    text({ tokens, text }) {
      if (tokens) return this.parser.parseInline(tokens)
      return escapeHtml(text)
    },
  },
})

/** Convert Markdown to Telegram-compatible HTML using a proper parser */
function markdownToTelegramHtml(md: string) {
  return (marked.parse(md) as string).trim()
}

/** Try editing with HTML, fall back to plain text. Returns true if HTML succeeded. */
async function safeEditMessage(ctx: Context, chatId: number, messageId: number, text: string, rawText?: string) {
  const displayText = text || "..."
  try {
    await ctx.api.editMessageText(chatId, messageId, displayText, { parse_mode: "HTML" })
    return true
  } catch (err: any) {
    if (err?.description?.includes("message is not modified") || err?.description?.includes("message can't be edited")) return true
    try {
      await ctx.api.editMessageText(chatId, messageId, rawText ?? displayText)
      return false
    } catch (err2: any) {
      if (!err2?.description?.includes("message is not modified") && !err2?.description?.includes("message can't be edited")) throw err2
      return false
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

/** Stream Claude events into separate Telegram messages by type */
export async function streamToTelegram(
  ctx: Context,
  events: AsyncGenerator<ClaudeEvent>,
  projectName: string,
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

  /** Send a new Telegram message and track its ID */
  const sendNew = async (text: string, parseMode?: "HTML") => {
    const opts: Record<string, unknown> = {}
    if (parseMode) opts.parse_mode = parseMode
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

      if (messageId === 0) {
        await sendNew(markdownToTelegramHtml(chunk), "HTML")
      } else {
        await safeEditMessage(ctx, chatId, messageId, markdownToTelegramHtml(chunk), chunk)
      }
      await sendNew("...")
      text = accumulated
    }

    if (messageId === 0) {
      await sendNew(markdownToTelegramHtml(text), "HTML")
    } else {
      await safeEditMessage(ctx, chatId, messageId, markdownToTelegramHtml(text), text)
    }
  }

  /** Update the tools message with current tool lines */
  const flushTools = async () => {
    if (toolLines.length === 0) return
    const lines = toolLines.map((l) => `<i>${escapeHtml(l)}</i>`).join("\n")
    const text = toolLines.length >= 4
      ? `<blockquote expandable>${lines}</blockquote>`
      : lines
    if (messageId === 0) {
      await sendNew(text, "HTML")
    } else {
      await safeEditMessage(ctx, chatId, messageId, text, toolLines.join("\n"))
    }
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
    messageId = 0
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
        if (mode !== "text") await switchMode("text")
        accumulated += event.text
        await flushText().catch(() => {})
      } else if (event.kind === "tool_use") {
        if (mode !== "tools") await switchMode("tools")
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
          if (mode !== "text") await switchMode("text")
          accumulated = event.text
        }
      } else if (event.kind === "error") {
        if (mode !== "text") await switchMode("text")
        accumulated += `\n\n[Error: ${event.message}]`
      }
    }
  } finally {
    clearInterval(editTimer)
    clearInterval(typingTimer)
  }

  // Final edit on the last text message with footer
  if (mode === "text" && accumulated) {
    if (messageId === 0) await flushText(true)
    lastTextMessageId = messageId
  }

  if (lastTextMessageId && accumulated) {
    const html = markdownToTelegramHtml(accumulated)
    const footer = formatFooter(projectName, result)
    const display = footer ? `${html}\n\n${footer}` : html
    const ok = await safeEditMessage(ctx, chatId, lastTextMessageId, display || "...").catch(() => false)
    if (!ok && footer) {
      // HTML with footer failed — keep existing styled message, send footer separately
      await ctx.api.sendMessage(chatId, footer, { parse_mode: "HTML" }).catch(() => {})
    }
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
