import {
  type IssueContext,
  buildIssueContext,
  getConfig,
  gh,
  log,
} from "../utils.js"

interface GhIssue {
  number: number
  title: string
  body: string
  labels: { name: string }[]
}

/**
 * Fetch open issues with the trigger label from all configured repos.
 * Label is removed after PR creation, so completed issues won't appear here.
 */
export async function fetchIssues(limit?: number): Promise<IssueContext[]> {
  const cfg = getConfig()
  const contexts: IssueContext[] = []

  for (const repoConfig of cfg.repos) {
    log(`Scanning ${repoConfig.repo} for issues labeled "${cfg.triggerLabel}"...`)

    let issues: GhIssue[]
    try {
      issues = await gh<GhIssue[]>([
        "issue", "list",
        "--repo", repoConfig.repo,
        "--label", cfg.triggerLabel,
        "--state", "open",
        "--json", "number,title,body,labels",
      ])
    } catch (e) {
      log(`  Warning: could not fetch issues from ${repoConfig.repo}: ${e}`)
      continue
    }

    if (issues.length === 0) {
      log(`  No issues found.`)
      continue
    }

    log(`  Found ${issues.length} issue(s).`)

    for (const issue of issues) {
      contexts.push(buildIssueContext(issue, repoConfig.repo, repoConfig.path))
      if (limit != null && contexts.length >= limit) break
    }

    if (limit != null && contexts.length >= limit) break
  }

  return contexts
}

/**
 * Fetch a single issue by number directly (no label filter).
 * Used when --issue N is specified.
 */
export async function fetchIssue(issueNumber: number, repoShort?: string): Promise<IssueContext | undefined> {
  const cfg = getConfig()

  const repos = repoShort
    ? cfg.repos.filter((r) => r.repo.endsWith(`/${repoShort}`))
    : cfg.repos

  for (const repoConfig of repos) {
    try {
      const issue = await gh<GhIssue>([
        "issue", "view", String(issueNumber),
        "--repo", repoConfig.repo,
        "--json", "number,title,body,labels",
      ])
      return buildIssueContext(issue, repoConfig.repo, repoConfig.path)
    } catch {
      // Issue not found in this repo, try next
    }
  }

  return undefined
}
