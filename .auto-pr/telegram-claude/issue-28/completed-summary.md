# Completed: Sanitize ctx.getFile() monkeypatch in bot.ts

## What was done

Replaced the `ctx.getFile()` monkeypatch in the photo handler with a clean parameter-passing approach.

### Changes (src/bot.ts)

1. **`saveUploadedFile` now accepts an optional `fileId` parameter** — when provided, calls `ctx.api.getFile(fileId)` directly instead of `ctx.getFile()`. When omitted, behavior is unchanged.

2. **Removed the 3-line monkeypatch** in the `message:photo` handler that was overriding `ctx.getFile`. Instead, `largest.file_id` is passed as the third argument to `saveUploadedFile`.

3. **Document handler unchanged** — still calls `saveUploadedFile(ctx, filename)` with no `fileId`, preserving existing behavior.

## Verification

- TypeScript type-check passes for `src/bot.ts` (no new errors)
- Document handler call site unchanged (regression-safe)
- No monkeypatch code remains
