# Completed: Persist bot state to .data/

## What was implemented

1. **`.gitignore`** — Added `.data/` to prevent persisted state from being tracked by git.

2. **`src/state.ts`** (new) — Persistence module with:
   - `loadPersistedState()` — Reads `.data/state.json`, validates `activeProject` path exists on disk, converts sessions object to Map. Returns null on any error.
   - `setActiveProject(state, path)` — Sets activeProject and atomically writes state to disk (write-then-rename).
   - `updateSession(state, projectPath, sessionId?)` — Sets or deletes a session mapping and persists to disk.

3. **`src/bot.ts`** — Integrated persistence:
   - `getState()` now loads persisted state on first access via `loadPersistedState()`.
   - All 9 `state.activeProject = ...` assignments replaced with `setActiveProject()`.
   - All 6 `state.sessions.set()`/`state.sessions.delete()` calls replaced with `updateSession()`.

## Behavior

- On startup, if `.data/state.json` exists, activeProject and sessions are restored.
- Every project switch or session change atomically writes to `.data/state.json`.
- If `.data/state.json` is missing or corrupt, bot starts with fresh empty state.
- If persisted activeProject path no longer exists on disk, it falls back to empty string.
- `.data/` directory is created automatically on first state mutation.
