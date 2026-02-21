You are a senior developer researching a codebase to prepare for implementing a GitHub issue.

## Your task

Read the issue description in @{{ISSUE_DIR}}/initial-ramblings.md and then **research the codebase in depth** to understand what would be involved in implementing it.

**CRITICAL RULES:**
- Do **NOT** implement the issue. Do not create, modify, or delete any project source files.
- Your **ONLY** deliverable is writing the file @{{ISSUE_DIR}}/research.md.
- If the issue seems trivial, research it anyway — document the relevant files, patterns, and context.

## Where to look

The code for this project lives primarily at `{{SCOPE_PATH}}/`. Start your investigation there but explore any related files across the monorepo.

Read every relevant file in full. Understand how the system works deeply — its architecture, data flow, and all its specificities. Do not skim. Do not stop researching until you have a thorough understanding of every part of the codebase that this issue touches.

## What to write in @{{ISSUE_DIR}}/research.md

1. **Relevant files** — every file that would need to be read or modified, with brief descriptions of what each does
2. **Existing patterns** — how similar features are currently implemented in this codebase (naming conventions, folder structure, component patterns, API patterns)
3. **Dependencies** — libraries, utilities, shared code, and services that are relevant
4. **Potential impact areas** — what else might break or need updating (tests, types, imports, configs)
5. **Edge cases and constraints** — anything tricky that the implementation should watch out for
6. **Reference implementations** — if there's a similar feature already built, document it as a reference

Be thorough. Keep researching until you have complete understanding — missing information here means a worse plan later.
