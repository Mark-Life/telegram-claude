# Implementation Checklist: Fix plan display truncation (#56)

- [x] **Task 1: Add `splitText()` utility to `telegram.ts`**
  - Files: `src/telegram.ts`
  - Changes: Add a new exported function `splitText(text: string, maxLen = MAX_MSG_LENGTH): string[]` after the `MAX_MSG_LENGTH` constant declaration. The function loops over the text, finds the last `\n` before `maxLen`, falls back to hard cut at `maxLen` if no newline found in the last 50%, pushes each chunk, and returns the array. Include a JSDoc comment.
  - Acceptance: `splitText` is exported from `telegram.ts`. A string under 4000 chars returns a single-element array. A string over 4000 chars splits at `\n` boundaries. A string over 4000 chars with no newlines splits at exactly 4000.

- [x] **Task 2: Replace truncation logic in `presentPlan()` with multi-message sending**
  - Files: `src/bot.ts`
  - Changes:
    1. Add import: `import { splitText } from "./telegram.js";` (add to existing imports from `./telegram.js` if any, or as new import)
    2. In `presentPlan()`, remove the truncation block (the `maxLen` constant, the ternary that appends `... (truncated)`, and the single `sendMessage` call for plan content)
    3. Replace with: `const chunks = splitText(planContent);` then `for (const chunk of chunks) { await ctx.api.sendMessage(ctx.chat!.id, chunk); }`
    4. Keep the existing follow-up message with `InlineKeyboard` buttons unchanged — it already sends as a separate message after the plan content
  - Acceptance: Plans under 4000 chars display as a single message (no truncation suffix). Plans over 4000 chars display as multiple sequential messages. The inline keyboard buttons still appear after the last plan chunk. No `... (truncated)` text appears anywhere.

- [x] **Task 3: Verify everything works together**
  - Files: `src/bot.ts`, `src/telegram.ts`
  - Changes: Run `bun run lint` to ensure no lint/format errors. Review that `splitText` import resolves correctly. Verify no other code references the removed `maxLen` / truncation logic in `presentPlan()`.
  - Acceptance: `bun run lint` passes. The bot can be started with `bun run src/index.ts` without import errors. The `presentPlan()` function sends plan content via `splitText()` chunks followed by the button message.
