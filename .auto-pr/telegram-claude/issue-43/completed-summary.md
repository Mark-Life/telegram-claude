# Completed: Fix session ID loss on Force Send (abort)

## Problem
When a user clicked "Force Send" to interrupt a running Claude process, the session ID was lost because it was only captured from the `result` event — which never arrives when the process is aborted. This caused the next message to start a fresh conversation instead of continuing the existing session.

## Changes

### `src/claude.ts`
- Added `session_init` variant to `ClaudeEvent` union type: `{ kind: "session_init"; sessionId: string }`
- Added parser branch in `createStreamParser` to yield `session_init` when a `system.init` StreamEvent is received (this event arrives early in the stream, before any content)

### `src/telegram.ts`
- Added handler for `session_init` in `streamToTelegram`'s event loop that sets `result.sessionId` immediately when the stream starts
- If the `result` event arrives later (normal completion), it overwrites with the same value; if aborted, the early value persists

### No changes needed
- `src/bot.ts` — the existing `if (result.sessionId)` check works because `streamToTelegram` now always returns the session ID
