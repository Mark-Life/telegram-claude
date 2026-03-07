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
  projectName: string;
  projectPath: string;
  threadId: number;
}

const DATA_DIR = join(import.meta.dirname, "..", ".data");
const TOPICS_FILE = join(DATA_DIR, "topics.json");

let topicMappings: TopicMapping[] = [];
const pendingTopics = new Map<string, Promise<number>>();

/** Load topic mappings from disk. Removes mappings for project paths that no longer exist. */
export function loadTopicMappings() {
  try {
    const text = readFileSync(TOPICS_FILE, "utf-8");
    const loaded = JSON.parse(text) as TopicMapping[];
    const valid = loaded.filter((m) => existsSync(m.projectPath));
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

  const promise = resolveOrCreateTopic(api, chatId, projectPath);
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
  const topic = await api.createForumTopic(chatId, projectName);
  const mapping: TopicMapping = {
    threadId: topic.message_thread_id,
    projectPath,
    projectName,
  };
  topicMappings.push(mapping);
  saveTopicMappings();
  return topic.message_thread_id;
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
