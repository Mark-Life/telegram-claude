# Research: Remove unused formatFooterPlain() in telegram.ts

## Issue Summary

`formatFooterPlain()` at `src/telegram.ts:308-318` is defined but never called. It should be removed.

## Relevant Files

| File | Role |
|------|------|
| `src/telegram.ts` | **Only file to modify.** Contains both `formatFooter()` (HTML, used) and `formatFooterPlain()` (plain text, unused). |

No other files reference `formatFooterPlain` — confirmed via project-wide grep.

## Existing Patterns

- `formatFooter()` (lines 295-305) is the HTML variant, called at lines 278 and 287 within `streamToTelegram()`.
- `formatFooterPlain()` (lines 308-318) is the plain-text variant, identical logic minus `escapeHtml()` and `<i>` wrapping.
- Both are **module-private** (no `export` keyword). Neither is re-exported elsewhere.
- `StreamResult` type (lines 123-128) is used by both functions but will still be needed by `formatFooter()`.

## Dependencies

None relevant. The function has no external dependencies — it only uses `StreamResult` (local type) and basic string operations.

## Potential Impact Areas

- **Zero impact.** The function is never called, never exported, and never referenced by any other file.
- No tests exist in this project, so no test updates needed.
- No config or type changes needed — `StreamResult` remains in use by `formatFooter()`.

## Edge Cases and Constraints

- None. This is a pure dead-code removal.

## Reference Implementations

- `formatFooter()` at lines 295-305 is the kept sibling — same logic but produces HTML output with `<i>` tags and `escapeHtml()`.

## Implementation

Delete lines 307-318 (the JSDoc comment + function body of `formatFooterPlain`).
