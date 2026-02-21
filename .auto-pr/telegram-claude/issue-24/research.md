# Research: Branch/PR awareness in project status (#24)

## Relevant files

### Must modify

- **src/bot.ts** — Core bot logic. Contains all command handlers, `UserState` type, project selection, pinned message logic, keyboard definitions, and the `handlePrompt` function. Every feature in this issue touches this file.
- **src/telegram.ts** — Response streaming and footer formatting. `formatFooter()` (line 295-305) and `formatFooterPlain()` (line 308-318) build the metadata footer shown after Claude responses. Need to add branch info here.
- **src/index.ts** — Bot startup and command registration. Lines 50-57 register commands with Telegram via `setMyCommands()`. New `/pr` and `/branch` commands must be added here.

### Must read (context only)

- **src/claude.ts** — Spawns `claude` CLI with `cwd: projectDir`. The git branch context comes from this directory. No changes needed but important to understand that branch applies per-project.
- **src/history.ts** — Session management. No changes needed.
- **src/transcribe.ts** — Voice transcription. No changes needed.

## Existing patterns

### Git operations
`bot.ts:66-85` — `getGitHubUrl()` is the only existing git operation. Pattern:
```ts
execSync("git remote get-url origin", { cwd: projectPath, timeout: 3000 }).toString().trim()
```
Uses `execSync` from `child_process` (already imported at bot.ts:3), runs in project dir, 3s timeout, wrapped in try/catch returning null on failure. New git helpers should follow this pattern exactly.

### Command registration
1. **Handler**: `bot.command("name", handler)` in `bot.ts`
2. **Keyboard button** (optional): Add to `mainKeyboard` (line 25-28) and `buttonToCommand` (line 103-108)
3. **Telegram menu**: Add to `commands` array in `index.ts:50-57`

### InlineKeyboard for selections
Used for project selection (`/projects` at line 131-137) and history pagination (`/history`). Pattern: build `InlineKeyboard`, `.text(label, callbackData).row()`, then handle via `bot.callbackQuery(/^prefix:(.+)$/, handler)`.

### Pinned messages
Project selection (line 140-172) and session resume (line 275-301) both pin messages. Pattern:
1. Send/edit a message
2. Unpin previous via `state.pinnedMessageId`
3. Pin new message with `disable_notification: true`
4. Store `pinnedMessageId` in state

### Footer formatting
`telegram.ts:295-305` — `formatFooter()` builds `<i>Project: X | Cost: $Y | Time: Zs</i>`. It receives `projectName` (string) and `result` (StreamResult). To add branch info, either:
- Pass branch as part of `projectName` (simplest, e.g. `"myproject [main]"`)
- Or add a new parameter to `formatFooter` and `streamToTelegram`

### State management
`UserState` (bot.ts:10-14) stores per-user state in-memory:
```ts
type UserState = {
  activeProject: string      // full path like /root/projects/foo
  sessions: Map<string, string>  // projectPath → sessionId
  pinnedMessageId?: number
}
```

### HTML escaping
`escapeHtml()` defined in both `bot.ts:20-22` and `telegram.ts:10-12` (duplicated). Must escape any user-facing git output.

## Dependencies

- **child_process** (`execSync`) — already imported in bot.ts, used for git commands
- **grammy** — `Bot`, `InlineKeyboard`, `Keyboard`, `Context` — all already imported
- **`gh` CLI** — Available in the environment (per CLAUDE.md). Needed for `/pr` command to list PRs. Could also use `git` for branch operations.
- No new npm packages needed.

## Potential impact areas

### Pinned message content
Currently the pinned message after project selection shows `Active project: <name>` (bot.ts:163). Adding branch info changes this message. If a user switches branches outside the bot, the pinned message becomes stale — need to decide if this is acceptable or if branch should be fetched fresh each time.

### Footer changes
`formatFooter` is called from `streamToTelegram` (line 278). The call chain is:
- `handlePrompt()` (bot.ts:305) passes `projectName` to `streamToTelegram()`
- `streamToTelegram()` passes it to `formatFooter()`
- Adding branch to footer requires passing it through this chain

### Keyboard layout
`mainKeyboard` currently has 2 rows: `[Projects, History]` and `[Stop, New]`. Adding more buttons may need a 3rd row or reorganization.

### Branch switching safety
`/branch` command to switch branches could be destructive (uncommitted changes). Need careful UX — confirmation step or at minimum a warning. Also, switching branches mid-session could confuse Claude's context.

### Non-git projects
Not all projects in `PROJECTS_DIR` are git repos. `getGitHubUrl()` already handles this by returning null. All new git helpers must similarly fail gracefully for non-git directories.

## Edge cases and constraints

1. **Detached HEAD state** — `git rev-parse --abbrev-ref HEAD` returns `HEAD` when detached. Should display something like "(detached)" instead.
2. **Non-git directories** — Projects that aren't git repos. All git commands must be wrapped in try/catch.
3. **General mode** — When `activeProject === projectsDir` (the parent dir containing all projects), there's no single git repo. Branch/PR commands should say "not applicable" or similar.
4. **Long branch names** — Git branch names can be very long. May need truncation for display.
5. **Many open PRs** — `gh pr list` could return many results. Should limit output or paginate.
6. **No `gh` auth** — `gh` CLI might not be authenticated for some projects. Need graceful fallback.
7. **Dirty working tree** — Branch switching with uncommitted changes will fail. Need to catch and report this.
8. **Remote-only branches** — `/branch` listing should probably show local branches only to keep it simple. Remote branch switching requires `git fetch` first.
9. **Telegram message length** — PR list or branch list could exceed 4000 char limit. Need truncation.

## Reference implementations

### `getGitHubUrl()` (bot.ts:66-85)
Best reference for git helper functions. Shows the exact pattern: `execSync` + `cwd` + `timeout` + try/catch.

### `/status` command (bot.ts:179-188)
Best reference for adding informational commands. Simple: get state, format string, reply.

### `/projects` with InlineKeyboard (bot.ts:125-172)
Best reference for `/branch` command — uses inline keyboard for selection, callback handler for the selection action.

### Project selection pinned message (bot.ts:140-172)
Reference for updating the pinned message with branch info. Shows the full pin/unpin lifecycle.

### `formatFooter()` (telegram.ts:295-305)
Reference for adding branch to the response footer. Simple array of metadata strings joined with `|`.
