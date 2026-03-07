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

interface ForumPersistedState {
  forumMode: true;
  topics: Record<string, PersistedState>;
}

interface BotState {
  activeProject: string;
  key?: number;
  sessions: Map<string, string>;
}

const DATA_DIR = join(import.meta.dirname, "..", ".data");
const STATE_FILE = join(DATA_DIR, "state.json");

let _forumMode = false;
let _forumStates: Record<string, PersistedState> = {};

/** Set forum mode for state persistence */
export function setStateForumMode(enabled: boolean) {
  _forumMode = enabled;
}

/** Load persisted state from disk. Returns null if file missing or corrupt. */
export function loadPersistedState(key?: number) {
  try {
    const text = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(text);

    if (_forumMode) {
      if (parsed.forumMode) {
        _forumStates = (parsed as ForumPersistedState).topics ?? {};
      } else {
        // Migrate: private state on disk but forum mode now active — ignore old private state
        _forumStates = {};
      }
      if (key !== undefined) {
        const topicState = _forumStates[String(key)];
        if (topicState) {
          return {
            activeProject: existsSync(topicState.activeProject)
              ? topicState.activeProject
              : "",
            sessions: new Map(Object.entries(topicState.sessions ?? {})),
          };
        }
      }
      return null;
    }

    // Private mode — ignore forum-format state from previous run
    if (parsed.forumMode) {
      return null;
    }

    const ps = parsed as PersistedState;
    const activeProject =
      ps.activeProject && existsSync(ps.activeProject) ? ps.activeProject : "";
    const sessions = new Map(Object.entries(ps.sessions ?? {}));
    return { activeProject, sessions };
  } catch {
    return null;
  }
}

function saveState(
  activeProject: string,
  sessions: Map<string, string>,
  key?: number
) {
  mkdirSync(DATA_DIR, { recursive: true });

  if (_forumMode && key !== undefined) {
    _forumStates[String(key)] = {
      activeProject,
      sessions: Object.fromEntries(sessions),
    };
    const data: ForumPersistedState = {
      forumMode: true,
      topics: _forumStates,
    };
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, STATE_FILE);
    return;
  }

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
  saveState(state.activeProject, state.sessions, state.key);
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
  saveState(state.activeProject, state.sessions, state.key);
}
