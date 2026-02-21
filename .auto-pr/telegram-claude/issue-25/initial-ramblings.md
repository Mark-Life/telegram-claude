# Stream thinking content instead of just timer

> Mark-Life/telegram-claude#25

## Problem
Currently shows "Thinking..." with elapsed time while Claude thinks. The actual thinking content is not displayed.

## Proposal
- Stream the actual thinking block text to the user
- Could be shown in a collapsed/expandable format or a separate message
- Keep the elapsed timer as well
- Consider Telegram message size limits — thinking blocks can be long