#!/bin/bash
set -euo pipefail

INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).stop_hook_active))")

ERRORS=""

# 1. Auto-fix formatting/lint
FIX_OUTPUT=$(cd "$CLAUDE_PROJECT_DIR" && bun run fix 2>&1) || true

# 2. Lint check
LINT_OUTPUT=$(cd "$CLAUDE_PROJECT_DIR" && bun run lint 2>&1) || {
  ERRORS+="=== Lint errors ===
$LINT_OUTPUT

"
}

# 3. Type check
TSC_OUTPUT=$(cd "$CLAUDE_PROJECT_DIR" && bunx tsc --noEmit 2>&1) || {
  ERRORS+="=== TypeScript errors ===
$TSC_OUTPUT

"
}

if [ -n "$ERRORS" ]; then
  if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
    # Already retried once - don't block again to avoid infinite loop
    echo "$ERRORS" >&2
    exit 0
  fi
  echo "$ERRORS" >&2
  exit 2
fi

exit 0
