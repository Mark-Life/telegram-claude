import { join } from "node:path"
import {
  type IssueContext,
  buildTokens,
  commitArtifacts,
  fileExists,
  getConfig,
  git,
  log,
  logStep,
  resolveTemplate,
  runClaude,
} from "../utils.js"

/**
 * Implement the code changes.
 * Loops Claude with acceptEdits until completed-summary.md is created
 * (meaning all plan-implementation.md checkboxes are checked).
 */
export async function stepImplement(ctx: IssueContext): Promise<boolean> {
  const completedPath = join(ctx.issueDir, "completed-summary.md")
  const maxIterations = getConfig().maxImplementIterations

  if (fileExists(completedPath)) {
    logStep("Implement", ctx, true)
    return true
  }

  logStep("Implement", ctx)

  // Make sure we're on the right branch
  await git(["checkout", ctx.branch])

  for (let i = 1; i <= maxIterations; i++) {
    log(`Implementation iteration ${i}/${maxIterations}`)

    const tokens = buildTokens(ctx)
    const promptFile = resolveTemplate("prompt-implement.md", tokens, ctx.issueDir)

    const result = await runClaude({
      promptFile,
      permissionMode: "acceptEdits",
      maxTurns: getConfig().maxTurns,
    })

    if (result.is_error) {
      console.error(`Implement iteration ${i} failed: ${result.result}`)
      return false
    }

    // Check if Claude created the completion signal
    if (fileExists(completedPath)) {
      log(`Implementation complete after ${i} iteration(s)`)
      await commitArtifacts(ctx, `chore(auto-pr): implementation complete for ${ctx.repo}#${ctx.number}`)
      return true
    }

    log(`Iteration ${i} finished but completed-summary.md not yet created — tasks remain`)
  }

  console.error(`Implementation did not complete after ${maxIterations} iterations`)
  return false
}
