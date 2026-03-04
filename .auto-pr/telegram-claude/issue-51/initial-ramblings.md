# Persist bot state to .data/ directory for resume across restarts

> Mark-Life/telegram-claude#51

## Problem

All bot state (active project, Claude session IDs) is lost on restart. User must re-select project and loses conversation continuity.

## Solution

Store state in `.data/` directory (gitignored), similar to `.claude/` pattern.

### Structure

```
.data/
  sessions.json    # { "/path/to/project": "session-id" }
  active-project   # plain text path
```

### Behavior

- Created on first write if missing
- Load on startup, write-through on state changes
- Atomic writes (write-then-rename) for safety
- Add `.data/` to `.gitignore`

### What to persist
- `activeProject` — no re-selecting project on restart
- `sessions` map — resume Claude conversations after restart

### What NOT to persist
- `queue`, `composeMessages` — ephemeral
- Process refs / AbortControllers — runtime-only
- Telegram message IDs — stale after restart

### Side benefit
Also clean up audio buffers (null refs after use) as part of this work.