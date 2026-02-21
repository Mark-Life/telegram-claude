# Completed: Stream thinking content instead of just timer

## Changes

### `src/claude.ts`
- Added `thinking_delta` variant to the `ClaudeEvent` discriminated union
- Stream parser now yields `thinking_delta` events with the actual thinking text instead of ignoring them

### `src/telegram.ts`
- Added `thinkingText` state variable to accumulate thinking content
- Added `flushThinking()` function that progressively renders thinking text with throttle, front-truncation for long content, HTML escaping, and expandable blockquote wrapping (>= 4 lines)
- `switchMode` now finalizes and resets thinking state when switching away from thinking mode
- `editTimer` now flushes pending thinking edits alongside text edits
- New `thinking_delta` event handler accumulates text and triggers progressive rendering
- `thinking_done` handler now displays the actual thinking content (truncated, collapsed if long) with a "Thought for X.Xs" footer, falling back to just the timer if no content was received

## Behavior
- Short thinking: displayed inline as italic text + duration footer
- Long thinking (>= 4 lines): wrapped in expandable blockquote + duration footer
- Very long thinking (> ~3800 chars): truncated from the front with "..." prefix
- Streams progressively with 1.5s throttle (same as text messages)
- Multiple thinking blocks in one response each get their own message
