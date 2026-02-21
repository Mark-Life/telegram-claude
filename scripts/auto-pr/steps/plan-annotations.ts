import { join } from "node:path"
import { renameSync } from "node:fs"
import {
  type IssueContext,
  buildTokens,
  commitArtifacts,
  fileExists,
  getConfig,
  log,
  logStep,
  resolveTemplate,
  runClaude,
} from "../utils.js"

/**
 * Address plan annotations (optional).
 * Only runs if plan-annotations.md exists in the issue dir.
 * After processing, renames it to plan-annotations-addressed.md to avoid re-running.
 */
export async function stepPlanAnnotations(ctx: IssueContext): Promise<boolean> {
  const annotationsPath = join(ctx.issueDir, "plan-annotations.md")
  const addressedPath = join(ctx.issueDir, "plan-annotations-addressed.md")

  // No annotations file → skip silently (this step is optional)
  if (!fileExists(annotationsPath)) {
    return true
  }

  // Already addressed → skip
  if (fileExists(addressedPath)) {
    logStep("Plan-Annotations", ctx, true)
    return true
  }

  logStep("Plan-Annotations", ctx)
  log("Found plan-annotations.md — addressing reviewer notes")

  const tokens = buildTokens(ctx)
  const promptFile = resolveTemplate("prompt-plan-annotations.md", tokens, ctx.issueDir)

  const result = await runClaude({
    promptFile,
    permissionMode: "acceptEdits",
    maxTurns: getConfig().maxTurns,
  })

  if (result.is_error) {
    console.error(`Plan-Annotations step failed: ${result.result}`)
    return false
  }

  // Mark as addressed so we don't re-run
  renameSync(annotationsPath, addressedPath)
  log("Annotations addressed — renamed to plan-annotations-addressed.md")

  await commitArtifacts(ctx, `chore(auto-pr): plan annotations for ${ctx.repo}#${ctx.number}`)
  return true
}
