# Research: Edit last prompt via reply (#26)

## Issue Summary

Allow user to reply to their own previous message to re-send an edited version of that prompt, using the same session. Optionally add an inline "Retry" button on the bot's response.

---

## 1. Relevant Files

| File | Role | Modification needed |
|---|---|---|
| `src/bot.ts` | Message routing, state management, callback handlers | **Yes** — change reply detection logic, add retry callback, store prompt history |
| `src/telegram.ts` | Streams Claude output to Telegram messages | **Yes** — attach "Retry" inline button to final response message |
| `src/claude.ts` | Spawns Claude CLI, yields streaming events | **No** — session resume already works via `-r sessionId` |
| `src/index.ts` | Entry point, env validation | **No** |
| `src/transcribe.ts` | Voice transcription | **No** |
| `src/history.ts` | Session listing/resume | **No** |

---

## 2. Existing Patterns

### Reply context handling (`bot.ts:31-36`)
```ts
function buildPromptWithReplyContext(ctx: Context, userText: string) {
  const replyText = ctx.message?.reply_to_message?.text
  if (!replyText) return userText
  const truncated = replyText.length > 2000 ? replyText.slice(0, 2000) + "..." : replyText
  return `[Replying to: ${truncated}]\n\n${userText}`
}
```
Currently prepends `[Replying to: ...]` for ALL replies regardless of whose message is being replied to. This is the primary function to modify — when the user replies to their own message, the new text should be sent as-is (standalone prompt), not wrapped in reply context.

### Session continuity (`bot.ts:305-322`)
`handlePrompt` reads `state.sessions.get(state.activeProject)` and passes it to `runClaude`. The session ID is stored after the result. This already provides session continuity — no changes needed for the "same session" requirement.

### Inline keyboard pattern (`bot.ts:131-137, 226-242`)
InlineKeyboard is already used extensively:
- `/projects` command creates buttons with `project:<name>` callback data
- `/history` command creates buttons with `session:<id>` and `history:<page>` callback data
- Callback handlers use `bot.callbackQuery(/^pattern:(.+)$/, handler)` regex matching

### Callback query handling (`bot.ts:140, 259, 275`)
Three existing callback handlers: `project:*`, `history:*`, `session:*`. New `retry:*` handler follows same pattern.

### Message text handler (`bot.ts:324-327`)
```ts
bot.on("message:text", (ctx) => {
  const prompt = buildPromptWithReplyContext(ctx, ctx.message.text)
  handlePrompt(ctx, prompt).catch(...)
})
```
All text messages flow through `buildPromptWithReplyContext` → `handlePrompt`.

### Final message editing with footer (`telegram.ts:276-289`)
The final text message gets a footer appended via `safeEditMessage`. The "Retry" button needs to be added here as `reply_markup` on the final edit.

---

## 3. Dependencies

- **grammy** — `InlineKeyboard` class already imported in `bot.ts`. `editMessageText` and `editMessageReplyMarkup` available on `ctx.api`.
- **Telegram Bot API constraints**:
  - Callback data: max 64 bytes. A `retry:<numericId>` pattern fits easily.
  - `editMessageText` accepts optional `reply_markup` for inline keyboards.
  - Can only edit messages sent by the bot itself.

---

## 4. Potential Impact Areas

### `buildPromptWithReplyContext` behavior change
Currently all replies get `[Replying to: ...]` prefix. After the change:
- Reply to **own message**: send new text as standalone prompt (edit-and-resend)
- Reply to **bot message**: keep current behavior (context prefix)
- Reply to **any other message**: keep current behavior

This requires access to `ctx.from.id` and `ctx.message.reply_to_message.from.id` — both available on the Context.

### Storing prompts for retry
Need a data structure to map a bot response message ID → original prompt text. Options:
- Add a `Map<number, string>` in `bot.ts` (messageId → prompt), bounded to prevent memory leak
- Pass the prompt through to `streamToTelegram` so it can attach the retry button with the right callback data
- Alternative: store in `UserState` type

Best approach: a bounded `Map<number, string>` in `bot.ts` (e.g., keep last 50 entries). The `streamToTelegram` function needs to return the `lastTextMessageId` (currently internal) so `handlePrompt` can map it.

### `streamToTelegram` signature change
Currently returns `StreamResult = { sessionId?, cost?, durationMs?, turns? }`. Need to either:
- Add `lastTextMessageId` to `StreamResult` so caller can register the retry mapping
- Pass an `InlineKeyboard` into `streamToTelegram` to attach on the final message
- Or pass a callback/messageId-to-prompt map into `streamToTelegram`

Cleanest: add `messageId` to `StreamResult` and have `streamToTelegram` accept an optional `InlineKeyboard` for the final message.

### Voice message and file upload handlers
`bot.ts:329-361` (voice) and `bot.ts:383-422` (document/photo) also call `handlePrompt`. The retry feature should work for these too — store the final prompt string (after transcription) for retry.

---

## 5. Edge Cases and Constraints

1. **Reply to own message detection**: `ctx.message.reply_to_message.from.id === ctx.from.id`. Must handle case where `reply_to_message.from` is undefined.

2. **Retry after session cleared**: If user does `/new` between the original prompt and retry, the session will have been cleared. Retry should use the current session state (whatever it is at retry time), not the original session. This is already handled naturally since `handlePrompt` reads session from state.

3. **Retry button on split messages**: When output exceeds 4000 chars, messages get split. The retry button should only appear on the very last message (which already gets the footer). `lastTextMessageId` in `telegram.ts` tracks this.

4. **Retry memory leak**: The prompt-to-messageId map must be bounded. An LRU or simple size check (delete oldest when >50 entries) prevents growth.

5. **Retry with active process**: If a Claude process is already running when retry is clicked, `runClaude` already yields an error event (`"A Claude process is already running"`). No special handling needed.

6. **Callback data size**: Telegram limits callback data to 64 bytes. `retry:123456789` is ~15 bytes — well within limits.

7. **Bot message ownership**: `editMessageReplyMarkup` can only modify bot's own messages. The retry button is added to the bot's response, so this is fine.

8. **Reply to forwarded messages**: `reply_to_message.from` could be the original sender for forwarded messages. Should check carefully — but in practice, in a private bot chat, forwarded messages are unlikely edge cases.

---

## 6. Reference Implementations

### Inline keyboard on response — existing pattern in `/projects` (`bot.ts:131-137`)
```ts
const keyboard = new InlineKeyboard()
keyboard.text("General (all projects)", "project:__general__").row()
for (const name of projects) {
  keyboard.text(name, `project:${name}`).row()
}
await ctx.reply("Select a project:", { reply_markup: keyboard })
```

### Callback handler — existing pattern (`bot.ts:140-172`)
```ts
bot.callbackQuery(/^project:(.+)$/, async (ctx) => {
  // ... handle callback
  await ctx.answerCallbackQuery({ text: "..." })
})
```

### Safe message editing with reply_markup — Grammy API
```ts
await ctx.api.editMessageText(chatId, messageId, text, {
  parse_mode: "HTML",
  reply_markup: new InlineKeyboard().text("Retry", `retry:${originalMsgId}`)
})
```

### `streamToTelegram` final edit (`telegram.ts:276-284`)
This is where the retry button attachment point would be — the final `safeEditMessage` call that adds the footer. `safeEditMessage` needs to accept an optional `reply_markup` parameter.
