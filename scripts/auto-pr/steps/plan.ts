import { join } from "node:path"
import {
  type IssueContext,
  buildTokens,
  commitArtifacts,
  fileExists,
  getConfig,
  logStep,
  resolveTemplate,
  runClaude,
} from "../utils.js"

/**
 * Create the high-level plan. Produces plan.md.
 */
export async function stepPlan(ctx: IssueContext): Promise<boolean> {
  const planPath = join(ctx.issueDir, "plan.md")

  if (fileExists(planPath)) {
    logStep("Plan", ctx, true)
    return true
  }

  logStep("Plan", ctx)

  const tokens = buildTokens(ctx)
  const promptFile = resolveTemplate("prompt-plan.md", tokens, ctx.issueDir)

  const result = await runClaude({
    promptFile,
    permissionMode: "acceptEdits",
    maxTurns: getConfig().maxTurns,
  })

  if (result.is_error) {
    console.error(`Plan step failed: ${result.result}`)
    return false
  }

  if (!fileExists(planPath)) {
    console.error("Plan step did not produce plan.md")
    return false
  }

  await commitArtifacts(ctx, `chore(auto-pr): plan for ${ctx.repo}#${ctx.number}`)
  return true
}
