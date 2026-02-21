# Implementation Checklist: Sanitize ctx.getFile() monkeypatch in bot.ts

- [x] **Task 1: Add optional `fileId` parameter to `saveUploadedFile`**
  - Files: `src/bot.ts`
  - Changes:
    - Change function signature from `async function saveUploadedFile(ctx: Context, filename: string)` to `async function saveUploadedFile(ctx: Context, filename: string, fileId?: string)` (line 364)
    - Replace `const file = await ctx.getFile()` (line 371) with `const file = fileId ? await ctx.api.getFile(fileId) : await ctx.getFile()`
  - Acceptance: `saveUploadedFile` accepts an optional third `fileId` argument. When omitted, behavior is identical to before (calls `ctx.getFile()`). No type errors.

- [ ] **Task 2: Remove monkeypatch and pass `fileId` in photo handler**
  - Files: `src/bot.ts`
  - Changes:
    - Delete the 3-line monkeypatch block (lines 407-409):
      ```
      // Override ctx.getFile to use the largest photo's file_id
      const origGetFile = ctx.getFile.bind(ctx)
      ctx.getFile = () => ctx.api.getFile(largest.file_id) as ReturnType<typeof origGetFile>
      ```
    - Change `const dest = await saveUploadedFile(ctx, filename)` (line 411) to `const dest = await saveUploadedFile(ctx, filename, largest.file_id)`
  - Acceptance: Photo handler no longer mutates `ctx`. `largest.file_id` is passed explicitly to `saveUploadedFile`. No monkeypatch code remains.

- [ ] **Task 3: Verify everything works together**
  - Files: `src/bot.ts`
  - Changes: No code changes. Manual verification:
    1. Run `bun run src/index.ts` — bot starts without errors
    2. Send a photo to the bot — confirm it downloads the largest resolution and processes correctly
    3. Send a document to the bot — confirm document upload still works (regression check, `saveUploadedFile` called without `fileId`)
    4. Verify `message:document` handler call site is unchanged (`saveUploadedFile(ctx, filename)` with no third arg)
  - Acceptance: Bot starts cleanly. Photo uploads fetch the largest size. Document uploads work as before. No runtime errors.
