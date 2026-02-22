# Plan: Edit last prompt via reply (#26)

## Summary

Users currently have no way to edit and re-send a prompt — they must retype entirely. This adds two mechanisms: (1) replying to your own message treats the reply text as a standalone prompt (edit-and-resend), and (2) a "Retry" inline button on bot responses re-sends the original prompt. Both use existing session continuity.

## Approach

Two changes to message routing in `bot.ts`, plus a "Retry" button plumbed through `telegram.ts`:

1. **Reply-to-self detection** — `buildPromptWithReplyContext` checks if the replied-to message is from the same user. If so, returns the new text as-is (no `[Replying to: ...]` wrapper).
2. **Retry button** — `handlePrompt` stores `botMessageId → prompt` in a bounded map. `streamToTelegram` attaches an `InlineKeyboard` with "Retry" to the final message. A new callback handler re-sends the stored prompt.

## Architectural decisions

**Prompt storage**: Bounded `Map<number, string>` (messageId → prompt) scoped per-user inside `UserState`. Max 50 entries with oldest-first eviction. Per-user scoping keeps it clean and avoids cross-user leaks.

**Button attachment point**: Pass `InlineKeyboard` into `streamToTelegram` via new `options` parameter. `safeEditMessage` gains an optional `reply_markup` param. The keyboard is attached only on the final edit (the one with the footer).

**Return messageId**: `StreamResult` gains `messageId` field so `handlePrompt` can register the prompt mapping after streaming completes.

## Key code snippets

### 1. UserState change (`bot.ts`)
```ts
type UserState = {
  activeProject: string
  sessions: Map<string, string>
  pinnedMessageId?: number
  promptHistory: Map<number, string> // messageId → prompt
}
```

### 2. Bounded prompt storage helper (`bot.ts`)
```ts
const MAX_PROMPT_HISTORY = 50

function storePrompt(state: UserState, messageId: number, prompt: string) {
  state.promptHistory.set(messageId, prompt)
  if (state.promptHistory.size > MAX_PROMPT_HISTORY) {
    const oldest = state.promptHistory.keys().next().value
    state.promptHistory.delete(oldest!)
  }
}
```

### 3. Reply-to-self detection (`bot.ts`)
```ts
function buildPromptWithReplyContext(ctx: Context, userText: string) {
  const reply = ctx.message?.reply_to_message
  if (!reply?.text) return userText
  // Reply to own message = edit-and-resend (send new text as standalone prompt)
  if (reply.from?.id === ctx.from?.id) return userText
  const truncated = reply.text.length > 2000 ? reply.text.slice(0, 2000) + "..." : reply.text
  return `[Replying to: ${truncated}]\n\n${userText}`
}
```

### 4. StreamResult & streamToTelegram signature (`telegram.ts`)
```ts
type StreamResult = {
  sessionId?: string
  cost?: number
  durationMs?: number
  turns?: number
  messageId?: number
}

type StreamOptions = {
  replyMarkup?: InlineKeyboard
}

export async function streamToTelegram(
  ctx: Context,
  events: AsyncGenerator<ClaudeEvent>,
  projectName: string,
  options?: StreamOptions,
): Promise<StreamResult>
```

### 5. safeEditMessage with reply_markup (`telegram.ts`)
```ts
async function safeEditMessage(
  ctx: Context, chatId: number, messageId: number,
  text: string, rawText?: string, replyMarkup?: InlineKeyboard,
) {
  const displayText = text || "..."
  const opts: Record<string, unknown> = { parse_mode: "HTML" }
  if (replyMarkup) opts.reply_markup = replyMarkup
  try {
    await ctx.api.editMessageText(chatId, messageId, displayText, opts)
    return true
  } catch (err: any) {
    // ... existing fallback logic
  }
}
```

### 6. Final message edit with retry button (`telegram.ts`, around line 276)
```ts
if (lastTextMessageId && accumulated) {
  const html = markdownToTelegramHtml(accumulated)
  const footer = formatFooter(projectName, result)
  const display = footer ? `${html}\n\n${footer}` : html
  const ok = await safeEditMessage(ctx, chatId, lastTextMessageId, display || "...", undefined, options?.replyMarkup)
  // ... existing fallback
}
// ...
result.messageId = lastTextMessageId
return result
```

### 7. handlePrompt stores prompt & passes retry button (`bot.ts`)
```ts
async function handlePrompt(ctx: Context, prompt: string) {
  // ... existing project/session logic ...
  const retryKeyboard = new InlineKeyboard().text("Retry", "retry:pending")
  const events = runClaude(ctx.from!.id, prompt, state.activeProject, ctx.chat!.id, sessionId)
  const result = await streamToTelegram(ctx, events, projectName, { replyMarkup: retryKeyboard })

  if (result.sessionId) {
    state.sessions.set(state.activeProject, result.sessionId)
  }
  if (result.messageId) {
    storePrompt(state, result.messageId, prompt)
    // Update callback data now that we know the message ID
    await ctx.api.editMessageReplyMarkup(ctx.chat!.id, result.messageId, {
      reply_markup: new InlineKeyboard().text("Retry", `retry:${result.messageId}`),
    }).catch(() => {})
  }
}
```

### 8. Retry callback handler (`bot.ts`)
```ts
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

## Scope boundaries

- **In scope**: Reply-to-self as edit-resend, retry button on bot responses, bounded prompt history.
- **Out of scope**: Editing the prompt text inline (Telegram doesn't support pre-filled message editing). No "edit" UI — user must type the corrected prompt as a reply. No retry for voice/file messages beyond storing the final text prompt.

## Risks

1. **`editMessageReplyMarkup` after final edit**: The second edit to update `retry:pending` → `retry:<id>` could fail if the message was already modified or rate-limited. The `.catch(() => {})` handles this gracefully — worst case the button just doesn't work for that message.
2. **Callback data `retry:pending`**: If user clicks the button in the brief window before the ID is updated, it won't match the `\d+` regex and will be silently ignored. Acceptable UX trade-off vs. alternatives.
3. **Memory**: 50 prompts per user × prompt size. With a single allowed user, this is negligible. If multi-user support is added later, the per-user bound keeps it safe.

## Alternative approaches

**1. Store prompt in callback data directly** — Encode the prompt (or hash) in the callback button data. Won't work: Telegram limits callback data to 64 bytes, prompts can be thousands of chars.

**2. Two-phase button (placeholder then update)** — The chosen approach. Slightly complex but avoids needing to know the message ID before streaming completes. Preferred because `streamToTelegram` doesn't know the final message ID until the end.

**3. Pass prompt map into `streamToTelegram`** — Have `streamToTelegram` directly register the prompt. Rejected: leaks bot-level state into the streaming layer, worse separation of concerns.

**4. Use Telegram's native "edit message" feature** — Telegram doesn't allow bots to edit user messages or pre-fill the compose box. Not possible via Bot API.
