# Completed: Message queuing when Claude is busy

## What was implemented

Messages sent while Claude is processing are now queued instead of rejected. When the running process finishes, all queued messages are automatically combined and sent as a single prompt.

### Changes (all in `src/bot.ts`)

1. **Queue state**: Added `QueuedMessage` type and `queue`/`queueStatusMessageId` fields to `UserState`
2. **Queue status UI**: `sendOrUpdateQueueStatus()` sends/edits a "Message queued (N in queue)" message with a "Force Send" inline button. `cleanupQueueStatus()` deletes it when no longer needed.
3. **runAndDrain loop**: After each Claude run completes, drains all queued messages into one combined prompt and loops until the queue is empty.
4. **handlePrompt rewrite**: Checks `hasActiveProcess()` — if busy, pushes to queue and shows status; if idle, calls `runAndDrain`.
5. **Force Send button**: `force_send:` callback query handler stops the active Claude process, causing `runAndDrain` to drain the queue immediately.
6. **Command updates**: `/stop` clears queue + deletes status message. `/status` shows queue count. `/new` clears queue. Project switch clears queue.
