# Completed: Auto-unpin old project messages on project switch

## Problem
Pinned project messages accumulated when switching between projects. The bot tracked `pinnedMessageId` in in-memory state, so pins from before a bot restart were never cleaned up.

## Solution
Replaced targeted `unpinChatMessage(pinnedMessageId)` with `unpinAllChatMessages(chatId)` in both the project switch and session resume handlers. This ensures all stale pins are cleared before pinning the new message, regardless of bot restarts or state loss.

## Changes
- **`src/bot.ts`**: Removed `pinnedMessageId` field from `UserState` type. Replaced targeted unpin calls with `unpinAllChatMessages` in both `project:` and `session:` callback handlers. Removed all `state.pinnedMessageId` assignments.

## Result
Only one pinned message (the current active project/session) exists at any time, even across bot restarts.
