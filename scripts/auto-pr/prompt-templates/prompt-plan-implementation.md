You are breaking down a plan into a detailed, ordered implementation checklist.

Read the issue in @{{ISSUE_DIR}}/initial-ramblings.md, the research in @{{ISSUE_DIR}}/research.md, and the plan in @{{ISSUE_DIR}}/plan.md.

**CRITICAL RULES:**
- Do **NOT** implement the issue. Do not create, modify, or delete any project source files.
- Your **ONLY** deliverable is writing the file @{{ISSUE_DIR}}/plan-implementation.md.

The code for this project lives primarily at `{{SCOPE_PATH}}/`.

Write @{{ISSUE_DIR}}/plan-implementation.md with:

- An **ordered task list using markdown checkboxes** (`- [ ]` for each task)
- Each task should be small enough to implement in one focused session
- For each task:
  - **Files to modify** — specific file paths
  - **What to change** — concrete description of the changes (not vague like "update the component")
  - **Acceptance criteria** — how to verify this task is done correctly
- Tasks should be ordered so each builds on the previous (no forward dependencies)
- Include any necessary setup tasks (new files to create, dependencies to add, etc.)
- The final task should always be "verify everything works together"

IMPORTANT: Every task MUST use the `- [ ]` checkbox format. Example:

```
- [ ] **Task 1: Create the API endpoint**
  - Files: `src/server/routes/foo.ts`
  - Changes: Add GET /api/foo endpoint that returns...
  - Acceptance: Endpoint responds with 200 and correct shape
```

Be specific enough that a developer could follow this checklist without needing to re-read the research or plan.
