# Remove unused formatFooterPlain() in telegram.ts

> Mark-Life/telegram-claude#29

## Problem
\`formatFooterPlain()\` at telegram.ts:308-318 is defined but never called. Dead code.

## Fix
Remove the function.