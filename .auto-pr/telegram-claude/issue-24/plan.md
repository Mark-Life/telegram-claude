# Plan: Branch/PR awareness in project status (#24)

## Summary

Add git branch and PR visibility to the Telegram bot. Currently there's zero git context shown — you can't tell what branch Claude is working on or what PRs exist. This adds branch info to the footer, pinned message, and `/status`, plus new `/pr` and `/branch` commands.

Branch **switching** is excluded — it's destructive (fails on dirty trees, confuses active Claude sessions) and belongs as a separate feature with proper safeguards.

## Approach

Add a `getCurrentBranch(projectPath)` git helper following the existing `getGitHubUrl()` pattern (`execSync` + `cwd` + timeout + try/catch). Thread branch info through all display surfaces. Add two new commands using existing patterns.

## Architectural decisions

1. **Branch passed as separate param, not embedded in projectName** — `streamToTelegram` and `formatFooter` get a new `branchName` parameter. Cleaner than munging `projectName`, and both `formatFooter` and `formatFooterPlain` can handle it independently.

2. **Branch fetched at call-time, not cached in state** — Branch can change between messages (Claude itself switches branches). Fetching fresh via `execSync` is ~instant and always accurate. No stale state.

3. **No branch switching** — `/branch` is read-only (shows current + lists local branches). Switching is risky (dirty tree, session confusion) and warrants its own issue with confirmation UX.

4. **`gh pr list` for PRs** — Uses `gh` CLI (available per CLAUDE.md) with `--json` for structured output. Falls back gracefully if `gh` isn't authenticated.

5. **No new keyboard buttons** — `/pr` and `/branch` are low-frequency commands, not worth cluttering the persistent keyboard. Accessible via command menu only.

## Key code snippets

### Git helpers (bot.ts, near `getGitHubUrl`)

```ts
/** Get current git branch name, or null if not a git repo */
function getCurrentBranch(projectPath: string) {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: projectPath, timeout: 3000 })
      .toString().trim()
    return branch === "HEAD" ? "(detached)" : branch
  } catch {
    return null
  }
}

/** List local git branches, marking the current one */
function listBranches(projectPath: string) {
  try {
    return execSync("git branch --format='%(refname:short)'", { cwd: projectPath, timeout: 3000 })
      .toString().trim().split("\n").filter(Boolean)
  } catch {
    return null
  }
}

/** List open PRs via gh CLI */
function listOpenPRs(projectPath: string) {
  try {
    const raw = execSync(
      'gh pr list --state open --json number,title,headRefName,url --limit 10',
      { cwd: projectPath, timeout: 10000 }
    ).toString().trim()
    return JSON.parse(raw) as { number: number; title: string; headRefName: string; url: string }[]
  } catch {
    return null
  }
}
```

### `/branch` command (bot.ts)

```ts
bot.command("branch", async (ctx) => {
  const state = getState(ctx.from!.id)
  if (!state.activeProject || state.activeProject === projectsDir) {
    await ctx.reply("No project selected or in general mode.", { reply_markup: mainKeyboard })
    return
  }
  const current = getCurrentBranch(state.activeProject)
  if (!current) {
    await ctx.reply("Not a git repository.", { reply_markup: mainKeyboard })
    return
  }
  const branches = listBranches(state.activeProject)
  const name = basename(state.activeProject)
  let text = `<b>${escapeHtml(name)}</b> — branch: <code>${escapeHtml(current)}</code>`
  if (branches && branches.length > 1) {
    const others = branches.filter(b => b !== current).slice(0, 20)
    text += `\n\nOther branches:\n${others.map(b => `  <code>${escapeHtml(b)}</code>`).join("\n")}`
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: mainKeyboard })
})
```

### `/pr` command (bot.ts)

```ts
bot.command("pr", async (ctx) => {
  const state = getState(ctx.from!.id)
  if (!state.activeProject || state.activeProject === projectsDir) {
    await ctx.reply("No project selected or in general mode.", { reply_markup: mainKeyboard })
    return
  }
  const prs = listOpenPRs(state.activeProject)
  if (prs === null) {
    await ctx.reply("Could not fetch PRs. Is gh CLI authenticated?", { reply_markup: mainKeyboard })
    return
  }
  if (prs.length === 0) {
    await ctx.reply("No open PRs.", { reply_markup: mainKeyboard })
    return
  }
  const lines = prs.map(pr =>
    `#${pr.number} <a href="${escapeHtml(pr.url)}">${escapeHtml(pr.title)}</a> (<code>${escapeHtml(pr.headRefName)}</code>)`
  )
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: mainKeyboard })
})
```

### Footer change (telegram.ts)

```ts
// formatFooter signature change:
function formatFooter(projectName: string, result: StreamResult, branchName?: string | null) {
  const meta: string[] = []
  const label = branchName ? `${escapeHtml(projectName)} [${escapeHtml(branchName)}]` : escapeHtml(projectName)
  if (projectName) meta.push(`Project: ${label}`)
  // ... rest unchanged
}

// streamToTelegram signature change:
export async function streamToTelegram(
  ctx: Context,
  events: AsyncGenerator<ClaudeEvent>,
  projectName: string,
  branchName?: string | null,
): Promise<StreamResult>
```

### Pinned message update (bot.ts, project selection callback)

```ts
// In the project:* callback handler, after setting activeProject:
const branch = isGeneral ? null : getCurrentBranch(fullPath)
const branchSuffix = branch ? ` [${escapeHtml(branch)}]` : ""
const msg = await ctx.editMessageText(`Active project: ${projectLabel}${branchSuffix}`, { parse_mode: "HTML" })
```

### `/status` update (bot.ts)

```ts
// Add branch to status output:
const branch = state.activeProject && state.activeProject !== projectsDir
  ? getCurrentBranch(state.activeProject) : null
const branchLine = branch ? `\nBranch: ${branch}` : ""
await ctx.reply(`Project: ${project}\nRunning: ${running}\nSessions: ${sessionCount}${branchLine}`, { reply_markup: mainKeyboard })
```

### handlePrompt — pass branch to streamToTelegram (bot.ts)

```ts
const branchName = state.activeProject !== projectsDir ? getCurrentBranch(state.activeProject) : null
const result = await streamToTelegram(ctx, events, projectName, branchName)
```

### Command registration (index.ts)

```ts
// Add to commands array:
{ command: "branch", description: "Show current git branch" },
{ command: "pr", description: "List open pull requests" },
```

### Help text update (bot.ts)

Add `/branch` and `/pr` to the `/help` command output.

## Scope boundaries

**In scope:**
- `getCurrentBranch()`, `listBranches()`, `listOpenPRs()` helpers
- `/branch` command (read-only — show current + list)
- `/pr` command (list open PRs)
- Branch in footer, pinned message, `/status`
- Command registration and help text

**Out of scope:**
- Branch switching (`git checkout`) — destructive, needs confirmation UX, separate issue
- PR creation/merge from Telegram
- Remote branch listing or fetching
- Pagination for PR list (capped at 10 via `--limit`)
- Branch info for "general" mode (no single repo)

## Risks

1. **`gh` CLI not authenticated** — `listOpenPRs` returns null, `/pr` shows a helpful error. No crash.
2. **Non-git projects** — All helpers return null on failure. All callers check for null.
3. **Detached HEAD** — `git rev-parse --abbrev-ref HEAD` returns `HEAD`; mapped to `"(detached)"`.
4. **Long branch lists** — `listBranches` output capped at 20 "other" branches. Telegram 4096 char limit unlikely to be hit with 20 short branch names but could occur with pathological names.
5. **`gh pr list` timeout** — Given 10s timeout (vs 3s for git). If the network is slow, it times out gracefully.

## Alternative approaches

1. **Embed branch in projectName string** — Pass `"myproject [main]"` as projectName instead of adding a parameter. Simpler signature but mixes concerns — formatFooterPlain would need to parse it back out, and any future consumer of projectName gets polluted. Rejected: breaks separation of concerns.

2. **Cache branch in UserState** — Store branch alongside activeProject to avoid repeated `execSync`. Rejected: branch changes frequently (Claude switches branches, user pushes), staleness is worse than the ~1ms cost of `execSync`.

3. **Use git2 / isomorphic-git library** — Programmatic git access without shelling out. Rejected: adds dependency, `execSync` pattern already established and works well.

4. **Add branch switching to `/branch`** — Make it a two-purpose command: view + interactive switch via InlineKeyboard. Rejected for this PR: branch switching is destructive (dirty tree, session confusion), needs confirmation UX, and is better as a follow-up issue.

5. **GitHub API instead of `gh` CLI** — Use `fetch` to call GitHub REST API directly. Rejected: requires managing auth tokens manually; `gh` CLI handles auth transparently and is already available.
