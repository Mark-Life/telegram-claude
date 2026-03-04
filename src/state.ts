import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface PersistedState {
  activeProject: string;
  sessions: Record<string, string>;
}

interface BotState {
  activeProject: string;
  sessions: Map<string, string>;
}

const DATA_DIR = ".data";
const STATE_FILE = join(DATA_DIR, "state.json");

/** Load persisted state from disk. Returns null if file missing or corrupt. */
export function loadPersistedState() {
  try {
    const text = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(text) as PersistedState;

    const activeProject =
      parsed.activeProject && existsSync(parsed.activeProject)
        ? parsed.activeProject
        : "";

    const sessions = new Map(Object.entries(parsed.sessions ?? {}));

    return { activeProject, sessions };
  } catch {
    return null;
  }
}

function saveState(activeProject: string, sessions: Map<string, string>) {
  mkdirSync(DATA_DIR, { recursive: true });
  const data: PersistedState = {
    activeProject,
    sessions: Object.fromEntries(sessions),
  };
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, STATE_FILE);
}

/** Set active project and persist to disk. */
export function setActiveProject(state: BotState, path: string) {
  state.activeProject = path;
  saveState(state.activeProject, state.sessions);
}

/** Update or delete a session mapping and persist to disk. */
export function updateSession(
  state: BotState,
  projectPath: string,
  sessionId?: string
) {
  if (sessionId) {
    state.sessions.set(projectPath, sessionId);
  } else {
    state.sessions.delete(projectPath);
  }
  saveState(state.activeProject, state.sessions);
}
