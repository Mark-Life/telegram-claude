# Plan: Auto-unpin old project messages on project switch

## Summary

Pinned project messages accumulate across bot restarts because `pinnedMessageId` is stored in-memory only. When the bot restarts, the stored ID is lost and the old pin is never cleaned up. The fix replaces targeted `unpinChatMessage(id)` with `unpinAllChatMessages()` so all stale pins are cleared regardless of in-memory state. Since this is a single-user private-chat bot, nuking all pins is safe and handles all edge cases (multiple restarts, multiple stale pins).

## Approach

Replace the conditional `unpinChatMessage` call with unconditional `unpinAllChatMessages` in both pin/unpin locations. Remove the now-unused `pinnedMessageId` field from `UserState` and all references to it.

## Architectural decisions

- **`unpinAllChatMessages` over targeted unpin** — Eliminates the need for any state persistence. A single API call handles any number of stale pins. Acceptable because the bot operates in a private 1:1 chat where no other pins exist.
- **Remove `pinnedMessageId` entirely** — The field becomes dead code after this change. Keeping dead state fields invites confusion and future bugs.

## Key code snippets

### `src/bot.ts` — Remove `pinnedMessageId` from UserState (L13)

```ts
// Before
type UserState = {
  activeProject: string
  sessions: Map<string, string>
  pinnedMessageId?: number
}

// After
type UserState = {
  activeProject: string
  sessions: Map<string, string>
}
```

### `src/bot.ts` — Project switch callback (L164-171)

```ts
// Before
if (state.pinnedMessageId) {
  await ctx.api.unpinChatMessage(chatId, state.pinnedMessageId).catch(() => {})
}
const pinnedId = typeof msg === "object" && "message_id" in msg ? msg.message_id : undefined
if (pinnedId) {
  await ctx.api.pinChatMessage(chatId, pinnedId, { disable_notification: true }).catch(() => {})
  state.pinnedMessageId = pinnedId
}

// After
await ctx.api.unpinAllChatMessages(chatId).catch(() => {})
const pinnedId = typeof msg === "object" && "message_id" in msg ? msg.message_id : undefined
if (pinnedId) {
  await ctx.api.pinChatMessage(chatId, pinnedId, { disable_notification: true }).catch(() => {})
}
```

### `src/bot.ts` — Session resume callback (L294-301)

```ts
// Before
if (state.pinnedMessageId) {
  await ctx.api.unpinChatMessage(chatId, state.pinnedMessageId).catch(() => {})
}
const pinnedId = typeof msg === "object" && "message_id" in msg ? msg.message_id : undefined
if (pinnedId) {
  await ctx.api.pinChatMessage(chatId, pinnedId, { disable_notification: true }).catch(() => {})
  state.pinnedMessageId = pinnedId
}

// After
await ctx.api.unpinAllChatMessages(chatId).catch(() => {})
const pinnedId = typeof msg === "object" && "message_id" in msg ? msg.message_id : undefined
if (pinnedId) {
  await ctx.api.pinChatMessage(chatId, pinnedId, { disable_notification: true }).catch(() => {})
}
```

## Scope boundaries

- **In scope**: Fix pin accumulation, remove dead `pinnedMessageId` state
- **Out of scope**: Persisting any user state to disk, adding pin logic to other handlers, group chat support

## Risks

- **Group chat usage**: If the bot is ever used in a group, `unpinAllChatMessages` would clear non-bot pins. Current access control restricts to a single user in private chat, so this is not a current concern. If group support is added later, this should be revisited.
- **No risk otherwise**: The change is minimal (2 call sites), no new dependencies, no type changes beyond removing one optional field, and `unpinAllChatMessages` silently succeeds when nothing is pinned.

## Alternative approaches

| Approach | How it works | Why not chosen |
|---|---|---|
| **Persist `pinnedMessageId` to disk** | Write the pinned message ID to a JSON file, read on startup | Over-engineered for a single-user private-chat bot. Adds file I/O, cleanup logic, and a new persistence layer for one integer. |
| **Query pinned via `getChat` before pinning** | Call `getChat` to get `pinned_message`, unpin it, then pin new | `getChat` only returns the *most recent* pinned message — multiple stale pins can still accumulate. Also adds an extra API call per switch. |
| **Keep `pinnedMessageId` but use `unpinAll`** | Same as chosen approach but retain the field | Dead state fields invite confusion. If it's unused, remove it. |
