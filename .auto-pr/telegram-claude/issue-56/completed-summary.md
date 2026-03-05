# Completed: Fix plan display truncation (#56)

## Changes

1. **Added `splitText()` utility** (`src/telegram.ts`): Exported function that splits text into chunks fitting within Telegram's 4000-char limit, preferring newline boundaries (falls back to hard cut if no newline found in the last 50%).

2. **Updated `presentPlan()`** (`src/bot.ts`): Replaced the truncation logic (`maxLen` + `... (truncated)`) with `splitText()` — long plans are now sent as multiple sequential messages. The inline keyboard buttons still appear after all plan chunks.

## Verification

- `bun run lint` passes (all warnings are pre-existing)
- `tsc --noEmit` passes
- No other code references the removed truncation logic
