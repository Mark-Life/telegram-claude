import type { Config } from "./utils.js"

export const config: Config = {
  triggerLabel: "auto-pr",
  repos: [
    { repo: "Mark-Life/telegram-claude", path: "." },
  ],
  mainBranch: "main",
  maxImplementIterations: 100,
  loopIntervalMinutes: 15,
  loopRetryEnabled: true,
  retryDelayMs: 30_000,
  maxRetryDelayMs: 300_000,
}
