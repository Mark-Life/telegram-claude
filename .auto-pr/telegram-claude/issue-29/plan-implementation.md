# Implementation: Remove unused `formatFooterPlain()` in telegram.ts

- [ ] **Task 1: Delete `formatFooterPlain()` function**
  - Files: `src/telegram.ts`
  - Changes: Remove lines 307-318 — the JSDoc comment (`/** Format metadata footer as plain text */`) and the entire `formatFooterPlain` function body. Keep `formatFooter()` (lines 294-305) and `StreamResult` type untouched. The file should end at what is currently line 306 (blank line after `formatFooter`), or line 305 followed by a trailing newline.
  - Acceptance: `formatFooterPlain` no longer exists in the file. `formatFooter()` still present and unchanged. No TypeScript compilation errors (`bun run src/index.ts` doesn't crash on import).

- [ ] **Task 2: Verify everything works together**
  - Files: `src/telegram.ts`
  - Changes: None — verification only.
  - Acceptance:
    - `grep -r "formatFooterPlain" src/` returns no results
    - `bun run src/index.ts` starts without errors (can immediately Ctrl+C — just checking no import/parse failures)
    - `formatFooter()` is still present and called at lines ~278 and ~287 in `streamToTelegram()`
