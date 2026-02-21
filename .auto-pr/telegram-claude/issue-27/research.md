# Research: Auto-unpin old project messages on project switch

## Issue Summary

Pinned project messages accumulate when the bot restarts because `pinnedMessageId` is stored only in-memory (`UserState`). On restart, the state is lost, so the bot can't unpin the old message before pinning a new one.

The unpin-before-pin logic **already exists** in two places (bot.ts:164-171 and bot.ts:294-301), but it only works within a single bot session.

## Relevant Files

| File | Role |
|---|---|
| `src/bot.ts` | **Primary change target.** Contains `UserState` type (L10-14), project switch handler (L140-172), session resume handler (L275-302), and `getState()` (L39-46). All pin/unpin logic lives here. |
| `src/index.ts` | Entry point. No changes needed. |
| `src/telegram.ts` | Message streaming. Not involved in pinning. |
| `src/claude.ts` | Claude process management. Not involved. |
| `src/history.ts` | Session history. Not involved. |

## Existing Patterns

### Current pin/unpin flow (bot.ts:140-172, project switch)

```ts
// 1. Edit the callback message to show "Active project: X"
const msg = await ctx.editMessageText(`Active project: ${projectLabel}`, { parse_mode: "HTML" })
// 2. Unpin previous (if tracked in memory)
if (state.pinnedMessageId) {
  await ctx.api.unpinChatMessage(chatId, state.pinnedMessageId).catch(() => {})
}
// 3. Pin the new message
const pinnedId = typeof msg === "object" && "message_id" in msg ? msg.message_id : undefined
if (pinnedId) {
  await ctx.api.pinChatMessage(chatId, pinnedId, { disable_notification: true }).catch(() => {})
  state.pinnedMessageId = pinnedId
}
```

Same pattern duplicated in session resume handler (bot.ts:275-302).

### State management

- `UserState` type at L10-14 already has `pinnedMessageId?: number`
- State is per-user, in-memory only (`Map<number, UserState>`)
- No persistence mechanism exists

### Error handling pattern

All Telegram API calls for pin/unpin use `.catch(() => {})` — silent failure is the convention.

## Dependencies

- **grammy** — Provides `ctx.api.unpinChatMessage(chatId, messageId)`, `ctx.api.unpinAllChatMessages(chatId)`, `ctx.api.pinChatMessage(chatId, messageId, opts)`
- All three methods already available in the grammy version used (^1.35.0)

## Root Cause Analysis

The bug is that `pinnedMessageId` is lost on bot restart:

1. User switches to project A → message A pinned, `state.pinnedMessageId = A`
2. Bot restarts → `userStates` Map is empty
3. User switches to project B → `state.pinnedMessageId` is undefined → old pin A is NOT unpinned → message B also pinned
4. Result: both A and B pinned

## Implementation Approaches

### Approach 1: Use `unpinAllChatMessages` before pinning (simplest)

Replace the targeted `unpinChatMessage` call with `unpinAllChatMessages`. This nukes all bot-pinned messages before pinning the new one.

**Pros:** No persistence needed, 1-line change per location (2 locations).
**Cons:** Removes ALL pinned messages in the chat, including any manually pinned by the user. In a private bot chat this is likely fine. In a group chat it could be disruptive.

### Approach 2: Persist `pinnedMessageId` to disk

Write `pinnedMessageId` to a file (e.g., JSON in `~/.claude/telegram-bot-state.json`). Read on startup.

**Pros:** Surgical — only unpins the one known message.
**Cons:** More code, file I/O, needs cleanup logic. Over-engineered for this use case since it's a single-user bot in a private chat.

### Approach 3: Query pinned messages before pinning

Use Telegram's `getChat` API which returns `pinned_message` field, then unpin it before pinning new.

**Pros:** No persistence needed, targeted unpin.
**Cons:** `getChat` only returns the most recently pinned message, not all pinned messages. Multiple stale pins could still accumulate. Also adds an extra API call.

### Recommended: Approach 1

This is a single-user private-chat bot. `unpinAllChatMessages` is the simplest fix and handles all edge cases (multiple restarts, multiple stale pins). The 2 locations to change are:

1. **bot.ts:164-166** — project switch callback
2. **bot.ts:294-296** — session resume callback

Replace:
```ts
if (state.pinnedMessageId) {
  await ctx.api.unpinChatMessage(chatId, state.pinnedMessageId).catch(() => {})
}
```

With:
```ts
await ctx.api.unpinAllChatMessages(chatId).catch(() => {})
```

This also makes `pinnedMessageId` field on `UserState` unnecessary, though keeping it is harmless (could still be used for other purposes or as a minor optimization to skip the API call if no pin exists).

## Potential Impact Areas

- **No tests** — no test suite exists to break
- **No types changes** — optionally remove `pinnedMessageId` from `UserState` but not required
- **No imports changes** — `unpinAllChatMessages` is already available on `ctx.api`
- **Group chats** — if the bot is ever used in groups, `unpinAllChatMessages` would clear non-bot pins too. Current access control restricts to a single user, and it's used as a private chat bot, so this is not a concern.

## Edge Cases and Constraints

1. **Rate limits** — `unpinAllChatMessages` is a single API call, no rate limit concern
2. **Permissions** — in private chats, bots can pin/unpin freely. In groups, requires `can_pin_messages` admin right. Same as current behavior.
3. **Race conditions** — two rapid project switches could interleave, but the `.catch(() => {})` pattern handles this gracefully
4. **No-op when nothing pinned** — `unpinAllChatMessages` silently succeeds even if nothing is pinned

## Reference Implementation

The existing code at bot.ts:164-171 is the reference. The change is minimal — swap `unpinChatMessage` for `unpinAllChatMessages` and remove the conditional.
