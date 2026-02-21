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
 * Self-review the implementation. Checks for common mistakes and produces review.md.
 */
export async function stepReview(ctx: IssueContext): Promise<boolean> {
  const reviewPath = join(ctx.issueDir, "review.md")

  if (fileExists(reviewPath)) {
    logStep("Review", ctx, true)
    return true
  }

  logStep("Review", ctx)

  const tokens = buildTokens(ctx)
  const promptFile = resolveTemplate("prompt-review.md", tokens, ctx.issueDir)

  const result = await runClaude({
    promptFile,
    permissionMode: "acceptEdits",
    maxTurns: getConfig().maxTurns,
  })

  if (result.is_error) {
    console.error(`Review step failed: ${result.result}`)
    return false
  }

  if (!fileExists(reviewPath)) {
    console.error("Review step did not produce review.md")
    return false
  }

  await commitArtifacts(ctx, `chore(auto-pr): review for ${ctx.repo}#${ctx.number}`)
  return true
}
