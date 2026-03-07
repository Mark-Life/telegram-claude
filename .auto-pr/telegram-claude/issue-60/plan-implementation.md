# Implementation Checklist: Forum Topics Mode

- [x] **Task 1: Add `ALLOWED_CHAT_ID` env var and forum mode detection**
  - Files: `src/index.ts`, `.env.example`
  - Changes:
    - In `.env.example`, add `ALLOWED_CHAT_ID=` line with comment explaining optional forum mode
    - In `src/index.ts`, parse `ALLOWED_CHAT_ID` from env (default to `ALLOWED_USER_ID` if unset), derive `forumMode = ALLOWED_CHAT_ID < 0`
    - Pass `chatId` and `forumMode` to `createBot()`
    - Change startup message: if `forumMode`, send to `ALLOWED_CHAT_ID` (General topic, no `message_thread_id`); else send to `ALLOWED_USER_ID` as before
  - Acceptance: Bot starts in private mode when `ALLOWED_CHAT_ID` unset. Bot starts in forum mode when `ALLOWED_CHAT_ID` is negative. Startup message goes to correct chat.

- [x] **Task 2: Add `/chatid` command (unprotected)**
  - Files: `src/bot.ts`, `src/index.ts`
  - Changes:
    - In `bot.ts`, register `bot.command("chatid", ...)` **before** the access control middleware (~line 167). Handler replies with `` `Chat ID: ${ctx.chat.id}` `` using HTML parse mode
    - In `src/index.ts`, add `chatid` to the `setMyCommands` list with description "Show chat ID"
  - Acceptance: `/chatid` works in any chat (including groups where the bot isn't configured), returns the numeric chat ID. Does not require the user to be `ALLOWED_USER_ID`.

- [x] **Task 3: Create `src/topics.ts` — topic-project mapping**
  - Files: `src/topics.ts` (new file)
  - Changes:
    - Define `TopicMapping` type: `{ threadId: number, projectPath: string, projectName: string }`
    - Module-level `topicMappings: TopicMapping[]` array
    - `loadTopicMappings()` — reads from `.data/topics.json`, validates file exists
    - `saveTopicMappings()` — atomic write to `.data/topics.json` (same pattern as `state.ts`)
    - `ensureTopic(api, chatId, projectPath)` — finds existing mapping or creates new forum topic via `api.createForumTopic(chatId, basename(projectPath))`, persists mapping, returns `threadId`
    - `getProjectForThread(threadId)` — returns `projectPath | undefined` from mappings
    - `getThreadForProject(projectPath)` — returns `threadId | undefined` from mappings
    - `getAllTopicMappings()` — returns the full array (for `/projects` listing)
  - Acceptance: Topic mappings persist across restarts via `.data/topics.json`. `ensureTopic` creates a Telegram forum topic and stores the mapping. Lookup functions work bidirectionally.

- [x] **Task 4: Update `createBot` signature and state model for dual-mode**
  - Files: `src/bot.ts`
  - Changes:
    - Change `createBot` signature: add `chatId: number` and `forumMode: boolean` parameters
    - Add helper `getStateKey(ctx)`: returns `ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? 0` in forum mode, `ctx.from!.id` in private mode
    - Add helper `getThreadId(ctx)`: returns `ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id` in forum mode, `undefined` in private mode
    - Update all `getState(ctx.from!.id)` calls to use `getState(getStateKey(ctx))` — this affects command handlers, `handlePrompt`, compose middleware, callback handlers
    - In forum mode + project topic: set `state.activeProject` from `getProjectForThread(threadId)` instead of requiring `/projects` selection
  - Acceptance: State is correctly keyed by threadId in forum mode and userId in private mode. Each topic maintains independent state (activeProject, sessions, queue, composeMessages).

- [x] **Task 5: Update `src/claude.ts` — process key from userId to generic key**
  - Files: `src/claude.ts`
  - Changes:
    - Rename `telegramUserId` parameter to `processKey` in `runClaude`, `stopClaude`, `hasActiveProcess` signatures
    - No structural changes to the `Map<number, ProcessEntry>` — just the semantic meaning of the key changes (userId in private mode, threadId in forum mode)
    - Update JSDoc on exported functions to document the dual semantics
  - Acceptance: `runClaude(threadId, ...)` in forum mode allows parallel processes (different threadIds). `runClaude(userId, ...)` in private mode still enforces one-process-per-user. All callers pass the correct key.

- [x] **Task 6: Update `src/telegram.ts` — add `threadId` to all outgoing messages**
  - Files: `src/telegram.ts`
  - Changes:
    - Add `threadId?: number` to `StreamOptions` type
    - In `streamToTelegram`, extract `threadId` from options, build `threadOpts = threadId ? { message_thread_id: threadId } : {}`
    - Spread `...threadOpts` into every `ctx.api.sendMessage()`, `ctx.api.sendMessageDraft()`, and `ctx.api.sendChatAction()` call
    - For `sendMessageDraft`, use `threadId ?? chatId` as the `draftId` to avoid collisions between parallel streams
    - `editMessageText` does not need `message_thread_id` (it uses chatId + messageId which is already unique)
  - Acceptance: In forum mode, all streamed messages appear in the correct topic. Parallel streams to different topics don't interfere. Draft mode uses unique draftIds per topic. Private mode behavior unchanged (threadId undefined, no `message_thread_id` sent).

- [x] **Task 7: Update `src/bot.ts` message sending — thread-aware replies**
  - Files: `src/bot.ts`
  - Changes:
    - Add helper function `replyToCtx(ctx, text, other?)` that calls `ctx.reply(text, { ...other, ...(getThreadId(ctx) ? { message_thread_id: getThreadId(ctx) } : {}) })`
    - Replace all `ctx.reply(...)` calls (~20 occurrences) with `replyToCtx(ctx, ...)`
    - For `ctx.api.sendMessage(chatId, ...)` calls (startup, plan presentation), add `message_thread_id` from context where applicable
    - For `ctx.api.pinChatMessage` / `ctx.api.unpinAllChatMessages` — skip pinning in forum mode (topics provide natural navigation, pinning would be noisy)
    - For `sendChatAction` calls in bot.ts, add `message_thread_id` where needed
    - Pass `threadId` to `streamToTelegram` via options: `{ threadId: getThreadId(ctx) }`
    - Pass `getStateKey(ctx)` as `processKey` to `runClaude`, `stopClaude`, `hasActiveProcess`
  - Acceptance: All bot replies appear in the correct topic in forum mode. No stray messages in General topic. Pin/unpin skipped in forum mode. Private mode unchanged.

- [x] **Task 8: Update `src/bot.ts` — `/projects` command for forum mode**
  - Files: `src/bot.ts`
  - Changes:
    - In the `/projects` command handler, check `forumMode`:
      - Forum mode: list projects with inline keyboard. On project selection callback, call `ensureTopic(api, chatId, projectPath)` to create/get the topic, then reply with a message linking to the topic (use `t.me/c/{chatId}/{threadId}` format or just confirm topic creation)
      - Private mode: existing behavior unchanged (set activeProject, pin message)
    - In forum mode, `/projects` in General shows all projects; `/projects` in a project topic shows current project info
  - Acceptance: Selecting a project in forum mode creates a topic (or finds existing one). User can navigate to the topic. Private mode project selection unchanged.

- [ ] **Task 9: Update `src/bot.ts` — General topic control plane**
  - Files: `src/bot.ts`
  - Changes:
    - In forum mode, detect General topic messages: `threadId` is undefined/0
    - Commands in General: `/projects`, `/status`, `/stop`, `/help`, `/new` work as control plane
    - `/status` in General: show all active processes across all topics (iterate `userProcesses` map, resolve thread → project name via `getProjectForThread`)
    - `/stop` in General: show inline keyboard with all active processes, each button stops a specific topic's process
    - Non-command text in General: reply with "Send messages in a project topic. Use /projects to see available projects."
    - In project topics: route text/voice to that topic's project automatically via `getProjectForThread(threadId)`
  - Acceptance: General topic acts as control plane — commands work, text is rejected with helpful message. Project topics accept prompts and route to correct project. `/status` shows cross-topic overview.

- [ ] **Task 10: Update `src/state.ts` — forum mode persistence**
  - Files: `src/state.ts`
  - Changes:
    - Current `PersistedState` type: `{ activeProject, sessions }` — keep for private mode
    - Add forum mode variant: `{ forumMode: true, topics: Record<string, { activeProject: string, sessions: Record<string, string> }> }` where keys are stringified threadIds
    - Update `loadPersistedState` to detect format and return appropriate structure
    - Update save logic to persist all topic states when in forum mode
    - Export `forumMode` flag or accept it as parameter so state.ts knows which format to use
    - Call `loadTopicMappings()` from topics.ts during startup
  - Acceptance: Forum mode state persists per-topic activeProject and sessions across restarts. Private mode persistence unchanged. State file format is backwards-compatible.

- [ ] **Task 11: Update `src/index.ts` — wire everything together**
  - Files: `src/index.ts`
  - Changes:
    - Pass `ALLOWED_CHAT_ID` and `forumMode` to `createBot(token, allowedUserId, chatId, forumMode, projectsDir)`
    - Call `loadTopicMappings()` on startup (from topics.ts)
    - Update command list registration: add `chatid` command, and conditionally adjust descriptions for forum mode if needed
    - If forum mode, register commands with `scope` targeting the specific chat (optional — default scope works)
  - Acceptance: Bot initializes correctly in both modes. Topic mappings loaded on startup. All new parameters wired through.

- [ ] **Task 12: Handle callback queries with thread context**
  - Files: `src/bot.ts`
  - Changes:
    - In all callback query handlers (project selection `project:*`, compose `compose:*`, queue `queue:*`, plan `plan:*`, history `history:*`), extract `threadId` from `ctx.callbackQuery.message?.message_thread_id`
    - Use this `threadId` for state lookup (`getStateKey`), process key, and reply routing
    - Project selection callback in forum mode: call `ensureTopic()` instead of just setting `activeProject`
  - Acceptance: Inline button interactions in forum topics correctly route to the right state and reply in the right topic. No cross-topic state pollution.

- [ ] **Task 13: Handle media groups and voice messages with thread context**
  - Files: `src/bot.ts`
  - Changes:
    - `flushMediaGroup` calls `handlePrompt` — ensure it passes through the correct `ctx` with `message_thread_id`
    - Voice message handler: transcription result feeds into `handlePrompt` — thread context already in `ctx`, just verify `getStateKey` and `getThreadId` work for voice messages
    - Document handler (file uploads): same verification
  - Acceptance: Voice messages, photos, and documents sent in a project topic are routed to the correct project and responses appear in the same topic.

- [ ] **Task 14: Verify everything works together**
  - Files: All modified files
  - Changes: No code changes — testing and verification
  - Acceptance criteria:
    - **Private mode**: Bot works identically to before when `ALLOWED_CHAT_ID` is unset or positive. All existing features (projects, sessions, queue, compose, streaming, plans, history) work.
    - **Forum mode**: Bot detects forum mode from negative `ALLOWED_CHAT_ID`. `/chatid` works without auth. `/projects` creates topics. Messages in project topics route to correct project and stream responses within the topic. Parallel Claude processes run in different topics simultaneously. Queue works per-topic independently. Compose mode works per-topic. `/status` in General shows all active processes. State persists across restarts. Topic mappings persist across restarts.
    - **Lint**: `bun run lint` passes
    - **No regressions**: Private mode is fully backward-compatible
