# Completed: Show subagent activity in Telegram UI (#64)

## Changes

### `src/claude.ts`
- Added `task_started` and `task_notification` variants to `StreamEvent` union type
- Added `agent_started` and `agent_done` variants to `ClaudeEvent` union type
- Added parsing logic in `createStreamParser()` to convert system events with `task_started`/`task_notification` subtypes into `agent_started`/`agent_done` ClaudeEvents

### `src/telegram.ts`
- `agent_started`: switches to tools mode and appends an inline status line (`⏳ Agent: <description>`) to the tools message
- `agent_done`: sends a separate italic message with completion status icon (✅/❌), agent description, and optional metadata (duration, token count, tool call count)

## Verification
- TypeScript compiles without errors (`tsc --noEmit` passes)
- All lint warnings are pre-existing; no new warnings introduced
