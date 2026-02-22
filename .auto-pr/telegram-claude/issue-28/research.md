# Research: Sanitize ctx.getFile() monkeypatch in bot.ts

## Issue Summary

`bot.ts:407-409` monkeypatches `ctx.getFile()` in the `message:photo` handler to override which file_id is fetched. The monkeypatch makes `saveUploadedFile` (which calls `ctx.getFile()` internally) fetch the largest photo size instead of the default. This is fragile and unconventional.

## Relevant Files

### Must modify
- **`src/bot.ts`** — Contains the monkeypatch at lines 407-409 and the `saveUploadedFile` function at lines 364-381 that it exists to support. Also contains the `message:photo` handler (lines 401-422) and `message:document` handler (lines 383-399) that both call `saveUploadedFile`.

### Read-only context
- **`src/claude.ts`** — Not affected. Receives prompt strings, doesn't touch file handling.
- **`src/telegram.ts`** — Not affected. Handles Claude event streaming output.
- **`src/transcribe.ts`** — Not affected. Voice-only transcription.
- **`src/index.ts`** — Not affected. Entry point, passes token to `createBot`.

## The Monkeypatch (current code)

```typescript
// bot.ts:401-422
bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo
    const largest = photos[photos.length - 1]
    const filename = `photo_${Date.now()}.jpg`

    try {
      // Override ctx.getFile to use the largest photo's file_id
      const origGetFile = ctx.getFile.bind(ctx)
      ctx.getFile = () => ctx.api.getFile(largest.file_id) as ReturnType<typeof origGetFile>

      const dest = await saveUploadedFile(ctx, filename)
      // ...
```

**Why it exists:** `ctx.getFile()` on a photo message doesn't necessarily return the largest resolution. Telegram sends multiple photo sizes in `ctx.message.photo[]`. The monkeypatch redirects `ctx.getFile()` to use `ctx.api.getFile(largest.file_id)` so that `saveUploadedFile` fetches the highest-res version.

## saveUploadedFile (the consumer)

```typescript
// bot.ts:364-381
async function saveUploadedFile(ctx: Context, filename: string) {
    const state = getState(ctx.from!.id)
    if (!state.activeProject) {
      await ctx.reply("No project selected...", { reply_markup: mainKeyboard })
      return null
    }

    const file = await ctx.getFile()  // <-- this is what the monkeypatch targets
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    const res = await fetch(url)
    const buffer = Buffer.from(await res.arrayBuffer())

    const dir = join(state.activeProject, "user-sent-files")
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, basename(filename))
    writeFileSync(dest, buffer)
    return dest
}
```

Also used by the `message:document` handler (line 388) and `message:voice` handler (line 339, though voice uses `ctx.getFile()` directly, not via `saveUploadedFile`).

## Existing Patterns

- `ctx.getFile()` — Context-aware shortcut, grammY auto-resolves the file_id from the message context. Works correctly for documents and voice (single file), but ambiguous for photos (multiple sizes).
- `ctx.api.getFile(file_id)` — Direct API call with explicit file_id. Already used inside the monkeypatch itself.
- Voice handler (lines 329-361) downloads files inline without `saveUploadedFile`: calls `ctx.getFile()` directly, constructs URL, fetches buffer.

## Proposed Fix

Refactor `saveUploadedFile` to accept an optional `fileId` parameter. When provided, use `ctx.api.getFile(fileId)` instead of `ctx.getFile()`. This eliminates the monkeypatch entirely.

### Changes required in `saveUploadedFile`:
- Add `fileId?: string` parameter
- Use `fileId ? ctx.api.getFile(fileId) : ctx.getFile()` instead of `ctx.getFile()`

### Changes required in `message:photo` handler:
- Remove the 3-line monkeypatch (lines 407-409)
- Pass `largest.file_id` as the `fileId` argument to `saveUploadedFile`

### No changes needed in:
- `message:document` handler — continues calling `saveUploadedFile(ctx, filename)` without fileId (uses `ctx.getFile()` as before)
- `message:voice` handler — doesn't use `saveUploadedFile`

## Dependencies

- **grammy** (`^1.35.0`) — `ctx.api.getFile(file_id)` is a stable, documented API method (see `node_modules/grammy/out/core/api.d.ts:566`). Return type is `Promise<File>` — same as `ctx.getFile()`.

## Potential Impact Areas

- **Photo uploads** — Primary area of change. Must verify largest photo is still correctly selected and downloaded.
- **Document uploads** — Should be unaffected (no `fileId` passed), but verify nothing regresses.
- No tests exist, no linter configured — manual testing required.

## Edge Cases and Constraints

1. `ctx.message.photo` array is always sorted smallest-to-largest by Telegram, so `photos[photos.length - 1]` is correct for largest.
2. The `token` variable is captured via closure from `createBot`'s parameter — this doesn't change.
3. `ctx.api.getFile()` and `ctx.getFile()` both return `Promise<File>` with `file_path` — no type mismatch.

## Reference Implementation

The voice handler (lines 329-361) demonstrates the "proper" pattern — it calls `ctx.getFile()` directly rather than going through `saveUploadedFile`. The document handler (lines 383-399) shows the clean `saveUploadedFile` usage without any monkeypatch.
