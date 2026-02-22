# Completed: Edit last prompt via reply (#26)

## Changes

### `src/bot.ts`
- Added `promptHistory: Map<number, string>` to `UserState` with bounded storage (max 50 entries, FIFO eviction)
- `buildPromptWithReplyContext` now skips the `[Replying to: ...]` prefix when replying to own messages — sends new text as standalone prompt
- `handlePrompt` creates a "Retry" inline button on every bot response, stores the prompt keyed by bot response message ID
- New `retry:` callback handler re-sends stored prompts through `handlePrompt`; shows "Prompt expired" if evicted

### `src/telegram.ts`
- `StreamResult` now includes `messageId` (last text message ID)
- `streamToTelegram` accepts `StreamOptions` with optional `replyMarkup: InlineKeyboard`
- `safeEditMessage` passes `reply_markup` through to `editMessageText` when provided
- Final message edit attaches the inline keyboard from options

## Behavior
- Every bot response gets a "Retry" button that re-sends the original prompt
- Replying to your own previous message sends the new text as a fresh prompt (no reply context prefix)
- Replying to bot messages still includes `[Replying to: ...]` context as before
