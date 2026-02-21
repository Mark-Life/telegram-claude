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
 * Create the detailed implementation plan. Produces plan-implementation.md.
 */
export async function stepPlanImplementation(ctx: IssueContext): Promise<boolean> {
  const implPlanPath = join(ctx.issueDir, "plan-implementation.md")

  if (fileExists(implPlanPath)) {
    logStep("Plan-Implementation", ctx, true)
    return true
  }

  logStep("Plan-Implementation", ctx)

  const tokens = buildTokens(ctx)
  const promptFile = resolveTemplate("prompt-plan-implementation.md", tokens, ctx.issueDir)

  const result = await runClaude({
    promptFile,
    permissionMode: "acceptEdits",
    maxTurns: getConfig().maxTurns,
  })

  if (result.is_error) {
    console.error(`Plan-Implementation step failed: ${result.result}`)
    return false
  }

  if (!fileExists(implPlanPath)) {
    console.error("Plan-Implementation step did not produce plan-implementation.md")
    return false
  }

  await commitArtifacts(ctx, `chore(auto-pr): implementation plan for ${ctx.repo}#${ctx.number}`)
  return true
}
