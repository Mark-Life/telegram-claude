# Message queuing when Claude is busy

> Mark-Life/telegram-claude#23

## Current Behavior
When a user sends a new message while Claude is processing, the message is **rejected** with error: "A Claude process is already running. Use /stop first." (`src/claude.ts:182`). The user must manually `/stop` and resend.

## Desired Behavior

### Message queuing
- Queue incoming messages while Claude is busy
- When Claude finishes, send all queued messages together as one combined prompt
- Show queue status to the user (e.g. "Message queued (2 in queue)")

### Force send
- Give user an option to **force send**: stop the running Claude process and immediately send the new message
- Useful when Claude is doing something wrong and user wants to course-correct
- UX: inline button on the "queued" reply, e.g. `[Force Send — stops current task]`