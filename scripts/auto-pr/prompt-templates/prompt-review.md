You are reviewing code changes for the issue described in @{{ISSUE_DIR}}/initial-ramblings.md. The implementation plan in @{{ISSUE_DIR}}/plan-implementation.md describes what should have been done.

Review the changes by running `git diff {{MAIN_BRANCH}}...HEAD` and check for:

1. **Correctness** — do the changes actually implement what the plan describes?
2. **Missing imports** — are all imports present and correct?
3. **Type errors** — any obvious TypeScript issues?
4. **Unused code** — variables, imports, or functions that were added but never used?
5. **Pattern consistency** — do the changes follow the existing codebase patterns?
6. **Security issues** — any command injection, XSS, SQL injection, or other vulnerabilities?
7. **Edge cases** — anything that could break under unusual input or conditions?
8. **Incomplete work** — TODO comments, placeholder values, or unfinished implementations?

If you find issues:
- Fix them directly (edit the files)
- Make a separate commit for the fixes: `fix(scope): review fixes for issue #N`

Write your review summary to @{{ISSUE_DIR}}/review.md with:
- **Status**: PASS or PASS WITH FIXES
- **Issues found** (if any) — what was wrong and what you fixed
- **Confidence level** — how confident you are the implementation is correct (high/medium/low)
- **Notes** — anything the PR reviewer should pay attention to
- **Recommended follow-ups** — only include this section if you discovered genuinely valuable insights during the review. These should be high-signal recommendations, not minor noise. Examples of what qualifies:
  - An existing primitive/utility that almost does what's needed but requires small changes to be reusable across the codebase
  - A pattern inconsistency across the codebase that this change exposed
  - A related improvement that would significantly benefit from the deep context gained during this issue
  - Technical debt that directly affects the area touched by this change
  For each follow-up, write it as a potential issue title + 1-2 sentence description of what and why. Omit this section entirely if there's nothing worth flagging.
