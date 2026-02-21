import { join } from "node:path"
import { rmSync } from "node:fs"
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

export async function stepRefresh(ctx: IssueContext): Promise<boolean> {
  logStep("Refresh", ctx)
  const { mainBranch, remote } = getConfig()

  // Ensure branch exists
  const branchList = await git(["branch", "--list", ctx.branch])
  if (!branchList.includes(ctx.branch.split("/").pop()!)) {
    try {
      await git(["fetch", remote, ctx.branch])
      await git(["checkout", ctx.branch])
    } catch {
      log(`Branch ${ctx.branch} does not exist locally or remotely.`)
      return false
    }
  }

  // Update main branch
  await git(["checkout", mainBranch])
  await git(["pull", remote, mainBranch])

  // Checkout the PR branch
  await git(["checkout", ctx.branch])

  // Check if already up-to-date
  let alreadyUpToDate = false
  try {
    await git(["merge-base", "--is-ancestor", mainBranch, "HEAD"])
    log(`Branch is already up-to-date with ${mainBranch}.`)
    alreadyUpToDate = true
  } catch {
    // Not up-to-date — need rebase/merge
  }

  if (!alreadyUpToDate) {
    // Try rebase first
    try {
      await git(["rebase", mainBranch])
    } catch {
      await git(["rebase", "--abort"]).catch(() => {})
      // Fall back to merge
      try {
        await git(["merge", mainBranch, "--no-edit"])
      } catch {
        // Merge conflict — stage and commit for Claude to fix
        await git(["add", "."])
        await git(["commit", "--no-edit"])
      }
    }
  }

  // Run Claude
  const tokens = buildTokens(ctx)
  const promptFile = resolveTemplate("prompt-refresh.md", tokens, ctx.issueDir)
  const result = await runClaude({
    promptFile,
    permissionMode: "acceptEdits",
    maxTurns: getConfig().maxTurns,
  })

  if (result.is_error) {
    console.error(`Refresh step failed: ${result.result}`)
    await git(["checkout", mainBranch]).catch(() => {})
    return false
  }

  // Commit Claude's changes
  await commitArtifacts(ctx, `chore(auto-pr): refresh for ${ctx.repo}#${ctx.number}`)

  // Invalidate stale artifacts
  const reviewPath = join(ctx.issueDir, "review.md")
  const completedPath = join(ctx.issueDir, "completed-summary.md")
  let invalidated = false
  if (fileExists(reviewPath)) {
    rmSync(reviewPath)
    invalidated = true
  }
  if (fileExists(completedPath)) {
    rmSync(completedPath)
    invalidated = true
  }
  if (invalidated) {
    await commitArtifacts(ctx, `chore(auto-pr): invalidate stale artifacts after refresh`)
  }

  // Force-push
  await git(["push", "--force-with-lease", "-u", remote, ctx.branch])

  // Return to main branch
  await git(["checkout", mainBranch]).catch(() => {})

  return true
}
