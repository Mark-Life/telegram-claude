import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/** Load topic mappings from disk */
export function loadTopicMappings() {
  try {
    const text = readFileSync(TOPICS_FILE, "utf-8");
    topicMappings = JSON.parse(text) as TopicMapping[];
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
export function removeTopicMapping(threadId: number) {
  const idx = topicMappings.findIndex((m) => m.threadId === threadId);
  if (idx !== -1) {
    topicMappings.splice(idx, 1);
    saveTopicMappings();
  }
}

/** Find existing topic or create a new forum topic for a project */
export async function ensureTopic(
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

  const pending = pendingTopics.get(projectPath);
  if (pending) {
    return pending;
  }

  const promise = createTopic(api, chatId, projectPath);
  pendingTopics.set(projectPath, promise);
  try {
    return await promise;
  } finally {
    pendingTopics.delete(projectPath);
  }
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

/** Get project path for a thread ID */
export function getProjectForThread(threadId: number) {
  return topicMappings.find((m) => m.threadId === threadId)?.projectPath;
}

/** Get thread ID for a project path */
export function getThreadForProject(projectPath: string) {
  return topicMappings.find((m) => m.projectPath === projectPath)?.threadId;
}

/** Get all topic mappings */
export function getAllTopicMappings() {
  return topicMappings;
}
