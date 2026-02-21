# Plan: Remove unused `formatFooterPlain()` in telegram.ts

## Summary

`formatFooterPlain()` (src/telegram.ts:307-318) is dead code — defined but never called or exported. It's a plain-text variant of `formatFooter()` that was likely left behind after the bot switched to HTML-only message formatting. Removing it reduces maintenance surface with zero functional impact.

## Approach

Delete the `formatFooterPlain` function and its JSDoc comment (lines 307-318) from `src/telegram.ts`. No other changes needed.

## Architectural decisions

None. This is a pure dead-code deletion with no design choices to make.

## Key code snippets

Delete this block from `src/telegram.ts`:

```typescript
// DELETE lines 307-318:
/** Format metadata footer as plain text */
function formatFooterPlain(projectName: string, result: StreamResult) {
  const meta: string[] = []
  if (projectName) meta.push(`Project: ${projectName}`)
  if (result.cost !== undefined) meta.push(`Cost: $${result.cost.toFixed(4)}`)
  if (result.durationMs !== undefined) {
    const secs = (result.durationMs / 1000).toFixed(1)
    meta.push(`Time: ${secs}s`)
  }
  if (result.turns !== undefined && result.turns > 1) meta.push(`Turns: ${result.turns}`)
  return meta.join(" | ")
}
```

The kept sibling `formatFooter()` (lines 294-305) and the `StreamResult` type remain unchanged.

## Scope boundaries

- Only `src/telegram.ts` is modified.
- `formatFooter()` (the HTML variant) is **not** touched.
- `StreamResult` type is **not** touched — still used by `formatFooter()`.

## Risks

None. The function is unexported, uncalled, and unreferenced. Deletion cannot break anything.

## Alternative approaches

| Approach | How it works | Why not chosen |
|----------|-------------|----------------|
| Keep and export for future use | Mark as utility for potential plain-text output needs | Violates YAGNI; easy to recreate if ever needed |
| Deprecation comment | Add `@deprecated` tag instead of deleting | Pointless for unexported, uncalled code — just adds noise |
