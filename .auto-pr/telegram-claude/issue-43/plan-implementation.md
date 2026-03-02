# Implementation: Fix session ID loss on Force Send (abort)

- [x] **Task 1: Add `session_init` kind to `ClaudeEvent` type**
  - Files: `src/claude.ts`
  - Changes: Add `| { kind: "session_init"; sessionId: string }` to the `ClaudeEvent` union type (line 36-44), inserting it as the first variant before `text_delta`.
  - Acceptance: TypeScript compiles without errors. The `ClaudeEvent` type includes `session_init` as a valid kind.

- [x] **Task 2: Yield `session_init` event from stream parser**
  - Files: `src/claude.ts`
  - Changes: In `createStreamParser`'s `parseStreamLines` generator (line 87-167), add a new `else if` branch after the `content_block_stop` handler (line 155) and before the `result` handler (line 156):
    ```ts
    } else if (parsed.type === "system" && parsed.subtype === "init") {
      yield { kind: "session_init", sessionId: parsed.session_id }
    }
    ```
    This catches the `system.init` StreamEvent (already defined at line 15) and yields it as a `ClaudeEvent`.
  - Acceptance: When Claude CLI emits a `system.init` JSON line, the parser yields `{ kind: "session_init", sessionId: "<id>" }`. Other event handling is unchanged.

- [x] **Task 3: Capture `session_init` in `streamToTelegram`**
  - Files: `src/telegram.ts`
  - Changes: In `streamToTelegram`'s event loop (line 262-316), add an `else if` branch for `session_init` before the `result` handler (line 297). Insert after the `plan_ready` branch (line 294-296):
    ```ts
    } else if (event.kind === "session_init") {
      result.sessionId = event.sessionId
    }
    ```
    This sets `result.sessionId` immediately when the stream starts. If the `result` event arrives later (normal completion), it overwrites with the same value. If the process is aborted, the early value persists.
  - Acceptance: `streamToTelegram` returns `result.sessionId` set to the session ID even when the Claude process is aborted before emitting a `result` event. The existing `result` event handler (line 298) still works and overwrites `sessionId` on normal completion.

- [x] **Task 4: Verify everything works together**
  - Files: `src/claude.ts`, `src/telegram.ts`, `src/bot.ts`
  - Changes: No code changes. Verify the full flow:
    1. Run `bun run src/index.ts` — bot starts without errors
    2. Normal flow: Send a message, let it complete — session ID saved from `result` event, follow-up messages continue the conversation (same as before)
    3. Abort flow: Send a message, while it's running send another (Force Send) — the aborted process still provides the session ID via `session_init`, so the next message continues the same conversation instead of starting fresh
    4. Plan mode abort: If a plan-mode interaction is force-sent, the `result.sessionId` in `presentPlan` (bot.ts:379) still receives the session ID
    5. `bot.ts` requires no changes — the existing `if (result.sessionId)` check (line 530) works because `streamToTelegram` now always returns the session ID
  - Acceptance: Force Send no longer loses conversation history. Sequential messages after an abort continue the same Claude session.
