# Implementation Checklist: Edit last prompt via reply (#26)

- [ ] **Task 1: Add `promptHistory` to UserState and create bounded storage helper**
  - Files: `src/bot.ts`
  - Changes:
    - Add `promptHistory: Map<number, string>` to the `UserState` type (line 10-14)
    - Initialize `promptHistory: new Map()` in `getState()` (line 42)
    - Add constant `const MAX_PROMPT_HISTORY = 50` after `HISTORY_PAGE_SIZE`
    - Add `storePrompt(state: UserState, messageId: number, prompt: string)` function that sets the entry and evicts the oldest when size exceeds `MAX_PROMPT_HISTORY` (use `state.promptHistory.keys().next().value` to get oldest key)
  - Acceptance: TypeScript compiles. `UserState` has `promptHistory` field. `storePrompt` adds entries and evicts oldest when over 50.

- [ ] **Task 2: Modify `buildPromptWithReplyContext` for reply-to-self detection**
  - Files: `src/bot.ts`
  - Changes:
    - In `buildPromptWithReplyContext` (line 31-36), after the `if (!replyText) return userText` check, add: `if (ctx.message?.reply_to_message?.from?.id === ctx.from?.id) return userText` — this returns the new text as-is when replying to own message (edit-and-resend behavior), skipping the `[Replying to: ...]` wrapper
    - The existing behavior (wrapping reply context) remains for replies to bot messages or any other messages
  - Acceptance: Replying to own message sends the new text as a standalone prompt. Replying to bot/other messages still prepends `[Replying to: ...]`.

- [ ] **Task 3: Add `messageId` to `StreamResult` and `replyMarkup` option to `streamToTelegram`**
  - Files: `src/telegram.ts`
  - Changes:
    - Add `messageId?: number` to the `StreamResult` type (line 123-128)
    - Add `import { type InlineKeyboard } from "grammy"` to imports (line 1)
    - Add a new type: `type StreamOptions = { replyMarkup?: InlineKeyboard }`
    - Change `streamToTelegram` signature (line 133-137) to accept a 4th parameter `options?: StreamOptions`
    - At the end of the function (before `return result`, line 291), set `result.messageId = lastTextMessageId || undefined`
  - Acceptance: `streamToTelegram` accepts options param. Returned `StreamResult` includes the `messageId` of the last text message.

- [ ] **Task 4: Pass `replyMarkup` through `safeEditMessage` to the final message edit**
  - Files: `src/telegram.ts`
  - Changes:
    - Add optional `replyMarkup?: InlineKeyboard` parameter to `safeEditMessage` (line 106). Update both `editMessageText` calls inside it: when `replyMarkup` is provided, pass `reply_markup: replyMarkup` in the options object alongside `parse_mode`
    - In the final edit block (line 276-284), pass `options?.replyMarkup` as the `replyMarkup` argument to `safeEditMessage`: change `await safeEditMessage(ctx, chatId, lastTextMessageId, display || "...")` to `await safeEditMessage(ctx, chatId, lastTextMessageId, display || "...", undefined, options?.replyMarkup)`
  - Acceptance: When `replyMarkup` is provided in `StreamOptions`, the final bot response message has an inline keyboard attached.

- [ ] **Task 5: Wire up retry button in `handlePrompt` — create keyboard, pass to stream, store prompt after**
  - Files: `src/bot.ts`
  - Changes:
    - In `handlePrompt` (line 305-322):
      - Create `const retryKeyboard = new InlineKeyboard().text("Retry", "retry:pending")`
      - Pass it to `streamToTelegram`: `await streamToTelegram(ctx, events, projectName, { replyMarkup: retryKeyboard })`
      - After streaming, if `result.messageId` is truthy:
        - Call `storePrompt(state, result.messageId, prompt)`
        - Call `ctx.api.editMessageReplyMarkup(ctx.chat!.id, result.messageId, { reply_markup: new InlineKeyboard().text("Retry", \`retry:${result.messageId}\`) }).catch(() => {})` to update the placeholder callback data with the real message ID
  - Acceptance: Bot responses have a "Retry" button. Prompt is stored in `promptHistory` keyed by the bot's response message ID.

- [ ] **Task 6: Add retry callback handler**
  - Files: `src/bot.ts`
  - Changes:
    - Add a new callback query handler after the existing `session:*` handler (after line 302):
      ```
      bot.callbackQuery(/^retry:(\d+)$/, async (ctx) => {
        const msgId = parseInt(ctx.match![1], 10)
        const state = getState(ctx.from!.id)
        const prompt = state.promptHistory.get(msgId)
        if (!prompt) {
          await ctx.answerCallbackQuery({ text: "Prompt expired" })
          return
        }
        await ctx.answerCallbackQuery({ text: "Retrying..." })
        handlePrompt(ctx, prompt).catch((e) => console.error("retry handlePrompt error:", e))
      })
      ```
    - This re-sends the stored prompt through `handlePrompt`, which uses the current session state
  - Acceptance: Clicking "Retry" on a bot response re-sends the original prompt. Shows "Prompt expired" if the prompt was evicted from history.

- [ ] **Task 7: Verify everything works together**
  - Files: all modified (`src/bot.ts`, `src/telegram.ts`)
  - Changes: Manual testing checklist:
    1. TypeScript compiles without errors (`bun run src/index.ts` starts successfully)
    2. Send a text message — bot responds with a "Retry" button on the final message
    3. Click "Retry" — bot re-sends the same prompt and responds again with a new "Retry" button
    4. Reply to your own previous message with new text — the new text is sent as a standalone prompt (no `[Replying to: ...]` prefix)
    5. Reply to a bot message — the reply context prefix is still included
    6. Voice/document/photo messages — bot responds with "Retry" button (since they all go through `handlePrompt`)
    7. Click "Retry" on an old message after 50+ newer prompts — shows "Prompt expired"
    8. `/new` then "Retry" — retries with a fresh session (no crash)
  - Acceptance: All 8 test scenarios pass.
