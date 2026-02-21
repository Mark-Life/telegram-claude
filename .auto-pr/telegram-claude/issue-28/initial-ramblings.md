# Sanitize ctx.getFile() monkeypatch in bot.ts

> Mark-Life/telegram-claude#28

## Problem
bot.ts:408-409 monkeypatches \`ctx.getFile()\` for photo handling. This is unconventional and fragile — could break on grammY updates.

## Proposal
- Replace the monkeypatch with the proper grammY API for fetching photo files
- Use \`ctx.api.getFile()\` or the appropriate method directly
- Ensure photo download still works correctly after the change