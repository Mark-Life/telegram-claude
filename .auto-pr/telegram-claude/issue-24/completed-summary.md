# Completed: Branch/PR awareness in project status (#24)

## What was implemented

### Git helper functions (`src/bot.ts`)
- `getCurrentBranch()` — returns current branch name via `git rev-parse --abbrev-ref HEAD`
- `listBranches()` — returns all local branches via `git branch --format`
- `listOpenPRs()` — returns open PRs via `gh pr list --json`

All follow the existing `execSync` + try/catch + null-on-error pattern.

### Branch info in existing UI
- **Response footer**: Shows `Project: myproject [main]` when in a git repo
- **Pinned message**: Shows `Active project: myproject [main]` on project selection
- **`/status` command**: Includes `Branch: main` line for git projects

### New commands
- **`/branch`** — Shows current branch and lists other local branches (up to 20)
- **`/pr`** — Lists open PRs with clickable links, number, title, and branch name

### Command registration
- Both `/branch` and `/pr` registered in Telegram command menu (index.ts)
- Both added to `/help` output (bot.ts)

## Files modified
- `src/bot.ts` — Git helpers, `/branch`, `/pr`, branch info in pinned msg + status + footer passthrough
- `src/telegram.ts` — Optional `branchName` param in `streamToTelegram`, `formatFooter`, `formatFooterPlain`
- `src/index.ts` — Command menu entries for `/branch` and `/pr`
