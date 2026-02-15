import { spawn } from "bun"

type StreamEvent =
  | { type: "system"; subtype: "init"; session_id: string }
  | {
      type: "stream_event"
      event: {
        type: "content_block_delta"
        delta: { type: "text_delta"; text: string }
      }
    }
  | { type: "stream_event"; event: { type: string } }
  | {
      type: "assistant"
      message: { content: Array<{ type: string; text?: string }> }
      session_id: string
    }
  | {
      type: "result"
      subtype: string
      is_error: boolean
      result: string
      session_id: string
      total_cost_usd: number
      duration_ms: number
      num_turns: number
    }

export type ClaudeEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "result"; text: string; sessionId: string; cost: number; durationMs: number; turns: number }
  | { kind: "error"; message: string }

const userProcesses = new Map<number, AbortController>()
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** Parse stream-json lines and yield ClaudeEvents */
function* parseStreamLines(lines: string[]): Generator<ClaudeEvent> {
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let parsed: StreamEvent
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (
      parsed.type === "stream_event" &&
      parsed.event.type === "content_block_delta" &&
      "delta" in parsed.event &&
      parsed.event.delta.type === "text_delta"
    ) {
      yield { kind: "text_delta", text: parsed.event.delta.text }
    } else if (parsed.type === "result") {
      yield {
        kind: "result",
        text: parsed.result,
        sessionId: parsed.session_id,
        cost: parsed.total_cost_usd,
        durationMs: parsed.duration_ms,
        turns: parsed.num_turns,
      }
    }
  }
}

/** Spawn claude CLI and yield streaming events, tracked per Telegram user */
export async function* runClaude(
  telegramUserId: number,
  prompt: string,
  projectDir: string,
  sessionId?: string
): AsyncGenerator<ClaudeEvent> {
  if (userProcesses.has(telegramUserId)) {
    yield { kind: "error", message: "A Claude process is already running. Use /stop first." }
    return
  }

  const args = [
    "claude", "-p", prompt,
    "--output-format", "stream-json",
    "--verbose", "--include-partial-messages",
    "--dangerously-skip-permissions",
  ]
  if (sessionId) args.push("-r", sessionId)

  const ac = new AbortController()
  userProcesses.set(telegramUserId, ac)

  const proc = spawn({
    cmd: args,
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDECODE: undefined },
    signal: ac.signal,
  })

  const timeout = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS)

  try {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      yield* parseStreamLines(lines)
    }

    if (buffer.trim()) yield* parseStreamLines([buffer])

    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      yield { kind: "error", message: stderr || `Process exited with code ${exitCode}` }
    }
  } catch (err) {
    if (ac.signal.aborted) {
      yield { kind: "error", message: "Process was stopped." }
    } else {
      yield { kind: "error", message: String(err) }
    }
  } finally {
    clearTimeout(timeout)
    userProcesses.delete(telegramUserId)
    proc.kill()
  }
}

/** Stop the active Claude process for a user */
export function stopClaude(telegramUserId: number) {
  const ac = userProcesses.get(telegramUserId)
  if (!ac) return false
  ac.abort()
  userProcesses.delete(telegramUserId)
  return true
}

/** Check if a user has an active process */
export function hasActiveProcess(telegramUserId: number) {
  return userProcesses.has(telegramUserId)
}
