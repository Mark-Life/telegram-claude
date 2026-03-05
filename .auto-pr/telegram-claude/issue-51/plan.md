# Plan: Persist bot state to .data/ directory

## Summary

All bot state (`activeProject`, `sessions` map) lives in-memory and is lost on restart. This forces the user to re-select their project and breaks Claude conversation continuity. We'll persist these two pieces of state to a `.data/` directory using atomic writes, with write-through on every mutation and load-on-startup semantics. Single-user assumption (matches `ALLOWED_USER_ID` design).

## Approach

Create a new `src/state.ts` module with load/save functions. Replace direct `state.activeProject = ...` and `state.sessions.set/delete(...)` calls in `bot.ts` with helper functions that mutate-and-persist atomically. Load persisted state in `getState()` on first access.

## Architectural decisions

**New module vs inline in bot.ts** — Separate `src/state.ts` keeps persistence logic isolated from bot handlers. `bot.ts` is already large; adding file I/O helpers there would push it further.

**Flat files vs single JSON blob** — Single `state.json` file containing both `activeProject` and `sessions`. Simpler than two files, single atomic write, and the data is tiny. The issue suggested two files but a single file is simpler with no downside.

**Centralized mutation helpers** — Instead of adding `saveState()` calls at 15+ mutation sites, expose `setActiveProject(state, path)` and `updateSession(state, project, sessionId?)` that both mutate and persist. This reduces the chance of forgetting a write-through.

**Validate on load** — Check that the persisted `activeProject` path still exists on disk. If not, fall back to empty string (same as fresh state). Stale session IDs are harmless — Claude CLI handles invalid session IDs gracefully.

## Key code snippets

### src/state.ts

```typescript
import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = ".data";
const STATE_FILE = join(DATA_DIR, "state.json");

interface PersistedState {
  activeProject: string;
  sessions: Record<string, string>;
}

/** Load persisted state from disk, returns null if none exists */
export function loadPersistedState() {
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const data: PersistedState = JSON.parse(raw);
    // Validate activeProject path still exists
    const activeProject = data.activeProject && existsSync(data.activeProject)
      ? data.activeProject
      : "";
    return {
      activeProject,
      sessions: new Map(Object.entries(data.sessions ?? {})),
    };
  } catch {
    return null;
  }
}

/** Atomically write state to disk */
function saveState(activeProject: string, sessions: Map<string, string>) {
  mkdirSync(DATA_DIR, { recursive: true });
  const data: PersistedState = {
    activeProject,
    sessions: Object.fromEntries(sessions),
  };
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, STATE_FILE);
}

/** Set activeProject and persist */
export function setActiveProject(
  state: { activeProject: string; sessions: Map<string, string> },
  path: string
) {
  state.activeProject = path;
  saveState(state.activeProject, state.sessions);
}

/** Set or delete a session and persist */
export function updateSession(
  state: { activeProject: string; sessions: Map<string, string> },
  projectPath: string,
  sessionId?: string
) {
  if (sessionId) {
    state.sessions.set(projectPath, sessionId);
  } else {
    state.sessions.delete(projectPath);
  }
  saveState(state.activeProject, state.sessions);
}
```

### bot.ts changes — getState()

```typescript
import { loadPersistedState, setActiveProject, updateSession } from "./state";

function getState(id: number): UserState {
  let state = userStates.get(id);
  if (!state) {
    const persisted = loadPersistedState();
    state = {
      activeProject: persisted?.activeProject ?? "",
      sessions: persisted?.sessions ?? new Map(),
      queue: [],
    };
    userStates.set(id, state);
  }
  return state;
}
```

### bot.ts changes — mutation sites (example)

```typescript
// Before:
state.activeProject = fullPath;
// After:
setActiveProject(state, fullPath);

// Before:
state.sessions.set(state.activeProject, result.sessionId);
// After:
updateSession(state, state.activeProject, result.sessionId);

// Before:
state.sessions.delete(state.activeProject);
// After:
updateSession(state, state.activeProject); // no sessionId = delete
```

## Scope boundaries

- **Out of scope**: Persisting queue, compose state, pending plans, message IDs — all ephemeral/runtime-only per the issue.
- **Out of scope**: Multi-user persistence — the bot is single-user by design (`ALLOWED_USER_ID`).
- **Out of scope**: Audio buffer cleanup — the issue mentions it as a side benefit but it's unrelated to state persistence and should be a separate change.
- **Out of scope**: Migration from any previous state format (there is none).

## Risks

1. **Missing write-through**: 15+ mutation sites need updating. A missed site means that mutation won't persist. Mitigated by using find-and-replace for `state.activeProject =` and `state.sessions.set/delete`.
2. **Stale project path**: User renames/deletes a project directory between restarts. Mitigated by validating path existence on load.
3. **File permission issues**: `.data/` in the working directory could fail if CWD changes. Low risk since the bot runs from a fixed directory.

## Alternative approaches

**Proxy/getter-setter on UserState** — Wrap state object with a Proxy that auto-persists on property set. Eliminates risk of missed write-throughs. Rejected: too clever, harder to debug, and Proxy behavior with Maps is tricky.

**SQLite/LevelDB** — Proper embedded database. Rejected: massive overkill for persisting two small values. Adds a dependency.

**Two separate files (as in the issue)** — `active-project` + `sessions.json`. Rejected: single `state.json` is simpler, and atomic write of both together avoids inconsistent state between the two files.

**Persist on shutdown only** — Save state in the SIGTERM/SIGINT handler. Rejected: doesn't survive crashes or `kill -9`, and the data is small enough that write-through on every mutation is fine.
