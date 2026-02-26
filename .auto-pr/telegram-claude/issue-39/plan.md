# Plan: Support parallel work using git worktrees

## Summary

Enable parallel task execution by leveraging git worktrees as isolated working copies. Currently, `userProcesses` in `claude.ts` is `Map<userId, ProcessEntry>` — hard limit of one Claude process per user. The queue system serializes all messages. With worktrees, the bot spawns separate Claude processes in separate working directories, enabling true concurrent work on multiple issues/PRs.

## Approach

Change process tracking from per-user to per-cwd (`${userId}:${cwd}` composite key). Add worktree CRUD to `git.ts`. Extend `UserState` with worktree tracking and an `activeWorktree` pointer that determines where messages route. Tag queue items with their target cwd so each worktree drains independently. Add `/wt` command for worktree lifecycle.

## Architectural decisions

**1. Process key: `${userId}:${cwd}` instead of `userId`**
Allows multiple concurrent Claude processes per user — one per working directory. The existing single-process constraint becomes per-worktree. Minimal change to `claude.ts` internals.

**2. Worktree storage: `PROJECTS_DIR/.worktrees/<projectName>/<wtName>/`**
Outside any project directory to avoid nesting issues and Claude seeing worktree dirs during file operations. Centralized under the known `PROJECTS_DIR` so cleanup is straightforward.

**3. Single queue array with cwd tags (not separate Map)**
`QueuedMessage` gains `targetCwd: string`. During drain, `findIndex(q => q.targetCwd === cwd)` selects next item for that worktree. Avoids restructuring `UserState` queue into a Map while still giving per-worktree behavior. Queue sizes are tiny so O(n) filtering is fine.

**4. Auto-branch naming: `wt/<name>` from current HEAD**
When creating a worktree, auto-create branch `wt/<name>` based on the active project's current HEAD. Keeps worktree branches namespaced and identifiable.

**5. Max concurrent worktrees: 5 per project**
Prevents runaway resource usage. Each worktree = separate Claude CLI process = separate API session.

## Key code snippets

### git.ts — worktree functions

```typescript
type WorktreeEntry = { path: string; branch: string; head: string }

export function createWorktree(projectPath: string, worktreePath: string, branchName: string) {
  execSync(`git worktree add -b "${branchName}" "${worktreePath}"`, {
    cwd: projectPath, timeout: 10000,
  })
}

export function removeWorktree(projectPath: string, worktreePath: string) {
  execSync(`git worktree remove "${worktreePath}" --force`, {
    cwd: projectPath, timeout: 10000,
  })
}

export function listWorktrees(projectPath: string): WorktreeEntry[] {
  const output = execSync("git worktree list --porcelain", {
    cwd: projectPath, timeout: 5000,
  }).toString()
  // parse porcelain output into WorktreeEntry[]
}
```

### claude.ts — per-cwd process tracking

```typescript
const userProcesses = new Map<string, ProcessEntry>()  // "${userId}:${cwd}"

function processKey(userId: number, cwd: string) {
  return `${userId}:${cwd}`
}

export async function* runClaude(
  telegramUserId: number,
  prompt: string,
  projectDir: string,
  chatId: number,
  sessionId?: string,
): AsyncGenerator<ClaudeEvent> {
  const key = processKey(telegramUserId, projectDir)
  const existing = userProcesses.get(key)
  if (existing) {
    if (!existing.ac.signal.aborted) {
      yield { kind: "error", message: "A Claude process is already running in this worktree." }
      return
    }
    await existing.done
  }
  // ... spawn process, track under `key`, cleanup deletes `key`
}

export function stopClaude(telegramUserId: number, cwd?: string) {
  if (cwd) {
    // Stop specific worktree process
    const entry = userProcesses.get(processKey(telegramUserId, cwd))
    if (!entry || entry.ac.signal.aborted) return false
    entry.ac.abort()
    return true
  }
  // Stop all processes for user
  let stopped = false
  const prefix = `${telegramUserId}:`
  for (const [key, entry] of userProcesses) {
    if (key.startsWith(prefix) && !entry.ac.signal.aborted) {
      entry.ac.abort()
      stopped = true
    }
  }
  return stopped
}

export function hasActiveProcess(telegramUserId: number, cwd?: string) {
  if (cwd) {
    const entry = userProcesses.get(processKey(telegramUserId, cwd))
    return !!entry && !entry.ac.signal.aborted
  }
  const prefix = `${telegramUserId}:`
  for (const [key, entry] of userProcesses) {
    if (key.startsWith(prefix) && !entry.ac.signal.aborted) return true
  }
  return false
}
```

### bot.ts — state model

```typescript
type WorktreeInfo = { path: string; branch: string; projectPath: string }
type QueuedMessage = { prompt: string; ctx: Context; targetCwd: string }

type UserState = {
  activeProject: string
  activeWorktree?: string                    // worktree name (key in worktrees)
  worktrees: Map<string, WorktreeInfo>       // name → info
  sessions: Map<string, string>              // cwd path → sessionId (works for both)
  queue: QueuedMessage[]
  queueStatusMessageId?: number
  pendingPlan?: PendingPlan
}

function getEffectiveCwd(state: UserState) {
  if (state.activeWorktree) {
    const wt = state.worktrees.get(state.activeWorktree)
    if (wt) return wt.path
  }
  return state.activeProject
}
```

### bot.ts — /wt command

```typescript
bot.command("wt", async (ctx) => {
  const state = getState(ctx.from!.id)
  if (!state.activeProject || state.activeProject === projectsDir) {
    await ctx.reply("Worktrees require a git project. Select one first.")
    return
  }

  const args = ctx.message?.text?.split(/\s+/).slice(1) ?? []
  const sub = args[0]

  if (sub === "new") {
    const name = args[1] || `task-${Date.now()}`
    // validate limit, create worktree, add to state.worktrees, set activeWorktree
  } else if (sub === "rm") {
    // remove worktree, stop process, clean queue items, clear from state
  } else {
    // list worktrees with inline switch/remove buttons
  }
})
```

### bot.ts — updated handlePrompt + runAndDrain

```typescript
async function handlePrompt(ctx: Context, prompt: string) {
  const state = getState(ctx.from!.id)
  // ...existing project/plan checks...
  const effectiveCwd = getEffectiveCwd(state)
  const userId = ctx.from!.id

  if (hasActiveProcess(userId, effectiveCwd)) {
    state.queue.push({ prompt, ctx, targetCwd: effectiveCwd })
    await sendOrUpdateQueueStatus(ctx, state)
    return
  }

  await runAndDrain(ctx, prompt, state, userId, effectiveCwd)
}

async function runAndDrain(ctx: Context, prompt: string, state: UserState, userId: number, effectiveCwd: string) {
  let currentCtx = ctx
  let currentPrompt = prompt
  while (true) {
    const sessionId = state.sessions.get(effectiveCwd)
    const projectName = /* derive from effectiveCwd */
    const branchName = getCurrentBranch(effectiveCwd)
    const events = runClaude(userId, currentPrompt, effectiveCwd, currentCtx.chat!.id, sessionId)
    const result = await streamToTelegram(currentCtx, events, projectName, { branchName })
    if (result.sessionId) state.sessions.set(effectiveCwd, result.sessionId)
    // ...plan handling...

    // Drain only items targeting this cwd
    const idx = state.queue.findIndex(q => q.targetCwd === effectiveCwd)
    if (idx === -1) break
    const next = state.queue.splice(idx, 1)[0]
    currentPrompt = next.prompt
    currentCtx = next.ctx
    // ...
  }
}
```

## Scope boundaries

- **No auto-cleanup** — worktrees are manually removed via `/wt rm`. No TTL, no auto-remove on branch merge.
- **No reply-to routing** — messages always route to active worktree. No "reply to this message to target that worktree" logic.
- **No Telegram thread isolation** — all outputs go to the same chat. Outputs are distinguished by footer (branch name).
- **No worktrees for non-git projects** — General mode has no git, `/wt` is unavailable.
- **No worktree-specific queue status messages** — single queue status message shows total count.
- **No persistent worktree state** — worktree map is in-memory. Bot restart loses tracking (worktrees on disk remain, can be re-listed via `git worktree list`).

## Risks

1. **Resource usage** — each worktree spawns a separate `claude` CLI process. 5 concurrent worktrees = 5 processes. Memory and API cost scale linearly. The 5-worktree cap mitigates but doesn't eliminate.
2. **Chat flooding** — parallel processes produce interleaved outputs. User must rely on footer labels to tell them apart. Could be confusing with >2 active worktrees.
3. **Queue drain correctness** — `findIndex` + `splice` for cwd-filtered draining is a new pattern. Edge case: user switches worktree mid-queue, orphaning queued items for the old worktree. Mitigation: drain still runs for the old cwd until its queue empties.
4. **Branch conflicts** — git worktrees cannot checkout the same branch in two worktrees. `createWorktree` must handle this error gracefully.
5. **Session path encoding** — Claude stores sessions under `~/.claude/projects/<encoded-cwd>/`. Worktree paths differ from project paths, so sessions in worktrees are naturally separate. This is correct behavior but means `/history` shows worktree sessions with unfamiliar project names.

## Alternative approaches

**Worktree-as-project** — Register each worktree as a top-level entry in the `/projects` list. No new commands needed; existing project switching handles routing. Rejected: clutters project list, conflates permanent projects with ephemeral worktrees, no clean lifecycle management.

**Sequential task queue** — Instead of parallel execution, add a named task queue. User submits tasks, bot processes them one at a time. Rejected: no actual parallelism — the core value proposition of the issue. Could take hours to process multiple tasks sequentially.

**Docker/container isolation** — Spin up isolated containers per task for maximum separation. Rejected: massive complexity, requires Docker setup, slower startup, resource-heavy. Git worktrees achieve the same file isolation with zero overhead.

**Per-worktree Telegram threads** — Use Telegram forum topics or threads to isolate each worktree's output. Rejected: requires group chat with topics enabled (changes bot UX), Grammy thread support is limited, adds significant Telegram-side complexity for moderate benefit.
