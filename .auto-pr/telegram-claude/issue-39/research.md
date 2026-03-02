# Research: Support parallel work using git worktrees

## Issue Summary

Enable parallel task execution by spinning up git worktrees as isolated working copies. Currently only one Claude process runs per user per project. With worktrees, the bot could handle multiple concurrent tasks (e.g., multiple issues/PRs) without file conflicts.

---

## 1. Relevant Files

### Must Modify

| File | Role | Why |
|---|---|---|
| `src/bot.ts` | Bot setup, state management, command handlers, message routing | Core state model (`UserState`) assumes single `activeProject`. Session map keyed by project path. Queue system assumes one-at-a-time. Need worktree lifecycle commands and parallel process routing. |
| `src/claude.ts` | Spawns `claude` CLI, tracks one process per user | `userProcesses` is `Map<userId, ProcessEntry>` — hard limit of 1 process per user. Must support multiple concurrent processes, keyed by userId+worktree or a task ID. |
| `src/git.ts` | Git helper functions (`getCurrentBranch`, `listBranches`, etc.) | Need to add worktree management functions: `createWorktree`, `removeWorktree`, `listWorktrees`. Existing functions already take `projectPath` as argument so they'll work with worktree paths as-is. |

### May Need Modification

| File | Role | Why |
|---|---|---|
| `src/telegram.ts` | Streams Claude events to Telegram messages | Currently stateless relative to project/worktree. May need to label messages with which worktree/task they belong to so user can distinguish parallel outputs. |
| `src/history.ts` | Session listing and lookup | Sessions are stored under `~/.claude/projects/<encoded-path>/`. Worktree paths differ from main project path, so sessions in worktrees get stored separately. May need mapping logic to group them. |
| `src/index.ts` | Entry point, env vars | Possibly no changes, unless new env vars needed. |

### Read-Only Context

| File | Role |
|---|---|
| `src/transcribe.ts` | Voice transcription — unaffected |
| `scripts/send-file-to-user.ts` | File sending script — unaffected |
| `package.json` | No new dependencies needed (git is a system tool) |

---

## 2. Existing Patterns

### State Management
- `UserState` per user: `{ activeProject, sessions, queue, queueStatusMessageId, pendingPlan }`
- `userStates` is `Map<number, UserState>` in `bot.ts`
- `userProcesses` is `Map<number, ProcessEntry>` in `claude.ts` (1 process per user)
- Sessions keyed by project path: `state.sessions: Map<string, string>` (projectPath → sessionId)

### Process Lifecycle
- `runClaude()` checks for existing process, errors if one already running (not aborted)
- Single `AbortController` per user
- `stopClaude(userId)` aborts the one active process
- `hasActiveProcess(userId)` checks if process is running (used for queueing)

### Queue System
- When `hasActiveProcess(userId)` is true, new messages push to `state.queue`
- `runAndDrain()` loops: run prompt → check queue → run next → repeat
- Queue status message updated with inline buttons (Force Send / Clear Queue)

### Project Selection
- `/projects` command lists directories in `PROJECTS_DIR`
- Callback `project:<name>` sets `state.activeProject = fullPath`
- `activeProject` used as `cwd` when spawning Claude and as key for session lookup

### Git Operations
- All git functions in `git.ts` take `projectPath` and use `execSync` with `cwd: projectPath`
- Already path-agnostic — will work with worktree paths

### Footer/Context
- `streamToTelegram` receives `projectName` and `branchName` for footer display
- `runAndDrain` computes `projectName` from `basename(state.activeProject)` and `branchName` from `getCurrentBranch()`

---

## 3. Dependencies

### System Dependencies
- `git` CLI (already available) — `git worktree add/remove/list` commands
- No new npm packages needed

### Internal Dependencies
- `claude.ts` → spawned with `cwd: projectDir` — worktree path is a valid cwd
- `git.ts` → `execSync` with `cwd` — works with any git working directory including worktrees
- `history.ts` → Claude stores sessions under `~/.claude/projects/<encoded-path>/` — worktree paths encode differently than main project paths

---

## 4. Potential Impact Areas

### State Model Restructuring
The biggest change. Currently:
```
UserState.activeProject: string  // single path
UserState.sessions: Map<projectPath, sessionId>  // one session per project
```
Needs to become something like:
```
UserState.activeProject: string  // still the "main" project
UserState.worktrees: Map<string, WorktreeInfo>  // worktreeId → { path, branch, ... }
UserState.activeWorktree?: string  // currently focused worktree
```
Or alternatively, treat each worktree as its own "project path" within the existing system.

### Process Tracking
`userProcesses: Map<userId, ProcessEntry>` allows only 1 process per user. For parallel work, needs to become `Map<string, ProcessEntry>` keyed by `${userId}:${worktreeId}` or similar composite key.

### Message Routing
When multiple Claude processes run in parallel, incoming user messages need to be routed to the correct worktree. Options:
- Default to "active" worktree (simplest)
- Reply-to-message to target a specific task
- Explicit `/switch <worktree>` command

### Output Labeling
Parallel outputs need visual distinction. The footer already shows project name and branch — worktree branch name naturally differentiates. But the user needs to know which task produced which output.

### Queue Behavior
Current queue is per-user. With parallel worktrees, queueing may be per-worktree (each worktree has its own Claude process) or removed entirely (just start new process in worktree).

### Session Continuity
Claude sessions stored under `~/.claude/projects/` use the encoded `cwd` path. A worktree at `/root/projects/myapp/.worktrees/fix-auth` would store sessions separately from `/root/projects/myapp`. The `sessions` map in UserState would key on the worktree path, which naturally works.

### Cleanup
Worktrees need cleanup: when done with a task (PR merged, abandoned), the worktree should be removed. Options: manual `/worktree remove <id>`, automatic on branch merge, TTL-based.

---

## 5. Edge Cases and Constraints

### Git Worktree Limitations
- Cannot check out the same branch in two worktrees simultaneously
- The main working directory counts as a worktree
- Worktrees share the object store — large repos are fine, no duplication
- Nested worktrees are not supported
- Deleting a worktree with uncommitted changes requires `--force`

### Claude CLI Behavior in Worktrees
- Claude CLI uses `cwd` to determine project context. A worktree path is a valid cwd.
- `--dangerously-skip-permissions` is already used, so no permission issues
- Session IDs are tied to the path, so each worktree gets its own session automatically
- CLAUDE.md files in the project root are visible in worktrees (shared repo content)

### Resource Constraints
- Each parallel Claude process is a separate `claude` CLI subprocess
- Memory and CPU usage scales linearly with number of parallel tasks
- API costs multiply with parallel tasks
- Should probably cap maximum concurrent worktrees (e.g., 3-5)

### Telegram UX
- Multiple parallel outputs can flood the chat
- Need clear labeling of which worktree/branch each message belongs to
- Stopping a specific process needs to be distinguishable (`/stop` currently stops the only process — with parallel, need `/stop <worktree>` or stop buttons per task)
- `/new` command semantics change — reset which session? Active worktree's?

### Worktree Location
- Standard location: `<project>/.worktrees/<branch-or-id>/` (gitignored)
- Or: `/tmp/worktrees/<project>/<id>/` (auto-cleaned on reboot)
- Must be under a path Claude can access

### Non-Git Projects
- Worktrees only work for git repos
- The "General" project mode has no git — worktrees N/A
- Need graceful handling: worktree commands unavailable for non-git projects

---

## 6. Reference Implementations

### Existing Process Management Pattern (`claude.ts`)
```typescript
const userProcesses = new Map<number, ProcessEntry>()

export async function* runClaude(telegramUserId, prompt, projectDir, chatId, sessionId?) {
  const existing = userProcesses.get(telegramUserId)
  if (existing) {
    if (!existing.ac.signal.aborted) {
      yield { kind: "error", message: "A Claude process is already running." }
      return
    }
    await existing.done
  }
  // ... spawn process, track in map, cleanup on done
}
```
This is the pattern to extend. Instead of erroring when a process exists, allow multiple keyed by worktree.

### Existing Queue Pattern (`bot.ts`)
```typescript
if (hasActiveProcess(userId)) {
  state.queue.push({ prompt, ctx })
  await sendOrUpdateQueueStatus(ctx, state)
  return
}
await runAndDrain(ctx, prompt, state, userId)
```
With parallel worktrees, this becomes: check if active worktree has a process → queue to that worktree, or if targeting a different worktree, start new process there.

### Existing Project Selection Pattern
```typescript
bot.callbackQuery(/^project:(.+)$/, async (ctx) => {
  const state = getState(ctx.from!.id)
  state.activeProject = fullPath
  // ...
})
```
Worktree selection would follow the same callback pattern: `worktree:<id>` to switch active worktree.

### Git Worktree CLI Commands (reference)
```bash
git worktree add <path> -b <branch>     # create worktree with new branch
git worktree add <path> <existing-branch>  # create worktree from existing branch
git worktree list                         # list all worktrees
git worktree remove <path>                # remove a worktree
git worktree prune                        # clean up stale worktree references
```

### Proposed New Commands
- `/worktree` or `/wt` — list active worktrees for current project
- `/worktree new [branch-name]` — create new worktree, start working in it
- `/worktree switch <id>` — switch active worktree (where messages route to)
- `/worktree remove <id>` — delete a worktree
- `/stop` — stop active worktree's process (or `/stop all`)
- Messages route to active worktree by default
