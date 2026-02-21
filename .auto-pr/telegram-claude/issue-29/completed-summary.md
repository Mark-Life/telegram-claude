# Completed: Remove unused `formatFooterPlain()` in telegram.ts

## What was done

Removed the dead `formatFooterPlain()` function (lines 307-318) from `src/telegram.ts`. This function was defined but never called anywhere in the codebase.

## Verification

- `grep -r "formatFooterPlain" src/` returns zero results
- `formatFooter()` (the HTML variant that IS used) remains intact at line 295, called at lines 278 and 287
- Bot starts without import/parse errors (only fails on missing env vars, which is expected)
