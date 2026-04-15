# Implementation Checklist: Show subagent activity in Telegram UI (#64)

- [x] **Task 1: Add StreamEvent variants for agent lifecycle events**
  - Files: `src/claude.ts`
  - Changes: Add two new variants to the `StreamEvent` union type (after the existing `system/init` variant at line 20):
    - `{ type: "system"; subtype: "task_started"; task_id: string; description: string }` — emitted when a subagent spawns
    - `{ type: "system"; subtype: "task_notification"; task_id: string; status: string; summary: string; usage?: { total_tokens: number; tool_uses: number; duration_ms: number } }` — emitted when a subagent completes
  - Acceptance: TypeScript compiles. The `StreamEvent` union accepts both new shapes.

- [x] **Task 2: Add ClaudeEvent kinds for agent events**
  - Files: `src/claude.ts`
  - Changes: Add two new variants to the `ClaudeEvent` union type (after `plan_ready` at line 65):
    - `{ kind: "agent_started"; taskId: string; description: string }`
    - `{ kind: "agent_done"; taskId: string; description: string; status: string; durationMs?: number; totalTokens?: number; toolUses?: number }`
  - Acceptance: TypeScript compiles. `ClaudeEvent` type includes both new kinds.

- [x] **Task 3: Parse agent events in createStreamParser**
  - Files: `src/claude.ts`
  - Changes: In `createStreamParser()`, add two `else if` branches after the `system/init` handler (line 202-203):
    - When `parsed.type === "system" && parsed.subtype === "task_started"`: yield `{ kind: "agent_started", taskId: parsed.task_id, description: parsed.description }`
    - When `parsed.type === "system" && parsed.subtype === "task_notification"`: yield `{ kind: "agent_done", taskId: parsed.task_id, description: parsed.summary, status: parsed.status, durationMs: parsed.usage?.duration_ms, totalTokens: parsed.usage?.total_tokens, toolUses: parsed.usage?.tool_uses }`
  - Acceptance: TypeScript compiles. Manually verifiable by adding a console.log and feeding test JSON lines.

- [x] **Task 4: Handle agent_started in streamToTelegram**
  - Files: `src/telegram.ts`
  - Changes: In the `for await` event loop (line 428), add an `else if` branch for `event.kind === "agent_started"` (before the `session_init` handler at line 499):
    - If `mode !== "tools"`: call `switchMode("tools")` and `sendNew("...")`
    - Push `⏳ Agent: ${event.description}` to `toolLines`
    - Call `flushTools().catch(() => {})`
    This reuses the existing tools mode — agent start lines appear alongside tool use lines as italic text.
  - Acceptance: When a `agent_started` event arrives, the bot switches to tools mode (if not already) and shows `⏳ Agent: <description>` as an italic line in the tools message.

- [x] **Task 5: Handle agent_done in streamToTelegram**
  - Files: `src/telegram.ts`
  - Changes: In the `for await` event loop, add an `else if` branch for `event.kind === "agent_done"` (right after the `agent_started` handler):
    - Build a status line: use ✅ if `event.status === "completed"`, else ❌
    - Append `Agent: ${event.description}`
    - Build metadata parts array: duration as `X.Xs`, tokens as `X.Xk tokens`, tool calls as `N tool calls` — only include if defined
    - Join metadata with `, ` and wrap in parens if non-empty
    - Send as a standalone message via `safeSendMessage(ctx, chatId, `<i>${escapeHtml(line)}</i>`, line)`
    This does NOT change the current mode — it sends a fire-and-forget summary message.
  - Acceptance: When a `agent_done` event arrives, a separate italic message appears like: `✅ Agent: Find all TS files (3.4s, 15.5k tokens, 2 tool calls)` or `❌ Agent: Find all TS files`

- [x] **Task 6: Verify everything works together**
  - Files: none (manual testing)
  - Changes: Start the bot (`bun run src/index.ts`), send a prompt that triggers subagent usage (e.g., a complex task that spawns Agent tool calls). Verify:
    1. `⏳ Agent: <description>` appears inline in the tools message when an agent starts
    2. A separate completion message appears when the agent finishes, with ✅/❌ and metadata
    3. Multiple concurrent agents each get their own start line and completion message
    4. Normal tool use, text streaming, and thinking still work correctly
    5. Run `bun run lint` passes with no errors
  - Acceptance: All 5 checks pass. No regressions in existing functionality.
