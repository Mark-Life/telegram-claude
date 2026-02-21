# Implementation Checklist: Auto-unpin old project messages on project switch

- [x] **Task 1: Remove `pinnedMessageId` from `UserState` type**
  - Files: `src/bot.ts`
  - Changes: Remove `pinnedMessageId?: number` (L13) from the `UserState` type definition at L10-14
  - Acceptance: `UserState` type has only `activeProject` and `sessions` fields. TypeScript compiles without errors.

- [x] **Task 2: Replace targeted unpin with `unpinAllChatMessages` in project switch callback**
  - Files: `src/bot.ts`
  - Changes: In the `bot.callbackQuery(/^project:(.+)$/, ...)` handler (L140-172):
    - Replace L164-166 (`if (state.pinnedMessageId) { await ctx.api.unpinChatMessage(...) }`) with `await ctx.api.unpinAllChatMessages(chatId).catch(() => {})`
    - Remove `state.pinnedMessageId = pinnedId` from L170 (inside the `if (pinnedId)` block at L168-171)
  - Acceptance: On project switch, all pinned messages in the chat are unpinned before the new project message is pinned. No reference to `pinnedMessageId` remains in this handler.

- [x] **Task 3: Replace targeted unpin with `unpinAllChatMessages` in session resume callback**
  - Files: `src/bot.ts`
  - Changes: In the `bot.callbackQuery(/^session:(.+)$/, ...)` handler (L275-302):
    - Replace L294-296 (`if (state.pinnedMessageId) { await ctx.api.unpinChatMessage(...) }`) with `await ctx.api.unpinAllChatMessages(chatId).catch(() => {})`
    - Remove `state.pinnedMessageId = pinnedId` from L300 (inside the `if (pinnedId)` block at L298-301)
  - Acceptance: On session resume, all pinned messages are unpinned before the new session message is pinned. No reference to `pinnedMessageId` remains in this handler.

- [x] **Task 4: Verify no remaining references to `pinnedMessageId`**
  - Files: `src/bot.ts` (and grep across entire `src/` directory)
  - Changes: Search for any leftover references to `pinnedMessageId` in the codebase. There should be zero occurrences after Tasks 1-3.
  - Acceptance: `grep -r "pinnedMessageId" src/` returns no results.

- [ ] **Task 5: Verify everything works together**
  - Files: `src/bot.ts`
  - Changes: No code changes. Verify:
    1. `bun run src/index.ts` starts without errors
    2. TypeScript compilation succeeds (no type errors from removed field)
    3. Manual test scenario: switch between two projects — only the latest project message should be pinned, previous pin is removed
    4. Manual test scenario: resume a session from history — previous pin is removed, new session message is pinned
    5. Manual test scenario: restart the bot, then switch project — stale pins from before restart are cleared
  - Acceptance: Bot starts cleanly, only one pinned message exists at any time regardless of project switches or bot restarts.
