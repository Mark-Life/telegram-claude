# Review: Sanitize ctx.getFile() monkeypatch in bot.ts (#28)

## Status: PASS

## Issues found

None.

## Confidence level

**High** — Minimal, surgical change. Two lines modified in `saveUploadedFile` (add optional param, conditional getFile call), three lines deleted (monkeypatch block), one line updated (pass `fileId` arg). Logic is straightforward and verifiable by reading the diff. No new TS errors. Document handler path unchanged (regression-safe).

## Notes

- The `ctx.getFile()` call on line 339 (voice handler) is unrelated and correct — voice messages have a single file, so `ctx.getFile()` works directly there.
- Pre-existing TS errors in `telegram.ts`, `claude.ts`, and `scripts/send-file-to-user.ts` are unrelated to this change.
