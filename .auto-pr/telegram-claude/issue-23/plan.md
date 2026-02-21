# Plan: Message queuing when Claude is busy

## Summary

Currently, messages sent while Claude is processing are rejected with an error requiring the user to `/stop` and resend. This change adds a per-user message queue in `bot.ts` so incoming messages are held while Claude is busy, then combined into a single prompt when the process finishes. An inline "Force Send" button lets the user abort the running process and immediately send queued messages.

## Approach

Move the "is busy?" check from `claude.ts` into `bot.ts`'s `handlePrompt()`. When busy, push the prompt onto a queue and reply with a status message + Force Send button. After each `streamToTelegram()` completes, drain the queue in a loop: combine all queued prompts into one, call `runClaude()` again. The existing `stopClaude()` + natural drain handles Force Send with zero extra plumbing — stopping the process causes `streamToTelegram()` to return, which triggers the drain loop.

## Architectural decisions

**Queue lives in `bot.ts` alongside `UserState`** — follows existing pattern where per-user state is in `bot.ts` and `claude.ts` only manages processes. `claude.ts` doesn't need to know about queuing.

**Keep rejection guard in `claude.ts` as safety net** — `bot.ts` gates access via `hasActiveProcess()` so the guard never fires in normal flow. Keeping it prevents bugs from spawning concurrent processes.

**Combine queued messages into one prompt** — sending them individually would be slower and break conversational flow. A simple `\n\n---\n\n` separator is clear to Claude.

**Drain loop in a dedicated `runAndDrain()` function** — uses a `while` loop (not recursion) to process queue batches. After each `streamToTelegram()` returns, it checks the queue again. New messages arriving during drain get queued normally (since `hasActiveProcess()` returns true during drain).

**Force Send = just `stopClaude()`** — no special queue manipulation needed. Aborting the process causes `streamToTelegram()` to finish → drain loop picks up queued messages. The callback handler only needs to call `stopClaude()` and answer the query.

**Single editable queue status message** — one message per user that gets edited as queue grows ("Message queued (2 in queue)"). Stored as `queueStatusMessageId` in state. Deleted when drain starts.

## Key code snippets

### Updated `UserState` type (`bot.ts`)

```ts
type QueuedMessage = {
  prompt: string
  ctx: Context
}

type UserState = {
  activeProject: string
  sessions: Map<string, string>
  pinnedMessageId?: number
  queue: QueuedMessage[]
  queueStatusMessageId?: number
}
```

Initialize `queue: []` in `getState()`.

### Updated `handlePrompt()` (`bot.ts`)

```ts
async function handlePrompt(ctx: Context, prompt: string) {
  const state = getState(ctx.from!.id)

  if (!state.activeProject) {
    await ctx.reply("No project selected. Use /projects to pick one.", { reply_markup: mainKeyboard })
    return
  }

  const userId = ctx.from!.id

  if (hasActiveProcess(userId)) {
    state.queue.push({ prompt, ctx })
    await sendOrUpdateQueueStatus(ctx, state)
    return
  }

  await runAndDrain(ctx, prompt, state, userId)
}
```

### `runAndDrain()` — core loop (`bot.ts`)

```ts
async function runAndDrain(ctx: Context, prompt: string, state: UserState, userId: number) {
  let currentCtx = ctx
  let currentPrompt = prompt

  while (true) {
    const sessionId = state.sessions.get(state.activeProject)
    const projectName = state.activeProject === projectsDir ? "general" : basename(state.activeProject)

    try {
      const events = runClaude(userId, currentPrompt, state.activeProject, currentCtx.chat!.id, sessionId)
      const result = await streamToTelegram(currentCtx, events, projectName)
      if (result.sessionId) {
        state.sessions.set(state.activeProject, result.sessionId)
      }
    } catch (e) {
      console.error("runAndDrain error:", e)
    }

    if (state.queue.length === 0) break

    const queued = state.queue.splice(0)
    currentPrompt = queued.map((q) => q.prompt).join("\n\n---\n\n")
    currentCtx = queued[queued.length - 1].ctx
    await cleanupQueueStatus(state, currentCtx)
  }
}
```

### Queue status message (`bot.ts`)

```ts
async function sendOrUpdateQueueStatus(ctx: Context, state: UserState) {
  const count = state.queue.length
  const text = count === 1
    ? "Message queued (1 in queue)"
    : `Message queued (${count} in queue)`
  const keyboard = new InlineKeyboard()
    .text("Force Send — stops current task", `force_send:${ctx.from!.id}`)

  if (state.queueStatusMessageId) {
    await ctx.api.editMessageText(ctx.chat!.id, state.queueStatusMessageId, text, {
      reply_markup: keyboard,
    }).catch(() => {})
  } else {
    const msg = await ctx.reply(text, { reply_markup: keyboard })
    state.queueStatusMessageId = msg.message_id
  }
}

async function cleanupQueueStatus(state: UserState, ctx: Context) {
  if (state.queueStatusMessageId) {
    await ctx.api.deleteMessage(ctx.chat!.id, state.queueStatusMessageId).catch(() => {})
    state.queueStatusMessageId = undefined
  }
}
```

### Force Send callback handler (`bot.ts`)

```ts
bot.callbackQuery(/^force_send:(\d+)$/, async (ctx) => {
  const userId = parseInt(ctx.match![1], 10)
  const stopped = stopClaude(userId)
  await ctx.answerCallbackQuery({
    text: stopped ? "Stopping current task..." : "No active process",
  })
})
```

### `/stop` clears queue (`bot.ts`)

```ts
bot.command("stop", async (ctx) => {
  const userId = ctx.from!.id
  const state = getState(userId)
  const stopped = stopClaude(userId)
  const hadQueue = state.queue.length > 0
  state.queue = []
  await cleanupQueueStatus(state, ctx)
  const msg = stopped
    ? "Process stopped." + (hadQueue ? " Queue cleared." : "")
    : "No active process."
  await ctx.reply(msg, { reply_markup: mainKeyboard })
})
```

### `/status` shows queue (`bot.ts`)

Add queue count to status output:
```ts
const queueSize = state.queue.length
// Append: `\nQueued: ${queueSize}` when queueSize > 0
```

## Scope boundaries

- **No queue size limit** — single-user bot, not a concern. Can add later if needed.
- **No per-message project tracking** — queue is cleared on project switch (simpler than storing project per message).
- **No changes to `telegram.ts`** — combined prompts are just longer strings, no special handling needed.
- **No changes to `claude.ts`** — keep existing rejection guard as safety net; all queuing logic in `bot.ts`.
- **No special voice/file queue handling** — transcription and file saving happen immediately as today; only the final prompt is queued.

## Risks

- **Combined prompt length** — many queued messages could produce a very long prompt. Low risk for single-user bot; Claude handles long prompts well.
- **Error during drain** — if `streamToTelegram()` throws during drain, subsequent queued messages would be lost. Mitigated by the try/catch in `runAndDrain()` which continues draining even after errors.
- **`/stop` during drain** — `/stop` clears the queue and aborts the process. The drain loop's next iteration sees empty queue and exits. Need to ensure `/stop` sets `state.queue = []` before `stopClaude()` returns control, which it does since JS is single-threaded and `/stop` handler runs synchronously up to the await.
- **Stale `ctx` in queued messages** — queued `ctx` objects reference the original message context. Grammy `ctx` objects should remain valid for API calls (they just wrap the bot API). Low risk.

## Alternative approaches

**Sequential processing (one-by-one)** — process each queued message individually instead of combining. Slower, more API calls, breaks conversational flow. Combining is preferred because it mirrors how a human would read catch-up messages.

**Auto-stop and send** — always abort the running process and send the new message immediately. Loses the current response, which is destructive. Queuing is preferred because it preserves both the current response and follow-up messages; Force Send gives the user explicit control.

**Queue with confirmation** — reject the message but offer a "Queue this?" inline button. More clicks, worse UX. Auto-queuing is preferred because it's seamless — the user just keeps typing.

**Separate queue processor / event emitter** — decouple queue processing into its own event-driven system. Over-engineered for a single-user bot. The `runAndDrain()` loop is simpler, easier to reason about, and has no concurrency issues thanks to JS single-threading.
