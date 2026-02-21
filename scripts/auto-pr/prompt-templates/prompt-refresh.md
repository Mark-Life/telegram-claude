You are updating an existing auto-pr branch to be compatible with the latest {{MAIN_BRANCH}}.

## Context

Read these files to understand what this PR is doing:
- Original issue: @{{ISSUE_DIR}}/initial-ramblings.md
- Implementation plan: @{{ISSUE_DIR}}/plan-implementation.md
- What was implemented: @{{ISSUE_DIR}}/completed-summary.md

## Your task

1. Run `git diff {{MAIN_BRANCH}}...HEAD` to see what this PR currently changes vs {{MAIN_BRANCH}}
2. Run `git log {{MAIN_BRANCH}}..HEAD --oneline` to see the PR's commit history
3. Run `git diff HEAD...{{MAIN_BRANCH}}` to see what {{MAIN_BRANCH}} has changed since this branch diverged
4. Analyze whether the PR's changes are still valid:
   - Do imports still resolve? Have moved/renamed files been accounted for?
   - Do APIs/types used by the PR still exist and have the same signatures?
   - Are there conflicts with new code on {{MAIN_BRANCH}} that touches the same areas?
5. If you find issues:
   - Fix the code directly to work with current {{MAIN_BRANCH}}
   - Commit fixes: `fix(scope): adapt to {{MAIN_BRANCH}} changes`
6. If everything looks fine, note that no changes were needed.

The code for this project lives primarily at `{{SCOPE_PATH}}/`.

**CRITICAL RULES:**
- Do NOT re-implement the feature. Only fix what's broken due to {{MAIN_BRANCH}} changes.
- If {{MAIN_BRANCH}} has changed so fundamentally that the PR's approach is no longer viable (e.g., the module was refactored, APIs were replaced entirely), do NOT attempt to force a fix. Report `NEEDS-ATTENTION` with a clear explanation of what changed and why the current implementation can't be salvaged with minor fixes.
- Do NOT push to remote — the pipeline handles that.
- Do NOT modify the plan or research files.

Write a summary of what you did to @{{ISSUE_DIR}}/refresh-summary.md with:
- **Status**: UP-TO-DATE, ADAPTED, or NEEDS-ATTENTION
- **Changes made** (if any) — what broke and how you fixed it
- **Risk areas** — anything a reviewer should double-check
