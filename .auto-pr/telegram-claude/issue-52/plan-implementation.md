# Implementation Checklist: Memory optimization — cleanup stale data

- [x] **Task 1: Cap `composeMessages` array in `bot.ts`**
  - Files: `src/bot.ts`
  - Changes:
    - Add constant `const MAX_COMPOSE_MESSAGES = 50;` near the top (after existing constants around line 48)
    - In `collectComposeMessage()` (starts at line 919), add an early return guard before any processing: if `messages.length >= MAX_COMPOSE_MESSAGES`, reply with warning message (`Compose limit reached (${MAX_COMPOSE_MESSAGES} messages). Use /send to submit or /stop to clear.`) and return
  - Acceptance: When a user has 50 compose messages and sends another, bot replies with the limit warning and does not add the message. Normal compose flow works unaffected under 50 messages.

- [x] **Task 2: Export `clearSessionCache()` from `history.ts`**
  - Files: `src/history.ts`
  - Changes:
    - Add a new exported function after the `sessionProjectCache` declaration (line 18):
      ```typescript
      /** Clears the session-to-project cache */
      export function clearSessionCache() {
        sessionProjectCache.clear();
      }
      ```
  - Acceptance: `clearSessionCache` is exported from `history.ts` and calling it empties the `sessionProjectCache` Map.

- [x] **Task 3: Add `cleanupStaleState()` export to `bot.ts`**
  - Files: `src/bot.ts`
  - Changes:
    - Add import: `import { clearSessionCache } from "./history";` (extend existing import on line 17 to include `clearSessionCache`)
    - Add a new exported function (e.g. after `createBot` or at module level):
      ```typescript
      /** Clears stale compose state and logs memory usage */
      export function cleanupStaleState() {
        for (const [, state] of userStates) {
          if (state.composeMessages && state.queue.length === 0) {
            state.composeMessages = undefined;
            state.composeStatusMessageId = undefined;
          }
        }
        clearSessionCache();
        const mem = process.memoryUsage();
        console.log(
          `[cleanup] rss=${(mem.rss / 1024 / 1024).toFixed(1)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`
        );
      }
      ```
    - Note: `userStates` is module-level (line 48), so `cleanupStaleState` can access it directly as a module-level export
  - Acceptance: `cleanupStaleState` is exported from `bot.ts`. When called, it clears `composeMessages` and `composeStatusMessageId` on users with empty queues, calls `clearSessionCache()`, and logs memory usage to stdout.

- [ ] **Task 4: Add periodic cleanup timer in `index.ts`**
  - Files: `src/index.ts`
  - Changes:
    - Add import: `import { cleanupStaleState } from "./bot";` (extend existing import on line 1)
    - Add constant: `const CLEANUP_INTERVAL = 3 * 60 * 60 * 1000;` (3 hours)
    - After `bot.start(...)` resolves (after line 78), start the timer: `const cleanupTimer = setInterval(cleanupStaleState, CLEANUP_INTERVAL);`
    - In the `shutdown()` function (lines 34-44), add `clearInterval(cleanupTimer);` before `stopAll()` (before line 41)
  - Acceptance: Cleanup runs every 3 hours. On SIGTERM/SIGINT, the timer is cleared before bot shutdown. No orphaned intervals after shutdown.

- [ ] **Task 5: Verify everything works together**
  - Files: all modified files (`src/bot.ts`, `src/history.ts`, `src/index.ts`)
  - Changes: No code changes — verification only
    - Run `bun run lint` — no lint errors
    - Run `bun run build` or `bunx tsc --noEmit` — no type errors
    - Verify imports resolve correctly (no circular dependencies)
    - Manual review: confirm `cleanupStaleState` is callable from `index.ts`, `clearSessionCache` is callable from `bot.ts`, compose cap guard fires before message collection
  - Acceptance: Lint passes, types check, bot starts without errors (`bun run src/index.ts` — confirm startup message in logs, then stop).
