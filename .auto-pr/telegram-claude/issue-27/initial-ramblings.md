# Auto-unpin old project messages on project switch

> Mark-Life/telegram-claude#27

## Problem
Pinned project messages accumulate when switching between projects. Old pins are not cleaned up.

## Proposal
- Auto-unpin the previous project message when switching to a new project
- Keep only the current active project pinned
- Store the pinned message ID in user state (already partially done via `pinnedMessageId`) and unpin before pinning a new one