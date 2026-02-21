# Implementation Checklist: Message queuing when Claude is busy

- [x] **Task 1: Add queue types and state to `UserState`**
  - Files: `src/bot.ts`
  - Changes:
    - Add `QueuedMessage` type above `UserState`: `type QueuedMessage = { prompt: string; ctx: Context }`
    - Extend `UserState` with two new fields: `queue: QueuedMessage[]` and `queueStatusMessageId?: number`
    - Update `getState()` (line 42) to initialize `queue: []` in the default state object
  - Acceptance: TypeScript compiles. `getState()` returns state with empty `queue` array.

- [x] **Task 2: Add `sendOrUpdateQueueStatus` and `cleanupQueueStatus` helpers**
  - Files: `src/bot.ts`
  - Changes:
    - Add `sendOrUpdateQueueStatus(ctx: Context, state: UserState)` function inside `createBot()` (after `handlePrompt`, before message handlers). It should:
      - Build text: `"Message queued (N in queue)"` where N = `state.queue.length`
      - Create `InlineKeyboard` with one button: `"Force Send — stops current task"` with callback data `force_send:${ctx.from!.id}`
      - If `state.queueStatusMessageId` exists, call `ctx.api.editMessageText()` to update it (`.catch(() => {})` to swallow errors if message was deleted)
      - Otherwise, call `ctx.reply()` and store `msg.message_id` in `state.queueStatusMessageId`
    - Add `cleanupQueueStatus(state: UserState, ctx: Context)` function that:
      - If `state.queueStatusMessageId` is set, delete the message via `ctx.api.deleteMessage()` (`.catch(() => {})`) and set it to `undefined`
  - Acceptance: Functions exist and compile. No runtime changes yet since nothing calls them.

- [x] **Task 3: Add `runAndDrain` function**
  - Files: `src/bot.ts`
  - Changes:
    - Add `runAndDrain(ctx: Context, prompt: string, state: UserState, userId: number)` async function inside `createBot()`. Logic:
      - Declare `let currentCtx = ctx` and `let currentPrompt = prompt`
      - Enter `while (true)` loop:
        - Get `sessionId` from `state.sessions.get(state.activeProject)`
        - Get `projectName` from `state.activeProject` (same logic as current `handlePrompt`)
        - `try`: call `runClaude(userId, currentPrompt, state.activeProject, currentCtx.chat!.id, sessionId)`, pass events to `streamToTelegram(currentCtx, events, projectName)`, store `result.sessionId` in `state.sessions` if truthy
        - `catch`: log error with `console.error("runAndDrain error:", e)`
        - After try/catch: if `state.queue.length === 0`, `break`
        - Otherwise: `const queued = state.queue.splice(0)` to drain all, combine prompts with `queued.map(q => q.prompt).join("\n\n---\n\n")`, set `currentCtx = queued[queued.length - 1].ctx`, call `await cleanupQueueStatus(state, currentCtx)`
  - Acceptance: Function compiles. Not yet called.

- [x] **Task 4: Rewrite `handlePrompt` to use queue and `runAndDrain`**
  - Files: `src/bot.ts`
  - Changes:
    - Replace the body of `handlePrompt()` (lines 305-322) with:
      - Keep the existing project check (lines 308-311)
      - Add: `const userId = ctx.from!.id`
      - Add: `if (hasActiveProcess(userId)) { state.queue.push({ prompt, ctx }); await sendOrUpdateQueueStatus(ctx, state); return }`
      - Replace the remaining lines (sessionId lookup, runClaude call, streamToTelegram, sessionId storage) with: `await runAndDrain(ctx, prompt, state, userId)`
  - Acceptance: Sending a message while Claude is idle works exactly as before. Sending a message while Claude is busy shows "Message queued (1 in queue)" with a Force Send button instead of the error. Queued messages are sent automatically when the current process finishes.

- [x] **Task 5: Add `force_send` callback query handler**
  - Files: `src/bot.ts`
  - Changes:
    - Add a callback query handler (alongside the existing `project:`, `history:`, `session:` handlers):
      ```
      bot.callbackQuery(/^force_send:(\d+)$/, async (ctx) => {
        const userId = parseInt(ctx.match![1], 10)
        const stopped = stopClaude(userId)
        await ctx.answerCallbackQuery({
          text: stopped ? "Stopping current task..." : "No active process",
        })
      })
      ```
    - No queue manipulation needed — stopping the process triggers `streamToTelegram()` to return, which causes the `runAndDrain` loop to drain queued messages automatically.
  - Acceptance: Pressing "Force Send" button stops the running Claude process. Queued messages are then sent as a combined prompt. The callback query toast says "Stopping current task...".

- [x] **Task 6: Update `/stop` command to clear queue**
  - Files: `src/bot.ts`
  - Changes:
    - Replace the `/stop` handler (lines 174-177) with:
      - `const userId = ctx.from!.id`
      - `const state = getState(userId)`
      - `const stopped = stopClaude(userId)`
      - `const hadQueue = state.queue.length > 0`
      - `state.queue = []`
      - `await cleanupQueueStatus(state, ctx)`
      - Build reply message: `stopped ? "Process stopped." + (hadQueue ? " Queue cleared." : "") : "No active process."`
      - `await ctx.reply(msg, { reply_markup: mainKeyboard })`
  - Acceptance: `/stop` stops the process AND clears any queued messages. Queue status message is deleted. Reply confirms both actions.

- [x] **Task 7: Update `/status` command to show queue count**
  - Files: `src/bot.ts`
  - Changes:
    - In the `/status` handler (lines 179-188), after the existing `sessionCount` variable:
      - Add `const queueSize = state.queue.length`
      - Append to the reply text: `+ (queueSize > 0 ? `\nQueued: ${queueSize}` : "")`
  - Acceptance: `/status` shows "Queued: N" line when messages are queued, omits it when queue is empty.

- [x] **Task 8: Update `/new` command to clear queue**
  - Files: `src/bot.ts`
  - Changes:
    - In the `/new` handler (lines 207-214), after `state.sessions.delete(state.activeProject)`:
      - Add `state.queue = []`
      - Add `await cleanupQueueStatus(state, ctx)`
  - Acceptance: `/new` clears the session AND any queued messages.

- [x] **Task 9: Clear queue on project switch**
  - Files: `src/bot.ts`
  - Changes:
    - In the `project:` callback query handler (lines 140-172), after `state.activeProject = fullPath` (line 157):
      - Add `state.queue = []`
      - Add `await cleanupQueueStatus(state, ctx)`
  - Acceptance: Switching projects clears any queued messages that were intended for the previous project.

- [x] **Task 10: Verify everything works together**
  - Files: all modified files (`src/bot.ts`)
  - Changes: Manual testing of all scenarios:
    1. Send message while idle — works as before (no regression)
    2. Send message while busy — shows "Message queued (1 in queue)" with Force Send button
    3. Send 2nd message while busy — edits status to "Message queued (2 in queue)"
    4. Wait for process to finish — queued messages auto-sent as combined prompt, queue status message deleted
    5. Press Force Send — stops running process, queued messages sent immediately
    6. `/stop` while messages queued — process stopped, queue cleared, status message deleted
    7. `/status` while messages queued — shows "Queued: N"
    8. `/new` while messages queued — session and queue cleared
    9. Switch project while messages queued — queue cleared
    10. Voice message while busy — transcription happens immediately, prompt is queued
    11. File upload while busy — file saved immediately, prompt is queued
  - Acceptance: All 11 scenarios pass. No TypeScript compilation errors.
