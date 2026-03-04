# Implementation Checklist: Persist bot state to .data/

- [x] **Task 1: Add `.data/` to `.gitignore`**
  - Files: `.gitignore`
  - Changes: Add `.data/` line to the gitignore file
  - Acceptance: `.gitignore` contains `.data/` entry, `git status` does not show `.data/` contents

- [x] **Task 2: Create `src/state.ts` persistence module**
  - Files: `src/state.ts` (new file)
  - Changes:
    - Define `PersistedState` interface: `{ activeProject: string; sessions: Record<string, string> }`
    - Constants: `DATA_DIR = ".data"`, `STATE_FILE = join(DATA_DIR, "state.json")`
    - `loadPersistedState()` — reads `STATE_FILE`, parses JSON, validates `activeProject` path exists via `existsSync()`, converts `sessions` object to `Map<string, string>` via `new Map(Object.entries(...))`. Returns `{ activeProject, sessions }` or `null` on any error (missing file, parse failure)
    - `saveState(activeProject, sessions)` — private helper. `mkdirSync(DATA_DIR, { recursive: true })`, serializes to JSON (`Object.fromEntries` for Map), writes to `STATE_FILE + ".tmp"` then `renameSync` to `STATE_FILE` (atomic write)
    - `setActiveProject(state, path)` — sets `state.activeProject = path`, calls `saveState()`
    - `updateSession(state, projectPath, sessionId?)` — if `sessionId` provided: `state.sessions.set(projectPath, sessionId)`, else `state.sessions.delete(projectPath)`. Calls `saveState()`
    - State param type: `{ activeProject: string; sessions: Map<string, string> }` (matches `UserState` shape without importing the full interface)
    - Add JSDoc on all exported functions
  - Acceptance: File compiles with no errors. `loadPersistedState()` returns `null` when no `.data/state.json` exists. `setActiveProject` and `updateSession` create `.data/state.json` with correct JSON structure

- [x] **Task 3: Integrate `loadPersistedState` into `getState()` in bot.ts**
  - Files: `src/bot.ts`
  - Changes:
    - Add import: `import { loadPersistedState, setActiveProject, updateSession } from "./state"`
    - Modify `getState()` (line 98-105): replace the default state creation with:
      ```typescript
      const persisted = loadPersistedState();
      state = {
        activeProject: persisted?.activeProject ?? "",
        sessions: persisted?.sessions ?? new Map(),
        queue: [],
      };
      ```
  - Acceptance: On startup, if `.data/state.json` exists with valid data, `getState()` returns state with persisted `activeProject` and `sessions`. If file missing/corrupt, returns fresh empty state as before

- [x] **Task 4: Replace all `state.activeProject = ...` assignments with `setActiveProject()`**
  - Files: `src/bot.ts`
  - Changes: Replace each direct assignment with `setActiveProject(state, value)` at these locations:
    - Line 222: `state.activeProject = fullPath` → `setActiveProject(state, fullPath)` (project selection callback)
    - Line 392: `state.activeProject = projectsDir` → `setActiveProject(state, projectsDir)` (`/new` command reset)
    - Line 569: `state.activeProject = cachedProject` → `setActiveProject(state, cachedProject)` (history session resume)
    - Line 681: `state.activeProject = plan.projectPath` → `setActiveProject(state, plan.projectPath)` (plan execute-new)
    - Line 702: `state.activeProject = plan.projectPath` → `setActiveProject(state, plan.projectPath)` (plan execute-resume)
    - Line 762: `state.activeProject = projectsDir` → `setActiveProject(state, projectsDir)` (default fallback in handlePrompt)
    - Line 770: `state.activeProject = plan.projectPath` → `setActiveProject(state, plan.projectPath)` (plan context in handlePrompt)
    - Line 993: `state.activeProject = projectsDir` → `setActiveProject(state, projectsDir)` (voice fallback)
    - Line 1043: `state.activeProject = projectsDir` → `setActiveProject(state, projectsDir)` (file upload fallback)
  - Acceptance: No remaining `state.activeProject = ` assignments in bot.ts (only reads/comparisons remain). Every project switch writes to `.data/state.json`

- [x] **Task 5: Replace all `state.sessions.set/delete` calls with `updateSession()`**
  - Files: `src/bot.ts`
  - Changes: Replace each direct sessions mutation with `updateSession()`:
    - Line 394: `state.sessions.delete(state.activeProject)` → `updateSession(state, state.activeProject)` (`/new` command)
    - Line 577: `state.sessions.set(state.activeProject, sessionId)` → `updateSession(state, state.activeProject, sessionId)` (history resume)
    - Line 682: `state.sessions.delete(plan.projectPath)` → `updateSession(state, plan.projectPath)` (plan new-session)
    - Line 704: `state.sessions.set(plan.projectPath, plan.sessionId)` → `updateSession(state, plan.projectPath, plan.sessionId)` (plan resume)
    - Line 772: `state.sessions.set(plan.projectPath, plan.sessionId)` → `updateSession(state, plan.projectPath, plan.sessionId)` (plan context)
    - Line 820: `state.sessions.set(state.activeProject, result.sessionId)` → `updateSession(state, state.activeProject, result.sessionId)` (after Claude result)
  - Acceptance: No remaining `state.sessions.set(` or `state.sessions.delete(` in bot.ts. Every session change writes to `.data/state.json`

- [x] **Task 6: Verify everything works together**
  - Files: all modified files (`src/state.ts`, `src/bot.ts`, `.gitignore`)
  - Changes: none (verification only)
  - Acceptance:
    - `bun run lint` passes with no errors
    - `bun run src/index.ts` starts without errors
    - `.data/` directory is created on first state mutation
    - `.data/state.json` contains correct JSON after selecting a project
    - After restarting the bot, `activeProject` and `sessions` are restored from `.data/state.json`
    - If `.data/state.json` is deleted, bot starts cleanly with fresh state
    - If persisted `activeProject` path no longer exists on disk, it falls back to empty string
    - `.data/` is not tracked by git
