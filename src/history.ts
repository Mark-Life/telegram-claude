import { readdirSync, readFileSync } from "fs"
import { join, basename } from "path"
import { homedir } from "os"

export type SessionInfo = {
  sessionId: string
  summary: string
  startedAt: string
  lastActiveAt: string
  projectPath: string
  projectName: string
}

type SessionIndexEntry = {
  sessionId: string
  firstPrompt: string
  created: string
  modified: string
  projectPath: string
  isSidechain?: boolean
}

type SessionIndex = {
  version: number
  entries: SessionIndexEntry[]
}

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects")
const MAX_SESSIONS = 10

/** Cache of sessionId -> projectPath, populated during listing */
const sessionProjectCache = new Map<string, string>()

/** Look up the project path for a session from cache */
export function getSessionProject(sessionId: string) {
  return sessionProjectCache.get(sessionId)
}

/** Convert a project path to Claude's storage directory name */
function toStorageDirName(projectPath: string) {
  return projectPath.replace(/\//g, "-")
}

/** Strip HTML tags and truncate for display */
function cleanSummary(raw: string) {
  return raw.replace(/<[^>]+>/g, "").trim().slice(0, 100)
}

/** Derive a short project name from the project path */
function deriveProjectName(projectPath: string) {
  return basename(projectPath)
}

/** Read sessions-index.json from a Claude storage directory */
function readSessionIndex(storageDir: string): SessionIndexEntry[] {
  try {
    const raw = readFileSync(join(storageDir, "sessions-index.json"), "utf8")
    const index: SessionIndex = JSON.parse(raw)
    return index.entries ?? []
  } catch {
    return []
  }
}

/** Convert an index entry to SessionInfo */
function entryToSession(entry: SessionIndexEntry): SessionInfo {
  return {
    sessionId: entry.sessionId,
    summary: cleanSummary(entry.firstPrompt ?? ""),
    startedAt: entry.created,
    lastActiveAt: entry.modified,
    projectPath: entry.projectPath,
    projectName: deriveProjectName(entry.projectPath),
  }
}

/** List recent sessions for a specific project directory */
export function listSessions(projectPath: string): SessionInfo[] {
  const dirName = toStorageDirName(projectPath)
  const storageDir = join(CLAUDE_PROJECTS_DIR, dirName)
  const entries = readSessionIndex(storageDir)

  const sessions = entries
    .filter((e) => !e.isSidechain && e.firstPrompt)
    .map(entryToSession)
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(0, MAX_SESSIONS)

  for (const s of sessions) sessionProjectCache.set(s.sessionId, s.projectPath)
  return sessions
}

/** List recent sessions across all projects */
export function listAllSessions(): SessionInfo[] {
  let dirs: string[]
  try {
    dirs = readdirSync(CLAUDE_PROJECTS_DIR)
  } catch {
    return []
  }

  const allEntries: SessionIndexEntry[] = []
  for (const dir of dirs) {
    const storageDir = join(CLAUDE_PROJECTS_DIR, dir)
    allEntries.push(...readSessionIndex(storageDir))
  }

  const sessions = allEntries
    .filter((e) => !e.isSidechain && e.firstPrompt)
    .map(entryToSession)
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(0, MAX_SESSIONS)

  for (const s of sessions) sessionProjectCache.set(s.sessionId, s.projectPath)
  return sessions
}
