# Support parallel work using git worktrees

> Mark-Life/telegram-claude#39

**Idea:** Enable parallel task execution by leveraging git worktrees.

Currently the bot works in a single project directory, so only one task can run at a time per project. With worktrees, the bot could spin up isolated working copies for concurrent tasks — e.g. working on multiple issues/PRs simultaneously without conflicts.

Details TBD.