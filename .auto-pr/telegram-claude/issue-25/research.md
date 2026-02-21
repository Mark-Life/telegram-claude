# Research: Stream thinking content instead of just timer

## Issue Summary

Currently, when Claude thinks, the user sees only "Thinking..." with an elapsed timer. The actual thinking content (streamed via `thinking_delta` events) is explicitly ignored. The goal is to display this content to the user.

## Relevant Files

### `src/claude.ts` — CLI spawner and stream parser
- **Lines 8-12**: `ContentBlockDelta` type already includes `{ type: "thinking_delta"; thinking: string }` — the raw stream event type is defined
- **Lines 36-42**: `ClaudeEvent` union — only has `thinking_start` and `thinking_done`, no delta event for thinking content
- **Line 126**: Comment `// thinking_delta and signature_delta: ignored (we just show "Thinking...")` — the explicit skip
- **Lines 108-113**: `content_block_start` for thinking — yields `thinking_start`, sets `thinkingStartTime`
- **Lines 139-142**: `content_block_stop` for thinking — yields `thinking_done` with elapsed duration

### `src/telegram.ts` — Message streaming to Telegram
- **Lines 130**: `MessageMode` type includes `"thinking"` already
- **Lines 237-239**: `thinking_start` handling — calls `switchMode("thinking")` then sends `<i>Thinking...</i>`
- **Lines 240-245**: `thinking_done` handling — edits message to `<i>Thought for X.Xs</i>`, sets mode to `"none"`
- **Lines 5-7**: Constants — `MAX_MSG_LENGTH = 4000`, `EDIT_INTERVAL_MS = 1500`
- **Lines 188-195**: `flushTools()` — uses expandable `<blockquote expandable>` when >= 4 lines; good pattern to follow

### `src/bot.ts` — Bot setup, not directly modified
### `src/index.ts` — Entry point, not modified
### `src/history.ts` — Session history, not relevant
### `src/transcribe.ts` — Voice transcription, not relevant

## Existing Patterns

1. **Event flow**: `claude.ts` yields typed `ClaudeEvent` objects → `telegram.ts` consumes via `for await` loop and renders to Telegram messages
2. **Mode switching**: `streamToTelegram` tracks a `mode` (`text` | `tools` | `thinking` | `none`). Switching modes finalizes the previous message and starts a new one
3. **Throttled edits**: Text mode uses `EDIT_INTERVAL_MS` (1.5s) throttling with `pendingEdit` flag and a `setInterval` timer to batch rapid updates
4. **Expandable blockquote**: Tool lines use `<blockquote expandable>` when >= 4 lines — Telegram's native collapsible UI. Ideal for long thinking content
5. **Safe editing**: `safeEditMessage` tries HTML first, falls back to plain text on parse failure

## Dependencies

- **Grammy** (Telegram bot framework) — `ctx.api.editMessageText`, `ctx.api.sendMessage`
- **Telegram Bot API** — supports `<blockquote expandable>` for collapsible content in HTML parse mode
- No new dependencies needed

## Implementation Approach

### Changes to `claude.ts`:
1. Add `{ kind: "thinking_delta"; text: string }` to `ClaudeEvent` union type
2. In the stream parser, where `thinking_delta` is currently ignored (line 126), yield: `{ kind: "thinking_delta", text: delta.thinking }`

### Changes to `telegram.ts`:
1. Add state for tracking accumulated thinking text (similar to `accumulated` for text mode)
2. Handle `thinking_delta` events:
   - Append to thinking accumulator
   - Throttle edits same as text mode (reuse `EDIT_INTERVAL_MS`)
   - Render as italic text inside expandable blockquote when long
3. On `thinking_done`, finalize the thinking message with duration footer
4. Keep the "Thought for Xs" summary but include the actual content above it

### Display Format Options:
- **Short thinking** (< ~200 chars): Show inline italic: `<i>{thinking text}\n\nThought for X.Xs</i>`
- **Long thinking**: Use expandable blockquote: `<blockquote expandable><i>{thinking text}</i></blockquote>\n<i>Thought for X.Xs</i>`
- Must respect `MAX_MSG_LENGTH` (4000 chars) — truncate thinking content if needed since thinking blocks can be very long (thousands of chars)

## Potential Impact Areas

- **Message edit rate limits**: Telegram rate-limits `editMessageText`. The existing 1.5s throttle handles this. Thinking deltas arrive frequently, so throttling is essential
- **Message length**: Thinking blocks can be extremely long. Need truncation strategy (e.g., keep last N chars, or truncate with "..." prefix)
- **Edit timer**: The `editTimer` `setInterval` currently only fires for `mode === "text"`. Need to also fire for `mode === "thinking"`
- **No test suite** to worry about breaking

## Edge Cases and Constraints

1. **Very long thinking**: Claude's thinking can be thousands of characters. Must truncate to stay under 4000 char Telegram limit. Expandable blockquote helps but content still counts toward the limit
2. **Multiple thinking blocks**: Claude can think multiple times in one response (think → text → think → text). Each thinking block triggers `thinking_start`/deltas/`thinking_done`. The mode-switching pattern already handles this correctly
3. **Empty thinking deltas**: Some deltas may have empty strings — filter or ignore
4. **HTML escaping**: Thinking text must be HTML-escaped before display (use existing `escapeHtml`)
5. **Signature deltas**: `signature_delta` appears during thinking blocks but is not user-facing content — continue ignoring it
6. **Rapid alternation**: Thinking → tool use → thinking can happen quickly. The mode switching in `switchMode()` already finalizes previous messages, so this should work

## Reference Implementations

### Tool display pattern (`telegram.ts:188-195`):
```typescript
const flushTools = async () => {
  if (toolLines.length === 0) return
  const lines = toolLines.map((l) => `<i>${escapeHtml(l)}</i>`).join("\n")
  const text = toolLines.length >= 4
    ? `<blockquote expandable>${lines}</blockquote>`
    : lines
  await safeEditMessage(ctx, chatId, messageId, text, toolLines.join("\n"))
}
```
This is the closest pattern to follow — accumulate content, format with expandable blockquote when long, render with `safeEditMessage`.

### Text streaming pattern (`telegram.ts:161-185`):
The throttled edit with `pendingEdit` flag and periodic timer flush — reuse this approach for thinking content updates.
