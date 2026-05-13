# Claude Code Functions We Rely On

Analysis of all Claude Code CLI features used by this project, for planning Codex migration.

## CLI Invocation & Flags

| Feature | Description | Where Used | Claude Code Docs |
|---------|-------------|------------|-----------------|
| `claude -p "<prompt>"` | Non-interactive prompt mode — send a prompt and get a response without entering REPL | `src/claude.ts:299` — core invocation | https://docs.anthropic.com/en/docs/claude-code/cli-usage |
| `--output-format stream-json` | Stream structured JSON events (JSONL) to stdout instead of plain text | `src/claude.ts:301` — enables event parsing | https://docs.anthropic.com/en/docs/claude-code/cli-usage#output-format |
| `-r <sessionId>` | Resume a previous conversation session by ID | `src/claude.ts:309-311` — session continuity | https://docs.anthropic.com/en/docs/claude-code/cli-usage |
| `--verbose` | Include additional detail in streaming output | `src/claude.ts:303` | https://docs.anthropic.com/en/docs/claude-code/cli-usage |
| `--include-partial-messages` | Stream partial/intermediate assistant messages (not just final) | `src/claude.ts:304` | https://docs.anthropic.com/en/docs/claude-code/cli-usage |
| `--dangerously-skip-permissions` | Skip all tool permission prompts (headless mode) | `src/claude.ts:305` — required for unattended operation | https://docs.anthropic.com/en/docs/claude-code/cli-usage |
| `--append-system-prompt` | Append custom text to the system prompt | `src/claude.ts:306-307` — injects file-sending capability | https://docs.anthropic.com/en/docs/claude-code/cli-usage |
| `cwd` (working directory) | Claude runs in a specific project directory | `src/claude.ts:327` — `cwd: projectDir` in spawn | Implicit — Claude Code uses cwd for project context |

## Stream JSON Event Types

Events we parse from `--output-format stream-json`. These define the wire protocol.

| Event Type | Description | Where Parsed | Docs |
|------------|-------------|--------------|------|
| `{ type: "system", subtype: "init", session_id }` | First event — provides the session ID for resumption | `src/claude.ts:226-227` | https://docs.anthropic.com/en/docs/claude-code/cli-usage#output-format |
| `{ type: "stream_event", event: { type: "content_block_start", content_block } }` | Start of a content block (text, tool_use, or thinking) | `src/claude.ts:158-175` | Same |
| `{ type: "stream_event", event: { type: "content_block_delta", delta } }` | Incremental content: `text_delta`, `input_json_delta`, `thinking_delta` | `src/claude.ts:176-196` | Same |
| `{ type: "stream_event", event: { type: "content_block_stop" } }` | End of a content block — triggers tool_use emission | `src/claude.ts:198-225` | Same |
| `{ type: "result", subtype, is_error, result, session_id, total_cost_usd, duration_ms, num_turns }` | Final result with cost/duration/turn metadata | `src/claude.ts:250-258` | Same |
| `{ type: "system", subtype: "task_started", task_id, description }` | Subagent/task spawned | `src/claude.ts:228-235` | Same |
| `{ type: "system", subtype: "task_notification", task_id, status, summary, usage }` | Subagent/task completed with stats | `src/claude.ts:237-249` | Same |
| `{ type: "assistant", message, session_id }` | Full assistant message (used with `--include-partial-messages`) | `src/claude.ts:57-60` — type defined but not actively consumed | Same |

## Content Block Types (within stream events)

| Block Type | Description | Where Used |
|------------|-------------|------------|
| `text` / `text_delta` | Main response text, streamed incrementally | `src/claude.ts:164-165, 182-184` -> `src/telegram.ts:429-447` |
| `tool_use` / `input_json_delta` | Tool calls (Read, Write, Edit, Bash, Grep, Glob, etc.) with JSON input | `src/claude.ts:166-169, 185-189, 202-219` -> `src/telegram.ts:448-457` |
| `thinking` / `thinking_delta` | Extended thinking content | `src/claude.ts:170-174, 190-196, 221-224` -> `src/telegram.ts:458-497` |

## Session & History System

We rely on Claude Code's internal file storage for session history.

| Feature | Description | Where Used | Notes |
|---------|-------------|------------|-------|
| Session IDs | Returned via `system.init` event; used with `-r` to resume | `src/claude.ts:227`, `src/bot.ts:837,857-858` | Core to conversation continuity |
| Session JSONL files | Claude stores sessions as `.jsonl` files in `~/.claude/projects/<dir>/` | `src/history.ts:14,126,144` | We read these directly for `/history` command |
| Project storage dir naming | `~/.claude/projects/` + path with `/` replaced by `-` | `src/history.ts:31-33` | e.g. `/root/projects/foo` -> `-root-projects-foo` |
| JSONL structure | Lines contain `{ sessionId, timestamp, cwd, type, message }` | `src/history.ts:64-99` | We parse first few lines for metadata |
| Session-to-project mapping | We cache which session belongs to which project | `src/history.ts:18-22, 166-170` | Enables cross-project session resume |

## Plan Mode

| Feature | Description | Where Used |
|---------|-------------|------------|
| `.claude/plans/` directory | Claude writes plan files here when in plan mode | `src/claude.ts:212-214` — detected via Write tool to plans path |
| `ExitPlanMode` tool | Claude calls this tool when plan is finalized | `src/claude.ts:217-219` — triggers `plan_ready` event |
| Plan file reading | We read the plan file and present it to user with action buttons | `src/bot.ts:659-699` |
| Plan execution (new session) | Clear session, send plan as prompt | `src/bot.ts:701-729` |
| Plan execution (resume) | Keep session, send "approved" prompt | `src/bot.ts:731-755` |
| Plan modification | Send user feedback back to Claude in same session | `src/bot.ts:795-815` |

## Subagent / Task System

| Feature | Description | Where Used |
|---------|-------------|------------|
| `task_started` event | Emitted when Claude spawns a subagent (Agent tool) | `src/claude.ts:228-235` -> `src/telegram.ts:499-505` |
| `task_notification` event | Emitted when subagent completes, with usage stats | `src/claude.ts:237-249` -> `src/telegram.ts:506-524` |
| Usage stats | `total_tokens`, `tool_uses`, `duration_ms` per subagent | `src/claude.ts:33,82-89` |

## Tool Use Tracking

We intercept and display which tools Claude is using.

| Tool Name | What We Extract | Where Used |
|-----------|----------------|------------|
| `Read` | `file_path` | `src/claude.ts:110-111` |
| `Write` | `file_path` (+ plan detection) | `src/claude.ts:112-113, 211-216` |
| `Edit` | `file_path` | `src/claude.ts:114-115` |
| `Bash` | `command` (truncated to 80 chars) | `src/claude.ts:116-119` |
| `Glob` | `pattern` | `src/claude.ts:120-121` |
| `Grep` | `pattern` | `src/claude.ts:122-123` |
| `WebFetch` | `url` | `src/claude.ts:124-125` |
| `WebSearch` | `query` | `src/claude.ts:126-127` |
| `Task` (Agent) | `description` | `src/claude.ts:128-129` |
| `ExitPlanMode` | (triggers plan_ready) | `src/claude.ts:217-219` |

## Environment & Process Management

| Feature | Description | Where Used |
|---------|-------------|------------|
| One process per user | Map of `userId -> AbortController` | `src/claude.ts:100-104, 285-295` |
| 10-minute timeout | Auto-abort after 10 min | `src/claude.ts:105, 334-338` |
| Process abort via signal | `AbortController.signal` passed to `Bun.spawn` | `src/claude.ts:313, 332` |
| `CLAUDECODE` env var removal | Stripped to avoid Claude-inception | `src/claude.ts:320-321` |
| `TELEGRAM_CHAT_ID` env var | Injected so scripts can send files back | `src/claude.ts:324` |
| stderr capture | Collected for error reporting | `src/claude.ts:340-351, 377-378` |

## State Persistence (Our Layer)

Not Claude Code features per se, but our adapter layer that wraps them.

| Feature | Description | Where Used |
|---------|-------------|------------|
| Active project tracking | Which project dir is selected | `src/state.ts:54-57`, `src/bot.ts:262-263` |
| Session map persistence | `projectPath -> sessionId` saved to `.data/state.json` | `src/state.ts:42-51, 60-71` |
| Session clearing (`/new`) | Deletes session mapping so next prompt starts fresh | `src/bot.ts:430-445` |

## Summary: What Codex Needs to Support

For Codex migration, these are the key capabilities needed:

1. **Non-interactive prompt mode** with streaming JSON output
2. **Session resume** by ID
3. **Streaming event protocol** (content blocks, deltas, tool use, thinking)
4. **Subagent/task events** (started, notification with usage)
5. **Plan mode** (write plan file, exit plan mode tool)
6. **Tool use visibility** (which tools are being called and with what args)
7. **Cost/duration/turns metadata** in result event
8. **Session history storage** (browsable, resumable)
9. **Custom system prompt injection**
10. **Headless permission bypass**
