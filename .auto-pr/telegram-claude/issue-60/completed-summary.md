# Completed: Forum Topics Mode

## Summary

Added dual-mode support to the Telegram Claude bot: **private chat mode** (existing, unchanged) and **forum/topics mode** (new). When `ALLOWED_CHAT_ID` is set to a negative supergroup ID, the bot operates in forum mode where each project gets its own Telegram forum topic, enabling parallel Claude sessions.

## Key Changes

### New Files
- **`src/topics.ts`** — Topic-project mapping with persistence to `.data/topics.json`. Creates forum topics via Telegram API, bidirectional lookup (threadId ↔ projectPath).

### Modified Files
- **`src/index.ts`** — Parses `ALLOWED_CHAT_ID`, derives `forumMode`, loads topic mappings, passes new params to `createBot()`.
- **`src/bot.ts`** — Dual-mode state keying (`getStateKey`), thread-aware replies (`replyToCtx`), General topic as control plane, `/chatid` command (unprotected), forum-aware `/projects` (creates topics), forum-aware `/status` and `/stop` (cross-topic overview).
- **`src/claude.ts`** — Renamed `telegramUserId` → `processKey` for dual semantics. Added `getActiveProcessKeys()` for cross-topic status.
- **`src/telegram.ts`** — Added `threadId` to `StreamOptions`, all outgoing messages include `message_thread_id` when in forum mode. Unique `draftId` per topic for parallel streams.
- **`src/state.ts`** — Forum mode persistence format: `{ forumMode: true, topics: { [threadId]: { activeProject, sessions } } }`. Backwards-compatible with private mode format.
- **`.env.example`** — Added `ALLOWED_CHAT_ID` documentation.

## Architecture

- **State keying**: `getStateKey(ctx)` returns `threadId` in forum mode, `userId` in private mode
- **Process isolation**: Each topic gets its own Claude process (keyed by threadId)
- **General topic**: Acts as control plane — commands work, text/media rejected with helpful message
- **Project topics**: Messages route to the mapped project automatically
- **Persistence**: Topic mappings in `.data/topics.json`, per-topic state in `.data/state.json`

## Verification

- `bun run lint` passes (no new warnings introduced; all 52 warnings are pre-existing in scripts/ and other files)
- Private mode fully backward-compatible (no behavior changes when `ALLOWED_CHAT_ID` unset)
