import { join } from "node:path"
import {
  type IssueContext,
  buildTokens,
  commitArtifacts,
  fileExists,
  getConfig,
  git,
  logStep,
  readFile,
  resolveTemplate,
  runClaude,
} from "../utils.js"

/**
 * Research the codebase for the issue.
 * Creates the branch and produces research.md.
 */
export async function stepResearch(ctx: IssueContext): Promise<boolean> {
  const researchPath = join(ctx.issueDir, "research.md")

  if (fileExists(researchPath) && readFile(researchPath).length > 200) {
    logStep("Research", ctx, true)
    return true
  }

  logStep("Research", ctx)

  // Ensure branch exists
  await ensureBranch(ctx.branch)

  // Resolve and run prompt
  const tokens = buildTokens(ctx)
  const promptFile = resolveTemplate("prompt-research.md", tokens, ctx.issueDir)

  const result = await runClaude({
    promptFile,
    permissionMode: "acceptEdits",
    maxTurns: getConfig().maxTurns,
  })

  if (result.is_error) {
    console.error(`Research step failed: ${result.result}`)
    return false
  }

  // Validate output
  if (!fileExists(researchPath) || readFile(researchPath).length <= 200) {
    console.error("Research step did not produce a valid research.md")
    return false
  }

  await commitArtifacts(ctx, `chore(auto-pr): research for ${ctx.repo}#${ctx.number}`)
  return true
}

async function ensureBranch(branch: string): Promise<void> {
  const { mainBranch, remote } = getConfig()

  // Check if branch already exists
  try {
    const branches = await git(["branch", "--list", branch])
    if (branches.includes(branch)) {
      await git(["checkout", branch])
      return
    }
  } catch { /* ignore */ }

  // Check if remote branch exists
  try {
    await git(["fetch", remote, branch])
    await git(["checkout", branch])
    return
  } catch { /* doesn't exist remotely */ }

  // Create new branch from main
  await git(["checkout", mainBranch])
  await git(["pull", remote, mainBranch])
  await git(["checkout", "-b", branch])
}
