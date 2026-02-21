# Implementation Checklist: Branch/PR awareness in project status (#24)

- [ ] **Task 1: Add git helper functions to bot.ts**
  - Files: `src/bot.ts`
  - Changes: Add three functions right after `getGitHubUrl()` (after line 85):
    - `getCurrentBranch(projectPath: string)` — runs `git rev-parse --abbrev-ref HEAD` with `execSync`, `cwd: projectPath`, `timeout: 3000`. Returns branch name string, `"(detached)"` if HEAD, or `null` on error.
    - `listBranches(projectPath: string)` — runs `git branch --format='%(refname:short)'`, same pattern. Returns `string[]` or `null`.
    - `listOpenPRs(projectPath: string)` — runs `gh pr list --state open --json number,title,headRefName,url --limit 10` with `timeout: 10000`. Parses JSON, returns typed array `{ number, title, headRefName, url }[]` or `null`.
  - Acceptance: Functions exist, follow exact `execSync` + try/catch + null-on-error pattern of `getGitHubUrl`. No callers yet.

- [ ] **Task 2: Add branch info to response footer in telegram.ts**
  - Files: `src/telegram.ts`
  - Changes:
    - Add `branchName?: string | null` parameter to `streamToTelegram` (line 133, after `projectName`).
    - Add `branchName?: string | null` parameter to `formatFooter` (line 295, after `projectName`).
    - Add `branchName?: string | null` parameter to `formatFooterPlain` (line 308, after `projectName`).
    - In `formatFooter`: change the project line from `Project: ${escapeHtml(projectName)}` to `Project: ${branchName ? `${escapeHtml(projectName)} [${escapeHtml(branchName)}]` : escapeHtml(projectName)}`.
    - In `formatFooterPlain`: same logic but without `escapeHtml`.
    - In `streamToTelegram`: pass `branchName` through to both `formatFooter` calls (lines 278 and 287).
  - Acceptance: `streamToTelegram` accepts optional `branchName` param and includes `[branchName]` in footer when provided. Existing callers still work without the param (it's optional).

- [ ] **Task 3: Pass branch name from handlePrompt to streamToTelegram in bot.ts**
  - Files: `src/bot.ts`
  - Changes: In `handlePrompt()` (line 305), after computing `projectName` (line 314):
    - Add: `const branchName = state.activeProject !== projectsDir ? getCurrentBranch(state.activeProject) : null`
    - Change line 317 from `streamToTelegram(ctx, events, projectName)` to `streamToTelegram(ctx, events, projectName, branchName)`
  - Acceptance: Claude responses show `Project: myproject [main]` in the footer when the project is a git repo with a branch.

- [ ] **Task 4: Add branch info to pinned message on project selection**
  - Files: `src/bot.ts`
  - Changes: In the `project:*` callback handler (line 140), after `const ghUrl = ...` (line 159):
    - Add: `const branch = isGeneral ? null : getCurrentBranch(fullPath)`
    - Add: `const branchSuffix = branch ? ` [${escapeHtml(branch)}]` : ""`
    - Change line 163 from `Active project: ${projectLabel}` to `Active project: ${projectLabel}${branchSuffix}`
  - Acceptance: Pinned message shows `Active project: myproject [main]` after selecting a git project. Non-git projects show no branch suffix.

- [ ] **Task 5: Add branch info to /status command**
  - Files: `src/bot.ts`
  - Changes: In the `/status` handler (line 179):
    - After `const sessionCount = ...` (line 185), add: `const branch = state.activeProject && state.activeProject !== projectsDir ? getCurrentBranch(state.activeProject) : null`
    - Add: `const branchLine = branch ? `\nBranch: ${branch}` : ""`
    - Change line 187 reply to append `${branchLine}` at the end of the status string.
  - Acceptance: `/status` reply includes `Branch: main` line when active project is a git repo. No branch line for non-git or general mode.

- [ ] **Task 6: Add /branch command**
  - Files: `src/bot.ts`
  - Changes: Add `bot.command("branch", ...)` handler after the `/help` command block (after line 205). Implementation:
    - Get state, check `activeProject` exists and isn't `projectsDir` — reply "No project selected or in general mode." if not.
    - Call `getCurrentBranch(state.activeProject)` — reply "Not a git repository." if null.
    - Call `listBranches(state.activeProject)` for the full branch list.
    - Format response: project name bold, current branch in `<code>`, then list other branches (up to 20) each in `<code>`.
    - Reply with `parse_mode: "HTML"` and `reply_markup: mainKeyboard`.
  - Acceptance: `/branch` shows current branch and lists other local branches. Handles non-git projects and general mode gracefully.

- [ ] **Task 7: Add /pr command**
  - Files: `src/bot.ts`
  - Changes: Add `bot.command("pr", ...)` handler right after the `/branch` handler. Implementation:
    - Get state, check `activeProject` exists and isn't `projectsDir` — reply "No project selected or in general mode." if not.
    - Call `listOpenPRs(state.activeProject)`.
    - If null: reply "Could not fetch PRs. Is gh CLI authenticated?"
    - If empty array: reply "No open PRs."
    - Otherwise: format each PR as `#N <a href="url">title</a> (<code>branch</code>)`, join with newlines.
    - Reply with `parse_mode: "HTML"` and `reply_markup: mainKeyboard`.
  - Acceptance: `/pr` lists open PRs with clickable links. Shows appropriate messages for no PRs, auth failures, and non-project contexts.

- [ ] **Task 8: Register new commands in index.ts and update help text in bot.ts**
  - Files: `src/index.ts`, `src/bot.ts`
  - Changes:
    - In `src/index.ts`: add two entries to the `commands` array (line 50-57):
      - `{ command: "branch", description: "Show current git branch" }`
      - `{ command: "pr", description: "List open pull requests" }`
    - In `src/bot.ts`: add two lines to the `/help` command's text array (line 190-204):
      - `/branch — show current git branch`
      - `/pr — list open pull requests`
  - Acceptance: `/branch` and `/pr` appear in the Telegram command menu (the `/` autocomplete). `/help` output lists both new commands.

- [ ] **Task 9: Verify everything works together**
  - Files: all modified files (`src/bot.ts`, `src/telegram.ts`, `src/index.ts`)
  - Changes: No new changes. Run `bun run src/index.ts` and verify:
    1. Bot starts without errors
    2. Select a git project → pinned message shows branch
    3. Send a message → footer includes `[branchName]`
    4. `/status` shows branch line
    5. `/branch` shows current + other branches
    6. `/pr` lists open PRs (or graceful error)
    7. Select a non-git project → no branch info anywhere, no errors
    8. General mode → `/branch` and `/pr` say "not applicable"
  - Acceptance: All 8 scenarios pass. No TypeScript errors on startup.
