import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export type SessionInfo = {
  sessionId: string
  summary: string
  startedAt: string
  lastActiveAt: string
}

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects")
const MAX_SESSIONS = 10

/** Convert a project path to Claude's storage directory name */
function toStorageDirName(projectPath: string) {
  return projectPath.replace(/\//g, "-")
}

/** Extract session metadata from a JSONL file */
function parseSessionFile(filePath: string): SessionInfo | null {
  try {
    const content = readFileSync(filePath, "utf8")
    const lines = content.split("\n").filter(Boolean)

    let summary = ""
    let startedAt = ""
    let lastActiveAt = ""
    let sessionId = ""

    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (!startedAt && obj.timestamp) startedAt = obj.timestamp
        if (obj.timestamp) lastActiveAt = obj.timestamp
        if (!sessionId && obj.sessionId) sessionId = obj.sessionId
        if (
          !summary &&
          obj.type === "user" &&
          typeof obj.message?.content === "string"
        ) {
          summary = obj.message.content
            .replace(/<[^>]+>/g, "")
            .trim()
            .slice(0, 100)
        }
      } catch {}
    }

    if (!summary || !sessionId) return null
    return { sessionId, summary, startedAt, lastActiveAt }
  } catch {
    return null
  }
}

/** List recent sessions for a project directory, sorted newest first */
export function listSessions(projectPath: string): SessionInfo[] {
  const dirName = toStorageDirName(projectPath)
  const storageDir = join(CLAUDE_PROJECTS_DIR, dirName)

  let files: string[]
  try {
    files = readdirSync(storageDir).filter((f) => f.endsWith(".jsonl"))
  } catch {
    return []
  }

  // Sort by file mtime descending (most recent first) before parsing
  const withMtime = files
    .map((f) => {
      try {
        return { name: f, mtime: statSync(join(storageDir, f)).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((x): x is { name: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SESSIONS * 2) // parse a few extra in case some fail

  const sessions: SessionInfo[] = []
  for (const { name } of withMtime) {
    const info = parseSessionFile(join(storageDir, name))
    if (info) sessions.push(info)
    if (sessions.length >= MAX_SESSIONS) break
  }

  return sessions
}
