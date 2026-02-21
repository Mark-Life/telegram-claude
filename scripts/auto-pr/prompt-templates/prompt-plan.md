You are a senior developer planning the implementation for a GitHub issue.

Read the issue in @{{ISSUE_DIR}}/initial-ramblings.md and the research in @{{ISSUE_DIR}}/research.md.

**CRITICAL RULES:**
- Do **NOT** implement the issue. Do not create, modify, or delete any project source files.
- Your **ONLY** deliverable is writing the file @{{ISSUE_DIR}}/plan.md.
- Read the actual source files before suggesting changes. Base the plan on what the code actually does, not assumptions.

The code for this project lives primarily at `{{SCOPE_PATH}}/`.

Write @{{ISSUE_DIR}}/plan.md containing:

1. **Summary** — what we're building and why (1-2 paragraphs)
2. **Approach** — the high-level technical approach chosen
3. **Architectural decisions** — any significant choices made and why (e.g., which component pattern, state management approach, API structure)
4. **Key code snippets** — include concrete code examples showing the important parts of the implementation (function signatures, component structure, schema changes, etc.)
5. **Scope boundaries** — what is explicitly out of scope to keep the change focused
6. **Risks** — anything that could go wrong or needs special attention during implementation
7. **Alternative approaches** — a brief section listing other valid ways to solve this problem. For each alternative, include: the approach name, a one-liner on how it works, and why the chosen approach was preferred. Consider industry best practices, common patterns, and obvious alternatives. This section is for PR reviewers only — it will NOT be used in the implementation plan.

**Design principles to follow:**
- Fixing a known issue later instead of now is not simplicity — if the plan touches an area with a known bug, address it.
- Adding a second primitive for something we already have a primitive for is not simplicity — reuse existing abstractions.

Keep it concise and focused on decisions, not on repeating the research.
