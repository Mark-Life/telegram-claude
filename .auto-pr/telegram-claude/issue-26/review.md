# Review: Edit last prompt via reply (#26)

## Status: PASS WITH FIXES

## Issues found

1. **`retry:pending` callback unhandled** — The retry button is initially created with callback data `retry:pending`, which doesn't match the `^retry:(\d+)$` regex handler. If a user clicks the button in the brief window before `editMessageReplyMarkup` updates it to `retry:{messageId}`, the callback goes unhandled and Telegram shows a forever-spinning loader. Fixed by adding a `retry:pending` handler that answers with "Still processing...".

## Confidence level: HIGH

All 7 implementation tasks match the plan. The code follows existing patterns (callback query handlers, `.catch(() => {})` error suppression, `InlineKeyboard` usage). Types are correct, imports present, no unused code. The two-step keyboard approach (pending placeholder -> real ID) is a pragmatic solution to the chicken-and-egg problem of needing the message ID for callback data before the message exists.

## Notes

- The `replyMarkup` is only attached on the **final** edit of the last text message. If the final edit fails (HTML parse error), the plain-text fallback also includes the keyboard, which is correct.
- If Claude produces no text output (only tool use), `result.messageId` will be `undefined` and no retry button is shown. This is reasonable — there's no text message to attach it to, and the `editMessageReplyMarkup` in `handlePrompt` still fires as a fallback.
- `safeEditMessage` uses `Record<string, unknown>` for the options object to conditionally include `reply_markup`. This works but is less type-safe than Grammy's built-in types. Acceptable tradeoff for simplicity.
