# Plan: Sanitize ctx.getFile() monkeypatch in bot.ts

## Summary

`bot.ts:407-409` monkeypatches `ctx.getFile()` in the photo handler so `saveUploadedFile` fetches the largest photo size. This is fragile — mutating framework context objects can break on grammY updates and makes the code harder to follow.

Fix: add an optional `fileId` param to `saveUploadedFile`. Photo handler passes `largest.file_id` directly instead of patching the context.

## Approach

Parameterize `saveUploadedFile` to accept an explicit file ID. When provided, call `ctx.api.getFile(fileId)` instead of `ctx.getFile()`. Remove the monkeypatch entirely.

## Architectural decisions

- **Optional param vs overload vs separate function**: Optional param is simplest — one function, backward-compatible call site for documents, no duplication.
- **`ctx.api.getFile(fileId)` vs `ctx.getFile()`**: Both return `Promise<File>`. `ctx.api.getFile()` is the stable, documented API method already used inside the current monkeypatch itself.

## Key code snippets

### `saveUploadedFile` — add `fileId` param

```typescript
async function saveUploadedFile(ctx: Context, filename: string, fileId?: string) {
    const state = getState(ctx.from!.id)
    if (!state.activeProject) {
      await ctx.reply("No project selected. Use /projects to pick one.", { reply_markup: mainKeyboard })
      return null
    }

    const file = fileId ? await ctx.api.getFile(fileId) : await ctx.getFile()
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    // ... rest unchanged
```

### `message:photo` handler — remove monkeypatch, pass fileId

```typescript
bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo
    const largest = photos[photos.length - 1]
    const filename = `photo_${Date.now()}.jpg`

    try {
      const dest = await saveUploadedFile(ctx, filename, largest.file_id)
      if (!dest) return
      // ... rest unchanged
```

### `message:document` handler — no change

Continues calling `saveUploadedFile(ctx, filename)` without `fileId`.

## Scope boundaries

- **In scope**: Refactor `saveUploadedFile` signature, update photo handler call site, remove monkeypatch.
- **Out of scope**: Voice handler refactoring (doesn't use `saveUploadedFile`), adding tests, changing document handler.

## Risks

1. **Type mismatch**: `ctx.api.getFile()` returns `Promise<File>` same as `ctx.getFile()` — verified in grammy types. No risk.
2. **No test suite**: Manual testing required for photo uploads after the change. Document uploads should be retested to confirm no regression.
3. **Minimal blast radius**: Only `saveUploadedFile` signature and photo handler call site change. Document handler is untouched.

## Alternative approaches

1. **Pass the `File` object directly** — Caller fetches the file and passes it to a save function. More explicit but duplicates fetch logic across handlers and changes the abstraction boundary. Chosen approach keeps fetch logic centralized in `saveUploadedFile`.

2. **Separate `saveUploadedFileById` function** — Dedicated function that always takes a file ID. Avoids optional param but introduces a second primitive for the same operation, violating DRY. Chosen approach keeps one function.

3. **Refactor voice handler to also use `saveUploadedFile`** — Would unify all file download paths. Out of scope for this issue — voice has different post-download behavior (transcription, not saving) and mixing concerns would over-complicate `saveUploadedFile`.
