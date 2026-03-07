import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Api } from "grammy";

interface TopicMapping {
  pinnedRepoLinkId?: number;
  projectName: string;
  projectPath: string;
  threadId: number;
}

const DATA_DIR = join(import.meta.dirname, "..", ".data");
const TOPICS_FILE = join(DATA_DIR, "topics.json");

let topicMappings: TopicMapping[] = [];
const pendingTopics = new Map<string, Promise<number>>();
const SSH_REMOTE_RE = /^git@github\.com:(.+?)(?:\.git)?$/;
const GIT_SUFFIX_RE = /\.git$/;

/** Load topic mappings from disk. Removes mappings for project paths that no longer exist. */
export function loadTopicMappings() {
  try {
    const text = readFileSync(TOPICS_FILE, "utf-8");
    const loaded = JSON.parse(text);
    if (!Array.isArray(loaded)) {
      topicMappings = [];
      return;
    }
    const valid = (loaded as TopicMapping[]).filter((m) =>
      existsSync(m.projectPath)
    );
    if (valid.length < loaded.length) {
      console.log(
        `[topics] Removed ${loaded.length - valid.length} stale mapping(s) with missing project paths`
      );
    }
    topicMappings = valid;
    if (valid.length < loaded.length) {
      saveTopicMappings();
    }
  } catch {
    topicMappings = [];
  }
}

/** Persist topic mappings to disk (atomic write) */
function saveTopicMappings() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${TOPICS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(topicMappings, null, 2));
  renameSync(tmp, TOPICS_FILE);
}

/** Remove a stale topic mapping by thread ID */
function removeTopicMapping(threadId: number) {
  const idx = topicMappings.findIndex((m) => m.threadId === threadId);
  if (idx !== -1) {
    topicMappings.splice(idx, 1);
    saveTopicMappings();
  }
}

/** Find existing topic or create a new forum topic for a project. Deduplicates concurrent calls. */
export function ensureTopic(api: Api, chatId: number, projectPath: string) {
  const pending = pendingTopics.get(projectPath);
  if (pending) {
    return pending;
  }

  const promise = resolveOrCreateTopic(api, chatId, projectPath).then(
    async (threadId) => {
      await ensurePinnedRepoLink(api, chatId, threadId, projectPath);
      return threadId;
    }
  );
  pendingTopics.set(projectPath, promise);
  return promise.finally(() => pendingTopics.delete(projectPath));
}

async function resolveOrCreateTopic(
  api: Api,
  chatId: number,
  projectPath: string
) {
  const existing = topicMappings.find((m) => m.projectPath === projectPath);
  if (existing) {
    try {
      await api.sendChatAction(chatId, "typing", {
        message_thread_id: existing.threadId,
      });
      return existing.threadId;
    } catch {
      removeTopicMapping(existing.threadId);
    }
  }
  return createTopic(api, chatId, projectPath);
}

/** Create a forum topic and persist the mapping */
async function createTopic(api: Api, chatId: number, projectPath: string) {
  const projectName = basename(projectPath);
  try {
    const topic = await api.createForumTopic(chatId, projectName);
    const mapping: TopicMapping = {
      threadId: topic.message_thread_id,
      projectPath,
      projectName,
    };
    topicMappings.push(mapping);
    saveTopicMappings();
    return topic.message_thread_id;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not enough rights")) {
      throw new TopicPermissionError(projectName);
    }
    throw e;
  }
}

/** Thrown when the bot lacks "Manage Topics" permission */
export class TopicPermissionError extends Error {
  constructor(projectName: string) {
    super(
      `Cannot create topic "${projectName}": bot needs "Manage Topics" permission in group settings.`
    );
    this.name = "TopicPermissionError";
  }
}

/** Get GitHub repo URL from a project directory's git remote */
function getRepoUrl(projectPath: string) {
  try {
    const raw = execSync("git remote get-url origin", {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    // Convert SSH URL to HTTPS
    const sshMatch = raw.match(SSH_REMOTE_RE);
    if (sshMatch) {
      return `https://github.com/${sshMatch[1]}`;
    }
    if (raw.startsWith("https://")) {
      return raw.replace(GIT_SUFFIX_RE, "");
    }
    return null;
  } catch {
    return null;
  }
}

/** Ensure the topic has a pinned message with the GitHub repo link */
async function ensurePinnedRepoLink(
  api: Api,
  chatId: number,
  threadId: number,
  projectPath: string
) {
  const mapping = topicMappings.find((m) => m.threadId === threadId);
  if (!mapping || mapping.pinnedRepoLinkId) {
    return;
  }

  const repoUrl = getRepoUrl(projectPath);
  if (!repoUrl) {
    return;
  }

  try {
    const projectName = basename(projectPath);
    const msg = await api.sendMessage(
      chatId,
      `<a href="${repoUrl}">${projectName}</a>`,
      {
        message_thread_id: threadId,
        parse_mode: "HTML",
      }
    );
    await api
      .pinChatMessage(chatId, msg.message_id, { disable_notification: true })
      .catch(() => {});
    mapping.pinnedRepoLinkId = msg.message_id;
    saveTopicMappings();
  } catch (e) {
    console.error(`[topics] Failed to pin repo link in topic ${threadId}:`, e);
  }
}

/** Get project path for a thread ID. Removes mapping if project folder no longer exists. */
export function getProjectForThread(threadId: number) {
  const mapping = topicMappings.find((m) => m.threadId === threadId);
  if (!mapping) {
    return undefined;
  }
  if (!existsSync(mapping.projectPath)) {
    removeTopicMapping(threadId);
    return undefined;
  }
  return mapping.projectPath;
}
