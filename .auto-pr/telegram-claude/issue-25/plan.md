# Plan: Stream thinking content instead of just timer

## Summary

Currently, `thinking_delta` events from Claude CLI are explicitly ignored in `claude.ts:126`, and the user sees only a static "Thinking..." message that becomes "Thought for X.Xs" when done. This change pipes the actual thinking text through to Telegram, displayed progressively with the same throttled-edit pattern used for text streaming. Long thinking content uses Telegram's expandable blockquote for a clean UX.

## Approach

Two-file change: add a `thinking_delta` event to `claude.ts`, then handle it in `telegram.ts` with a new thinking accumulator and flush function that mirrors the existing text/tool patterns.

## Architectural decisions

1. **Reuse the existing throttled-edit pattern** — thinking deltas arrive as frequently as text deltas. The `pendingEdit` + `setInterval` approach already solves Telegram rate-limiting; extend it to thinking mode rather than building a separate mechanism.

2. **Expandable blockquote for display** — follow the `flushTools` pattern: use `<blockquote expandable><i>...</i></blockquote>` when thinking content is long (>= 4 lines or > 200 chars). Short thinking stays inline italic. This reuses Telegram's native collapsible UI.

3. **Truncate from the front** — thinking blocks can be thousands of characters. When exceeding `MAX_MSG_LENGTH`, keep the most recent content (tail) since early thinking is less relevant. Prefix with "..." to indicate truncation.

4. **Single message per thinking block** — thinking content stays in one message (with progressive edits), finalized with a duration footer line. No message splitting for thinking — just truncate. This avoids the complexity of multi-message thinking and keeps the chat clean.

## Key code snippets

### `claude.ts` — Add `thinking_delta` to `ClaudeEvent` and yield it

```typescript
// Add to ClaudeEvent union (after line 40):
| { kind: "thinking_delta"; text: string }

// Replace line 126 comment with:
} else if (delta.type === "thinking_delta" && currentBlockType === "thinking") {
  if (delta.thinking) yield { kind: "thinking_delta", text: delta.thinking }
}
// signature_delta: still ignored
```

### `telegram.ts` — Handle thinking deltas with accumulation and flush

```typescript
// New state variable alongside existing ones:
let thinkingText = ""

// New flush function:
const flushThinking = async (final = false) => {
  if (!thinkingText) return
  const now = Date.now()
  if (!final && now - lastEditTime < EDIT_INTERVAL_MS) {
    pendingEdit = true
    return
  }
  pendingEdit = false
  lastEditTime = now

  let display = thinkingText
  // Truncate from front if too long, leaving room for markup
  const maxContent = MAX_MSG_LENGTH - 200
  if (display.length > maxContent) {
    display = "..." + display.slice(display.length - maxContent)
  }

  const escaped = escapeHtml(display)
  const lines = escaped.split("\n")
  const inner = `<i>${escaped}</i>`
  const text = lines.length >= 4
    ? `<blockquote expandable>${inner}</blockquote>`
    : inner
  await safeEditMessage(ctx, chatId, messageId, text, display)
}

// In switchMode — add thinkingText reset:
thinkingText = ""

// In switchMode — add thinking finalization (alongside text/tools):
if (mode === "thinking" && thinkingText) {
  await flushThinking(true)
}

// Handle thinking_delta event (new case in the for-await loop):
} else if (event.kind === "thinking_delta") {
  if (mode !== "thinking") {
    await switchMode("thinking")
    await sendNew("<i>Thinking...</i>", "HTML")
  }
  thinkingText += event.text
  await flushThinking().catch(() => {})

// Modify thinking_done handler to include content:
} else if (event.kind === "thinking_done") {
  if (mode === "thinking") {
    const secs = (event.durationMs / 1000).toFixed(1)
    if (thinkingText) {
      await flushThinking(true)
      // Append duration line to the existing thinking message
      let display = thinkingText
      const maxContent = MAX_MSG_LENGTH - 200
      if (display.length > maxContent) {
        display = "..." + display.slice(display.length - maxContent)
      }
      const escaped = escapeHtml(display)
      const lines = escaped.split("\n")
      const inner = `<i>${escaped}</i>`
      const body = lines.length >= 4
        ? `<blockquote expandable>${inner}</blockquote>`
        : inner
      const footer = `<i>Thought for ${secs}s</i>`
      await safeEditMessage(ctx, chatId, messageId, `${body}\n${footer}`).catch(() => {})
    } else {
      await safeEditMessage(ctx, chatId, messageId, `<i>Thought for ${secs}s</i>`).catch(() => {})
    }
  }
  mode = "none"

// Update editTimer to also flush thinking:
const editTimer = setInterval(async () => {
  if (pendingEdit && mode === "text") await flushText().catch(() => {})
  if (pendingEdit && mode === "thinking") await flushThinking().catch(() => {})
}, EDIT_INTERVAL_MS)
```

## Scope boundaries

- **Out of scope**: Separate messages for thinking (one message per block, not multi-message splitting)
- **Out of scope**: Persisting or logging thinking content
- **Out of scope**: User preferences to toggle thinking display on/off
- **Out of scope**: Changes to bot.ts, index.ts, transcribe.ts, or history.ts

## Risks

1. **Telegram message length** — thinking blocks can be very long. Truncation from front mitigates this, but edge cases with HTML entity expansion (`&amp;` etc.) could push past limits. The `safeEditMessage` fallback to plain text provides a safety net.

2. **Edit rate limits** — rapid thinking deltas could still hit Telegram API limits despite throttling. The existing 1.5s interval should be sufficient since it already handles text deltas at similar rates.

3. **HTML parse failures** — thinking text might contain characters that break HTML parsing even after escaping. The existing `safeEditMessage` fallback handles this.

4. **Blockquote expandable support** — older Telegram clients may not render `<blockquote expandable>` correctly. This is already accepted risk from the tool display feature.

## Alternative approaches

1. **Separate message for thinking** — send thinking in a dedicated message, keep response in another. Rejected: creates message clutter; the expandable blockquote approach is cleaner and already proven with tool display.

2. **Show only a summary/snippet** — display first/last N chars of thinking instead of full content. Rejected: loses information; the expandable blockquote already provides collapsibility for long content.

3. **Reply-to-message threading** — put thinking as a reply to the "Thinking..." message. Rejected: Telegram reply threading is weak; adds complexity without clear UX benefit.

4. **Spoiler tags for thinking** — wrap thinking in `<tg-spoiler>` for tap-to-reveal. Rejected: spoilers require explicit tap per view and don't support progressive streaming updates well.
