import {
  type IssueContext,
  getConfig,
  ghRaw,
  log,
  logStep,
} from "../utils.js"

/**
 * Remove the trigger label from the issue.
 * Prevents the issue from being picked up again in future pipeline runs.
 */
export async function stepRemoveLabel(ctx: IssueContext): Promise<boolean> {
  logStep("Remove Label", ctx)

  const cfg = getConfig()
  const result = await ghRaw([
    "issue", "edit", String(ctx.number),
    "--repo", ctx.repo,
    "--remove-label", cfg.triggerLabel,
  ])
  if (!result) {
    log(`Warning: could not remove "${cfg.triggerLabel}" label from ${ctx.repo}#${ctx.number}`)
  }

  return true
}
