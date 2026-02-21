# Research: Message queuing when Claude is busy

## 1. Relevant Files

### Must modify

- **`src/claude.ts`** — Contains the rejection logic at lines 179-186. `runClaude()` checks `userProcesses` map; if a non-aborted entry exists, yields `{ kind: "error" }` and returns. This guard must be replaced with queuing logic. Also exports `stopClaude()` and `hasActiveProcess()` which are used by bot.ts.

- **`src/bot.ts`** — Contains `handlePrompt()` (line 305) which calls `runClaude()` and `streamToTelegram()`. All message handlers (`message:text`, `message:voice`, `message:document`, `message:photo`) funnel through `handlePrompt()`. This is where queue management and the "Force Send" inline button UX need to live. Also contains `UserState` type (line 10-14) which may need a queue field.

### Must read / may need minor changes

- **`src/telegram.ts`** — `streamToTelegram()` consumes `AsyncGenerator<ClaudeEvent>` and streams to Telegram. No direct changes needed unless the queued-messages-combined-prompt needs special display. The error event handling (line 258-263) currently shows the "already running" error — with queuing, this path would be replaced upstream.

- **`src/index.ts`** — Entry point. No changes needed.
- **`src/transcribe.ts`** — Voice transcription. No changes needed.
- **`src/history.ts`** — Session history. No changes needed.

## 2. Existing Patterns

### Per-user state management
- `bot.ts:userStates` — `Map<number, UserState>` where `UserState = { activeProject, sessions, pinnedMessageId? }`
- `claude.ts:userProcesses` — `Map<number, ProcessEntry>` where `ProcessEntry = { ac: AbortController, done: Promise<void> }`

### Process lifecycle in claude.ts
- `runClaude()` is an `AsyncGenerator<ClaudeEvent>` — it yields events as they come from the CLI
- One process per user enforced at line 179-186: if `existing` entry exists and `!existing.ac.signal.aborted`, error is yielded
- If existing entry IS aborted, it `await existing.done` to wait for cleanup, then proceeds
- Process cleanup at line 254-261: clears timeout, kills proc, awaits exit, deletes from `userProcesses`, resolves `done` promise

### Inline keyboard + callback query pattern
- Used for project selection: `InlineKeyboard` with `project:<name>` callback data (bot.ts:132-137)
- Used for history navigation: `session:<id>` and `history:<page>` callbacks (bot.ts:259-302)
- Pattern: `bot.callbackQuery(/^prefix:(.+)$/, async (ctx) => { ... })`

### Message handler pattern
All handlers follow the same flow:
```
message handler → build prompt string → handlePrompt(ctx, prompt)
  → runClaude(userId, prompt, projectDir, chatId, sessionId)
  → streamToTelegram(ctx, events, projectName)
  → store result.sessionId in state
```

### Error display
Errors from `runClaude()` surface as `{ kind: "error", message }` events. `streamToTelegram()` appends them as `[Error: ...]` to the accumulated text (telegram.ts:263).

## 3. Dependencies

- **grammy** (`^1.35.0`) — Telegram bot framework. Provides `InlineKeyboard` for inline buttons, `bot.callbackQuery()` for handling button presses, `ctx.reply()` / `ctx.api.editMessageText()` for messaging.
- **No new dependencies needed** — Grammy already supports inline keyboards and callback queries.

## 4. Potential Impact Areas

### handlePrompt flow changes
`handlePrompt()` currently fires off `runClaude()` immediately. With queuing:
- Need to check if a process is running before calling `runClaude()`
- If busy: store prompt in queue, reply with queue status + Force Send button
- When process finishes: check queue, combine all queued prompts, call `runClaude()` again

### Process completion hook
Currently `handlePrompt()` just `await`s `streamToTelegram()` and stores the sessionId. Need a mechanism to trigger processing the next queue batch after the current process finishes. Options:
- A) Make `handlePrompt()` loop: after `streamToTelegram()` returns, check queue, process next batch
- B) Separate queue processor function that runs after each `handlePrompt()` completion

### Combined prompt format
When draining the queue, multiple messages need to be combined. Need to decide format:
- Simple concatenation with separators: `"Message 1\n\n---\n\nMessage 2"`
- Or with context: `"[Follow-up 1]: ...\n\n[Follow-up 2]: ..."`

### Force Send callback
New callback query handler needed: `bot.callbackQuery(/^force_send:(.+)$/, ...)` that:
1. Calls `stopClaude(userId)` to abort current process
2. Waits for the process to finish (`existing.done`)
3. Takes the queued message(s) and sends them immediately via `handlePrompt()`

### Race conditions
- User sends message A (starts processing) → sends B (queued) → sends C (queued) → clicks Force Send on B
  - Should Force Send send just B, or B+C combined?
  - The issue says "stop the running Claude process and immediately send the new message" — implies send all queued
- User sends message while queue drain is in progress (between old process ending and new one starting)
- Multiple rapid Force Send clicks

### The `done` promise pattern
`claude.ts` already has `ProcessEntry.done` — a promise that resolves when process cleanup finishes. This is key for queue draining: after `streamToTelegram()` returns, `done` will have resolved, so `runClaude()` for the next batch can proceed cleanly.

## 5. Edge Cases and Constraints

- **Voice messages while busy**: Voice messages go through transcription first, then `handlePrompt()`. The transcription should still happen immediately; only the prompt submission should be queued.
- **File uploads while busy**: Documents and photos are saved to disk first, then prompt is built. File saving should happen immediately; queuing happens at the prompt level.
- **Project switching while queue has items**: If user switches projects while messages are queued, queued messages should probably still go to the original project. Or: clear queue on project switch.
- **`/new` while queue has items**: Clearing the session while messages are queued — should the queue be cleared too?
- **`/stop` while queue has items**: Should `/stop` also clear the queue, or just stop the current process (which would trigger queue drain)?
- **Queue size limit**: Should there be a max queue size to prevent accidental spam?
- **Telegram message for queue status**: The "Message queued (2 in queue)" reply needs a message ID stored so it can be edited when queue count changes, and needs the Force Send inline button.
- **Callback data size**: Telegram limits callback data to 64 bytes. The Force Send button data needs to fit — `force_send:<userId>` is fine.

## 6. Reference Implementations

### Inline keyboard + callback pattern (project selection)
`bot.ts:132-172`:
```typescript
const keyboard = new InlineKeyboard()
keyboard.text("General (all projects)", "project:__general__").row()
for (const name of projects) {
  keyboard.text(name, `project:${name}`).row()
}
await ctx.reply("Select a project:", { reply_markup: keyboard })

// Handler:
bot.callbackQuery(/^project:(.+)$/, async (ctx) => {
  const name = ctx.match![1]
  // ... handle selection
  await ctx.answerCallbackQuery({ text: `Switched to ${name}` })
})
```

### Process abort + await pattern
`claude.ts:265-270` (`stopClaude`) and `claude.ts:179-186` (checking existing):
```typescript
// Stop:
const entry = userProcesses.get(telegramUserId)
if (!entry || entry.ac.signal.aborted) return false
entry.ac.abort()
return true

// Wait for aborted process to finish:
if (existing.ac.signal.aborted) {
  await existing.done
}
```

### Where queue state should live
Following the existing pattern, queue state should be in `bot.ts` alongside `userStates`, since it's per-user UI state. The queue is an array of `{ prompt: string, ctx: Context, statusMessageId: number }` entries. `claude.ts` doesn't need to know about queuing — it just needs the rejection logic removed (or turned into a check that `bot.ts` calls before invoking `runClaude`).

### Proposed architecture
1. Add `queue: Array<QueuedMessage>` to `UserState` in `bot.ts`
2. In `handlePrompt()`: check `hasActiveProcess(userId)` before calling `runClaude()`
   - If busy: push to queue, reply with status + Force Send button
   - If not busy: call `runClaude()` directly, then after completion drain queue
3. Remove the rejection guard from `runClaude()` in `claude.ts` (or keep it as a safety net)
4. Add `force_send` callback handler that calls `stopClaude()`, awaits process completion, then triggers immediate queue drain
5. Queue drain: combine all queued prompts into one, call `handlePrompt()` recursively (with a flag to avoid re-queuing)
