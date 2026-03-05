# Completed: Memory optimization — cleanup stale data

## Changes

1. **Compose messages cap** (`src/bot.ts`): Added `MAX_COMPOSE_MESSAGES = 50` limit. When reached, bot replies with a warning and rejects further messages until user sends or clears.

2. **Session cache cleanup** (`src/history.ts`): Exported `clearSessionCache()` to allow periodic clearing of the unbounded `sessionProjectCache` Map.

3. **Stale state cleanup function** (`src/bot.ts`): Added `cleanupStaleState()` export that clears idle compose state (users with compose messages but empty queues), clears the session cache, and logs memory usage (RSS + heap).

4. **Periodic cleanup timer** (`src/index.ts`): Runs `cleanupStaleState()` every 3 hours via `setInterval`. Timer is cleared on shutdown before stopping the bot.

## Verification

- Lint passes (no new warnings)
- TypeScript type check passes
- All imports resolve correctly with no circular dependencies
