import { join } from "node:path"
import { type IssueContext, ensureDir, fileExists, getConfig, git, log, writeFile } from "./utils.js"
import { stepResearch } from "./steps/research.js"
import { stepPlan } from "./steps/plan.js"
import { stepPlanAnnotations } from "./steps/plan-annotations.js"
import { stepPlanImplementation } from "./steps/plan-implementation.js"
import { stepImplement } from "./steps/implement.js"
import { stepReview } from "./steps/review.js"
import { stepCreatePR } from "./steps/create-pr.js"
import { stepRemoveLabel } from "./steps/remove-label.js"

const STEPS = [
  { name: "research", run: stepResearch },
  { name: "plan", run: stepPlan },
  { name: "plan-annotations", run: stepPlanAnnotations },
  { name: "plan-implementation", run: stepPlanImplementation },
  { name: "implement", run: stepImplement },
  { name: "review", run: stepReview },
  { name: "create-pr", run: stepCreatePR },
  { name: "remove-label", run: stepRemoveLabel },
] as const

export type StepName = (typeof STEPS)[number]["name"]

export const STEP_NAMES = STEPS.map((s) => s.name)

/**
 * Run the pipeline for a single issue, starting from whatever step is needed.
 * If `untilStep` is provided, stop after that step completes.
 */
export async function runPipeline(ctx: IssueContext, untilStep?: StepName): Promise<void> {
  log(`Pipeline starting for ${ctx.repo}#${ctx.number}: ${ctx.title}`)

  // Checkout the branch first (if it exists) so we see any previously committed artifacts
  try {
    const branches = await git(["branch", "--list", ctx.branch])
    if (branches.includes(ctx.branch.split("/").pop()!)) {
      await git(["checkout", ctx.branch])
    }
  } catch { /* may not exist yet, research step will create it */ }

  // Save initial-ramblings.md for this issue (idempotent — skips if already on branch from prior run)
  ensureDir(ctx.issueDir)
  const ramblingsPath = join(ctx.issueDir, "initial-ramblings.md")
  if (!fileExists(ramblingsPath)) {
    const content = `# ${ctx.title}\n\n> ${ctx.repo}#${ctx.number}\n\n${ctx.body ?? ""}`
    writeFile(ramblingsPath, content)
    log(`Saved initial-ramblings.md`)
  }

  for (const step of STEPS) {
    const success = await step.run(ctx)

    if (!success) {
      log(`Pipeline stopped at "${step.name}" for ${ctx.repo}#${ctx.number}`)
      // Return to main so we don't leave the repo on a feature branch
      await git(["checkout", getConfig().mainBranch]).catch(() => {})
      return
    }

    if (untilStep && step.name === untilStep) {
      log(`Pipeline paused after "${step.name}" (--until ${untilStep})`)
      await git(["checkout", getConfig().mainBranch]).catch(() => {})
      return
    }
  }

  log(`Pipeline complete for ${ctx.repo}#${ctx.number}`)
  // Return to main
  await git(["checkout", getConfig().mainBranch]).catch(() => {})
}
