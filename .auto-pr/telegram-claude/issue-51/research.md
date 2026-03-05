# Research: Persist bot state to .data/ directory

## Relevant Files

### Must Modify

- **`src/bot.ts`** — Core state management. Contains `UserState` interface, `userStates` Map, `getState()` function, and all state mutations (`activeProject` assignment, `sessions.set/delete`). Every place that mutates `activeProject` or `sessions` needs a write-through call.
- **`.gitignore`** — Add `.data/` entry.

### Must Read (context)

- **`src/index.ts`** — Entry point. State loading should happen here before `bot.start()`. The startup notification could also confirm restored state.
- **`src/claude.ts`** — `runClaude()` receives `sessionId` param from bot.ts. No changes needed but important to understand session flow.
- **`src/telegram.ts`** — `streamToTelegram()` returns `StreamResult` with `sessionId`. Bot.ts reads this to update sessions map. No changes needed.
- **`src/history.ts`** — Already reads Claude session files from `~/.claude/projects/`. Our persistence is separate — we're persisting which session is active per project, not session contents.

## Existing Patterns

### State Management (bot.ts)
- `userStates = new Map<number, UserState>()` — top-level module-scoped Map
- `getState(id)` — lazy-init pattern: creates default state if missing, returns mutable reference
- State mutations are scattered throughout handlers — not centralized:
  - `activeProject` set at: lines 222, 392, 569, 681, 702, 761-762, 770, 992-993, 1042-1043
  - `sessions.set()` at: lines 577, 704, 772, 820
  - `sessions.delete()` at: lines 394, 682

### File I/O (already used in bot.ts)
- `writeFileSync` — already imported (line 6), used for saving uploaded files
- `mkdirSync` — already imported (line 2), used for creating `user-sent-files/`
- `readFileSync` — already imported (line 4), used for reading plan files
- `readdirSync`, `statSync` — already imported for listing projects

### Naming / Structure
- Project uses sync I/O throughout (no async file ops)
- Functional style with module-level state
- No existing persistence layer or data directory

## Dependencies

- **Node.js `fs`** — already imported in bot.ts (`writeFileSync`, `mkdirSync`, `readFileSync`, `existsSync` needed)
- **Node.js `path`** — already imported (`join`, `basename`)
- **Node.js `os`** — may need `tmpdir()` for atomic writes, or just use `.data/` as temp location
- No new external deps needed

## Potential Impact Areas

### State Mutation Points (need write-through)

1. **`activeProject` changes:**
   - Project selection callback (line ~222): `state.activeProject = fullPath`
   - `/new` command (line ~392): `state.activeProject = projectsDir` (reset to root)
   - History session resume (line ~569): `state.activeProject = cachedProject`
   - Plan execute-new (line ~681): `state.activeProject = plan.projectPath`
   - Plan execute-resume (line ~702): `state.activeProject = plan.projectPath`
   - Default fallbacks (lines ~761, ~992, ~1042): `state.activeProject = projectsDir`
   - Plan context in handlePrompt (line ~770): `state.activeProject = plan.projectPath`

2. **`sessions` changes:**
   - History resume (line ~577): `state.sessions.set(activeProject, sessionId)`
   - Plan resume (lines ~704, ~772): `state.sessions.set(projectPath, sessionId)`
   - After Claude result (line ~820): `state.sessions.set(activeProject, result.sessionId)`
   - `/new` command (line ~394): `state.sessions.delete(activeProject)`
   - Plan new-session (line ~682): `state.sessions.delete(projectPath)`

### What NOT to persist (per issue)
- `queue` — runtime only, contains `Context` objects (not serializable)
- `composeMessages` — ephemeral compose mode state
- `composeStatusMessageId`, `queueStatusMessageId` — Telegram message IDs, stale after restart
- `pendingPlan` — runtime plan interaction state

### Startup Loading
- `index.ts` calls `createBot()` which returns bot instance. State load should happen inside `createBot()` or as a separate init function called before `bot.start()`.
- `getState()` is the natural place to integrate: on first call for a user, check if persisted state exists and load it instead of creating empty state.

## Edge Cases and Constraints

1. **Atomic writes**: Issue specifies write-then-rename. Use `writeFileSync` to a temp file in `.data/`, then `renameSync` to final path. This prevents corruption if process crashes mid-write.

2. **Map serialization**: `sessions` is a `Map<string, string>`. JSON doesn't natively serialize Maps. Need `Object.fromEntries()` for writing, `new Map(Object.entries())` for reading.

3. **Single user assumption**: Current code uses `Map<number, UserState>` keyed by user ID, but `.env` only allows one `ALLOWED_USER_ID`. The `.data/` structure in the issue (`sessions.json`, `active-project`) assumes single-user. Can simplify — no need to key by user ID in the files.

4. **Default `activeProject`**: Empty string `""` vs `projectsDir` — some code paths default to `projectsDir` when empty. Persisted value should be the actual project path, not empty string.

5. **Race conditions**: Multiple write-throughs could happen in quick succession (e.g., project switch + session set). Since everything is synchronous and single-threaded in Bun, this is fine.

6. **Missing `.data/` directory**: Must `mkdirSync({ recursive: true })` before first write.

7. **Invalid persisted state**: Project path might no longer exist after restart. Should validate `activeProject` path exists on load; fall back to empty/projectsDir if not.

8. **Audio buffer cleanup**: Issue mentions cleaning up audio buffer null refs — this refers to the voice transcription flow in bot.ts where `Buffer` objects from `transcribeAudio` could be nulled after use. Minor cleanup.

## Reference Implementations

### Similar pattern: `src/history.ts`
- Reads structured data from files (`~/.claude/projects/` JSONL files)
- Uses `readdirSync`, `readFileSync`, `statSync`
- Parses JSON from files
- Returns typed data structures
- Good reference for file reading patterns

### Similar pattern: File save in `bot.ts`
- `saveUploadedFile()` (around line 1050+) demonstrates:
  - `mkdirSync(dir, { recursive: true })`
  - `writeFileSync(filePath, buffer)`
  - Already used pattern for creating directories and writing files

### Atomic write reference
```typescript
// Standard atomic write pattern
import { writeFileSync, renameSync } from "node:fs";
const tmpPath = filePath + ".tmp";
writeFileSync(tmpPath, data);
renameSync(tmpPath, filePath);
```

## Implementation Approach Summary

1. Create a `src/state.ts` module (or add to bot.ts) with:
   - `loadState(userId)` — read `.data/sessions.json` + `.data/active-project`
   - `saveActiveProject(path)` — atomic write to `.data/active-project`
   - `saveSessions(sessions)` — atomic write to `.data/sessions.json`

2. Modify `getState()` to load persisted state on first call

3. Add write-through calls at every `activeProject` assignment and `sessions.set/delete`

4. Add `.data/` to `.gitignore`

5. Alternatively, wrap state mutations in helper functions (e.g., `setActiveProject(state, path)`, `setSession(state, project, sessionId)`) that both mutate and persist — this centralizes the write-through logic instead of sprinkling save calls everywhere.
