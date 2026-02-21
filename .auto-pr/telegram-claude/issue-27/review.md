# Review: Auto-unpin old project messages on project switch

## Status: PASS

## Issues found
None.

## Confidence level: High

The change is minimal and mechanical — 2 call sites updated identically, 1 type field removed, all references cleaned up. `unpinAllChatMessages` is a well-documented Telegram Bot API method already available in the grammy version used. Zero `pinnedMessageId` references remain in `src/`.

## Notes
- Build verified: `bun build src/index.ts --target bun` succeeds
- The `.catch(() => {})` error-swallowing pattern is consistent with existing code
- `unpinAllChatMessages` is safe for this use case (single-user private chat) but would need revisiting if group chat support is ever added
