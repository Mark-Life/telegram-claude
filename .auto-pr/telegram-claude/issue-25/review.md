# Review: Stream thinking content instead of just timer (#25)

## Status: PASS WITH FIXES

## Issues found

1. **Redundant API call in `thinking_done` handler** (`src/telegram.ts:280`): `flushThinking(true)` was called right before the handler rebuilt the same content with a footer and edited the message again. The first edit was wasted — removed it.

2. **Unnecessary type cast** (`src/telegram.ts:296`): `mode = "none" as MessageMode` — `"none"` is already a valid `MessageMode` literal. Removed the cast to match the existing pattern in the file.

## Confidence level: HIGH

- All 8 plan tasks implemented correctly
- `claude.ts` changes are minimal and clean: new union member + yield in the right branch
- `telegram.ts` follows the exact same throttle/flush/switchMode patterns as existing text and tools modes
- HTML escaping is applied to thinking content before embedding in tags
- Edge cases covered: empty thinking blocks, long content truncation, missing `thinking_start` fallback in the `thinking_delta` handler
- Pre-existing TS errors unrelated to this change (scripts/send-file-to-user.ts, env typing, marked tokens)

## Notes

- The `thinking_done` handler duplicates truncation/formatting logic from `flushThinking`. This is acceptable since `thinking_done` needs to append the footer, making extraction into a shared helper not worth the complexity.
- Thinking content is truncated from the front (keeping the end), which is the right UX choice — the most recent thinking is most relevant.
