# Implementation Checklist: Stream thinking content instead of just timer

- [ ] **Task 1: Add `thinking_delta` event to `ClaudeEvent` union in `claude.ts`**
  - Files: `src/claude.ts`
  - Changes: Add `| { kind: "thinking_delta"; text: string }` to the `ClaudeEvent` type union (after line 40, between `thinking_done` and `result`)
  - Acceptance: TypeScript compiles without errors. The `ClaudeEvent` type includes `thinking_delta` variant.

- [ ] **Task 2: Yield `thinking_delta` events from the stream parser in `claude.ts`**
  - Files: `src/claude.ts`
  - Changes: Replace the comment on line 126 (`// thinking_delta and signature_delta: ignored`) with actual handling:
    ```typescript
    } else if (delta.type === "thinking_delta" && currentBlockType === "thinking") {
      if (delta.thinking) yield { kind: "thinking_delta", text: delta.thinking }
    }
    // signature_delta: ignored
    ```
  - Acceptance: When Claude thinks, the generator yields `thinking_delta` events with the thinking text. `signature_delta` is still ignored.

- [ ] **Task 3: Add thinking state variables and `flushThinking` function in `telegram.ts`**
  - Files: `src/telegram.ts`
  - Changes:
    1. Add `let thinkingText = ""` alongside the existing state variables (after `let toolLines: string[] = []` on line 146)
    2. Add a `flushThinking` function (after `flushTools`) that:
       - Takes `final = false` parameter
       - Returns early if `thinkingText` is empty
       - Applies the same throttle logic as `flushText` (check `now - lastEditTime < EDIT_INTERVAL_MS`, set `pendingEdit`)
       - Truncates from the front if content exceeds `MAX_MSG_LENGTH - 200`, prefixing with `"..."`
       - Escapes HTML with `escapeHtml()`
       - Wraps in `<i>...</i>`, and if >= 4 lines wraps additionally in `<blockquote expandable>...</blockquote>`
       - Calls `safeEditMessage` with the formatted HTML and raw text fallback
  - Acceptance: `flushThinking` exists and handles throttling, truncation, and formatting.

- [ ] **Task 4: Update `switchMode` to reset and finalize thinking state**
  - Files: `src/telegram.ts`
  - Changes: In the `switchMode` function (line 198-209):
    1. Add a block: `if (mode === "thinking" && thinkingText) { await flushThinking(true) }` — alongside the existing `mode === "text"` and `mode === "tools"` blocks
    2. Add `thinkingText = ""` in the reset section (alongside `accumulated = ""` and `toolLines = []`)
  - Acceptance: When switching away from thinking mode, the thinking message is finalized and state is reset.

- [ ] **Task 5: Update `editTimer` to flush thinking mode**
  - Files: `src/telegram.ts`
  - Changes: Modify the `editTimer` `setInterval` callback (line 211-213) to also handle thinking mode:
    ```typescript
    const editTimer = setInterval(async () => {
      if (pendingEdit && mode === "text") await flushText().catch(() => {})
      if (pendingEdit && mode === "thinking") await flushThinking().catch(() => {})
    }, EDIT_INTERVAL_MS)
    ```
  - Acceptance: Pending thinking edits are flushed on the timer interval, not just text edits.

- [ ] **Task 6: Handle `thinking_delta` events in the event loop**
  - Files: `src/telegram.ts`
  - Changes: Add a new `else if` branch in the `for await` loop (after the `thinking_start` handler, before `thinking_done`):
    ```typescript
    } else if (event.kind === "thinking_delta") {
      if (mode !== "thinking") {
        await switchMode("thinking")
        await sendNew("<i>Thinking...</i>", "HTML")
      }
      thinkingText += event.text
      await flushThinking().catch(() => {})
    ```
    This handles the case where `thinking_delta` arrives (even if `thinking_start` was missed for some reason) and accumulates the text.
  - Acceptance: Thinking deltas are accumulated and progressively rendered to the Telegram message.

- [ ] **Task 7: Update `thinking_done` handler to include thinking content**
  - Files: `src/telegram.ts`
  - Changes: Replace the existing `thinking_done` handler (lines 240-245) with logic that:
    1. If `thinkingText` is non-empty:
       - Call `flushThinking(true)` to finalize
       - Build the display: truncated + escaped thinking text wrapped in `<i>` (and `<blockquote expandable>` if >= 4 lines)
       - Append `\n<i>Thought for X.Xs</i>` footer
       - Call `safeEditMessage` with the combined content
    2. If `thinkingText` is empty: keep existing behavior (`<i>Thought for X.Xs</i>`)
    3. Reset `thinkingText = ""`
    4. Set `mode = "none"`
  - Acceptance: When thinking finishes, the message shows the actual thinking content (collapsed if long) with a duration footer. Empty thinking blocks still show just the duration.

- [ ] **Task 8: Verify everything works together**
  - Files: `src/claude.ts`, `src/telegram.ts`
  - Changes: None — manual verification
  - Acceptance:
    1. Bot starts without errors: `bun run src/index.ts`
    2. Send a message that triggers Claude thinking — thinking content streams progressively instead of just "Thinking..."
    3. When thinking finishes, message shows thinking content + "Thought for X.Xs" footer
    4. Long thinking content is truncated from the front and displayed in an expandable blockquote
    5. Short thinking content displays inline as italic text
    6. Multiple thinking blocks in one response each get their own message with content
    7. Text and tool messages after thinking still render correctly
    8. No Telegram API rate limit errors during normal use
