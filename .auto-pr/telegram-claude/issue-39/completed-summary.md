# Completed: Support parallel work using git worktrees

## What was implemented

**Git worktree CRUD** (`src/git.ts`): Added `createWorktree`, `removeWorktree`, and `listWorktrees` functions using `execSync` with the same patterns as existing git functions.

**Per-cwd process tracking** (`src/claude.ts`): Changed `userProcesses` map key from `userId` (number) to `userId:cwd` (string). This enables multiple Claude processes running in parallel in different worktrees for the same user. `stopClaude` and `hasActiveProcess` accept optional `cwd` parameter — when omitted, they operate on all processes for the user.

**Worktree state management** (`src/bot.ts`): Extended `UserState` with `activeWorktree` and `worktrees` map. Added `WorktreeInfo` type. `QueuedMessage` now includes `targetCwd` for per-worktree queue draining. Helper functions `getEffectiveCwd` and `getEffectiveProjectName` resolve the active working directory.

**`/wt` command** (`src/bot.ts`): Full lifecycle management:
- `/wt` — lists worktrees with inline keyboard (switch/remove buttons)
- `/wt new [name]` — creates worktree at `.worktrees/<project>/<name>` with branch `wt/<name>`, max 5
- `/wt rm <name>` — stops process, cleans queue, removes worktree from disk and state
- `/wt switch <name>` — switches active worktree (also `main` to return to main dir)

**Command updates**: `/new` resets session for active worktree. `/status` shows worktree info. `/stop` stops all processes (unchanged). Project switching clears worktree state. `/help` includes `/wt`. Keyboard has Worktrees button.

**Routing**: `handlePrompt` and `runAndDrain` use `effectiveCwd` for process checks, queue targeting, session management, and Claude spawning. Queue drains per-cwd (items for current worktree only). Footer shows distinct project labels per worktree.

**File uploads**: `saveUploadedFile` saves to active worktree's `user-sent-files/` directory.
