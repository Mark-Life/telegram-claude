# Implementation Plan: Support parallel work using git worktrees

- [x] **Task 1: Add worktree CRUD functions to `git.ts`**
  - Files: `src/git.ts`
  - Changes:
    - Add `WorktreeEntry` type: `{ path: string; branch: string; head: string }`
    - Add `createWorktree(projectPath, worktreePath, branchName)` — runs `git worktree add -b "${branchName}" "${worktreePath}"` with `cwd: projectPath`
    - Add `removeWorktree(projectPath, worktreePath)` — runs `git worktree remove "${worktreePath}" --force` with `cwd: projectPath`
    - Add `listWorktrees(projectPath): WorktreeEntry[]` — runs `git worktree list --porcelain`, parses output (lines: `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>`, blank line delimiter)
    - All functions use `execSync` with timeout, matching existing patterns in the file
  - Acceptance: Each function works standalone. `createWorktree` creates a directory with a valid git worktree. `listWorktrees` returns parsed entries. `removeWorktree` cleans up.

- [x] **Task 2: Change process tracking in `claude.ts` from per-user to per-cwd**
  - Files: `src/claude.ts`
  - Changes:
    - Change `userProcesses` type from `Map<number, ProcessEntry>` to `Map<string, ProcessEntry>`
    - Add helper: `function processKey(userId: number, cwd: string) { return \`${userId}:${cwd}\` }`
    - `runClaude`: add `projectDir` to the key lookup — `const key = processKey(telegramUserId, projectDir)`. Use `key` for `userProcesses.get()`, `.set()`, and `.delete()` in the finally block. Error message changes to "A Claude process is already running in this worktree."
    - `stopClaude(telegramUserId, cwd?)`: if `cwd` provided, stop only that process via `processKey(telegramUserId, cwd)`. If no `cwd`, iterate all entries with prefix `${telegramUserId}:` and abort all. Return `boolean`.
    - `hasActiveProcess(telegramUserId, cwd?)`: if `cwd` provided, check only that key. If no `cwd`, scan all entries with prefix `${telegramUserId}:` for any active. Return `boolean`.
    - `stopAll()`: unchanged (iterates all values)
  - Acceptance: Multiple `runClaude` calls with different `projectDir` values for the same user create separate entries. `stopClaude(userId)` without cwd stops all. `hasActiveProcess(userId)` without cwd returns true if any process active.

- [x] **Task 3: Extend `UserState` and add worktree helpers in `bot.ts`**
  - Files: `src/bot.ts`
  - Changes:
    - Add `WorktreeInfo` type: `{ path: string; branch: string; projectPath: string }`
    - Add `activeWorktree?: string` to `UserState` (worktree name, key in worktrees map)
    - Add `worktrees: Map<string, WorktreeInfo>` to `UserState`
    - Update `QueuedMessage` type: add `targetCwd: string`
    - Update `getState()` to initialize `worktrees: new Map()`
    - Add `getEffectiveCwd(state)`: if `state.activeWorktree` is set and exists in `state.worktrees`, return its `.path`. Otherwise return `state.activeProject`.
    - Add `getEffectiveProjectName(state, projectsDir)`: derive display name — if active worktree, return `"${basename(worktreeInfo.projectPath)}/${state.activeWorktree}"`, else existing logic.
    - Import `createWorktree`, `removeWorktree`, `listWorktrees` from `./git`
  - Acceptance: `getEffectiveCwd` returns worktree path when active, project path otherwise. `QueuedMessage` has `targetCwd`. State initializes correctly.

- [x] **Task 4: Update `handlePrompt` and `runAndDrain` to use effective cwd**
  - Files: `src/bot.ts`
  - Changes:
    - `handlePrompt`: compute `effectiveCwd = getEffectiveCwd(state)`. Pass to `hasActiveProcess(userId, effectiveCwd)`. Queue entries include `targetCwd: effectiveCwd`. Pass `effectiveCwd` to `runAndDrain`.
    - `runAndDrain` signature: add `effectiveCwd?: string` parameter. If not provided, compute from `getEffectiveCwd(state)`. Use `effectiveCwd` instead of `state.activeProject` for: `state.sessions.get(effectiveCwd)`, `runClaude(userId, prompt, effectiveCwd, ...)`, `getCurrentBranch(effectiveCwd)`, `state.sessions.set(effectiveCwd, ...)`. Derive `projectName` from `effectiveCwd` (use `getEffectiveProjectName` or inline basename logic).
    - Queue drain: change `state.queue.shift()!` to `state.queue.findIndex(q => q.targetCwd === effectiveCwd)` + `splice(idx, 1)`. If no matching item found (`idx === -1`), break.
    - Update `pendingPlan` handling in `presentPlan` and plan callbacks: store `effectiveCwd` as `projectPath` in `PendingPlan`. When executing plan, restore `effectiveCwd` correctly.
    - Plan feedback path in `handlePrompt`: use `effectiveCwd` from plan's `projectPath`.
    - All existing callers of `runAndDrain` (`plan_new`, `plan_resume` callbacks): pass `plan.projectPath` as `effectiveCwd`.
  - Acceptance: Messages route to the correct cwd (worktree or project). Queue items drain per-cwd. Plan execution uses the correct cwd. Multiple worktrees can have independent queues.

- [x] **Task 5: Add `/wt` command for worktree lifecycle**
  - Files: `src/bot.ts`
  - Changes:
    - Define `MAX_WORKTREES = 5`
    - Define `WORKTREES_BASE` derived from `projectsDir`: `join(projectsDir, ".worktrees")`
    - Register `bot.command("wt", ...)` handler:
      - Parse args: `ctx.message?.text?.split(/\s+/).slice(1)`. Subcommands: `new`, `rm`, `switch`, or no subcommand (list).
      - **Guard**: if `!state.activeProject || state.activeProject === projectsDir` → reply "Worktrees require a git project."
      - **`/wt` (list)**: iterate `state.worktrees`, build inline keyboard with buttons: each worktree shows name + branch, callback `wt_switch:<name>`. Add remove buttons `wt_rm:<name>`. Show which is active. If no worktrees, reply "No active worktrees."
      - **`/wt new [name]`**: name defaults to `task-${Date.now()}`. Check `state.worktrees.size < MAX_WORKTREES`. Compute `worktreePath = join(WORKTREES_BASE, basename(state.activeProject), name)`. Branch name = `wt/${name}`. Call `createWorktree(state.activeProject, worktreePath, branchName)`. Add to `state.worktrees.set(name, { path: worktreePath, branch: branchName, projectPath: state.activeProject })`. Set `state.activeWorktree = name`. Reply confirmation.
      - **`/wt rm <name>`**: check worktree exists. Stop any process via `stopClaude(userId, worktreeInfo.path)`. Remove queued items targeting that cwd. Call `removeWorktree(worktreeInfo.projectPath, worktreeInfo.path)` (wrapped in try/catch). Delete from `state.worktrees`. If `state.activeWorktree === name`, set `state.activeWorktree = undefined`. Delete session `state.sessions.delete(worktreeInfo.path)`. Reply confirmation.
      - **`/wt switch <name>`**: check exists. Set `state.activeWorktree = name`. Reply confirmation with branch name.
    - Register callback handlers:
      - `wt_switch:<name>` — same as `/wt switch`
      - `wt_rm:<name>` — same as `/wt rm`
    - Add `/wt main` or `/wt switch main` — sets `state.activeWorktree = undefined` to route back to main project dir.
  - Acceptance: `/wt new foo` creates worktree, sets active. `/wt` lists worktrees. `/wt switch foo` changes active. `/wt rm foo` removes worktree and cleans state. Max 5 enforced. Non-git projects rejected.

- [x] **Task 6: Update `/stop`, `/new`, `/status`, and project switching for worktree awareness**
  - Files: `src/bot.ts`
  - Changes:
    - **`/stop`**: call `stopClaude(userId)` (no cwd — stops all, matching current behavior). Also clear all queue items. Keep existing behavior.
    - **`/new`**: compute `effectiveCwd = getEffectiveCwd(state)`. Delete session for `effectiveCwd` instead of `state.activeProject`. This makes `/new` reset the session for the active worktree.
    - **`/status`**: show active worktree name if set. Show count of active worktrees. Show if process running in active worktree via `hasActiveProcess(userId, effectiveCwd)`. Show queue count for active cwd.
    - **Project switching** (`callbackQuery project:`): reset `state.activeWorktree = undefined`. Clear `state.worktrees` (switching project abandons worktrees — they remain on disk but tracking is lost). This is consistent with current behavior where switching project resets queue.
    - **`/help`**: add `/wt` to help text.
    - **Keyboard**: add "Worktrees" button to `mainKeyboard`. Add button-to-command mapping `Worktrees: "/wt"`.
  - Acceptance: `/stop` stops all processes. `/new` resets correct session. `/status` shows worktree info. Project switch clears worktree state. Help shows `/wt`.

- [x] **Task 7: Update footer labeling for worktree distinction**
  - Files: `src/bot.ts`
  - Changes:
    - In `runAndDrain`, when computing `projectName`: if running in a worktree, format as `"projectName/worktreeName"` or `"projectName (wt: name)"` so the footer distinguishes which worktree produced the output. The `branchName` from `getCurrentBranch(effectiveCwd)` already differs per worktree, but the project label should also differentiate.
  - Acceptance: Messages from different worktrees show distinct project labels in their footer (e.g., `myapp/fix-auth [wt/fix-auth]` vs `myapp [main]`).

- [x] **Task 8: Handle file uploads in worktree context**
  - Files: `src/bot.ts`
  - Changes:
    - `saveUploadedFile`: use `getEffectiveCwd(state)` instead of `state.activeProject` for the `user-sent-files` directory. Files should be saved in the active worktree's directory so Claude can see them.
  - Acceptance: Files uploaded while a worktree is active are saved under that worktree's `user-sent-files/` dir.

- [x] **Task 9: Verify everything works together**
  - Files: all modified files
  - Changes: Manual verification steps:
    1. Start bot, select a git project
    2. `/wt new test1` — creates worktree, confirms active
    3. Send a message — Claude runs in worktree cwd, footer shows worktree label
    4. `/wt new test2` — creates second worktree
    5. Send message to test2 while test1 still has no process — runs in test2
    6. `/wt switch test1` — switch back
    7. `/wt` — lists both worktrees with switch/remove buttons
    8. `/status` — shows active worktree info
    9. `/new` — resets session for active worktree only
    10. `/stop` — stops all processes
    11. `/wt rm test1` — removes worktree, cleans state
    12. `/wt rm test2` — removes second worktree
    13. Send message — routes to main project dir (no active worktree)
    14. `/wt` on General project — shows error
    15. Try creating 6th worktree — shows limit error
  - Acceptance: All above scenarios work without errors. Queue drains correctly per-worktree. Process isolation is maintained.
