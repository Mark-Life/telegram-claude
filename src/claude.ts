import { spawn } from "bun"

type ContentBlockStart =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "thinking"; thinking: string }

type ContentBlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }

type StreamEvent =
  | { type: "system"; subtype: "init"; session_id: string }
  | { type: "stream_event"; event: { type: "content_block_start"; index: number; content_block: ContentBlockStart } }
  | { type: "stream_event"; event: { type: "content_block_delta"; index: number; delta: ContentBlockDelta } }
  | { type: "stream_event"; event: { type: "content_block_stop"; index: number } }
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
  | { kind: "tool_use"; name: string; input: string }
  | { kind: "thinking_start" }
  | { kind: "thinking_done"; durationMs: number }
  | { kind: "result"; text: string; sessionId: string; cost: number; durationMs: number; turns: number }
  | { kind: "error"; message: string }

const userProcesses = new Map<number, AbortController>()
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** Format tool input into a short description */
function formatToolInput(name: string, input: Record<string, unknown>) {
  switch (name) {
    case "Read":
      return input.file_path ? String(input.file_path) : ""
    case "Write":
      return input.file_path ? String(input.file_path) : ""
    case "Edit":
      return input.file_path ? String(input.file_path) : ""
    case "Bash": {
      const cmd = input.command ? String(input.command) : ""
      return cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd
    }
    case "Glob":
      return input.pattern ? String(input.pattern) : ""
    case "Grep":
      return input.pattern ? String(input.pattern) : ""
    case "WebFetch":
      return input.url ? String(input.url) : ""
    case "WebSearch":
      return input.query ? String(input.query) : ""
    case "Task":
      return input.description ? String(input.description) : ""
    default:
      return ""
  }
}

/** Create a stateful stream-json parser */
function createStreamParser() {
  let hasEmittedContent = false
  let currentBlockType: "text" | "tool_use" | "thinking" | null = null
  let currentToolName = ""
  let toolInputJson = ""
  let thinkingStartTime = 0

  return function* parseStreamLines(lines: string[]): Generator<ClaudeEvent> {
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
        parsed.event.type === "content_block_start" &&
        "content_block" in parsed.event
      ) {
        const block = parsed.event.content_block
        if (block.type === "text") {
          currentBlockType = "text"
        } else if (block.type === "tool_use") {
          currentBlockType = "tool_use"
          currentToolName = block.name
          toolInputJson = ""
        } else if (block.type === "thinking") {
          currentBlockType = "thinking"
          thinkingStartTime = Date.now()
          hasEmittedContent = true
          yield { kind: "thinking_start" }
        }
      } else if (
        parsed.type === "stream_event" &&
        parsed.event.type === "content_block_delta" &&
        "delta" in parsed.event
      ) {
        const delta = parsed.event.delta
        if (delta.type === "text_delta" && currentBlockType === "text") {
          hasEmittedContent = true
          yield { kind: "text_delta", text: delta.text }
        } else if (delta.type === "input_json_delta" && currentBlockType === "tool_use") {
          toolInputJson += delta.partial_json
        }
        // thinking_delta and signature_delta: ignored (we just show "Thinking...")
      } else if (
        parsed.type === "stream_event" &&
        parsed.event.type === "content_block_stop"
      ) {
        if (currentBlockType === "tool_use") {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(toolInputJson)
          } catch {}
          const shortInput = formatToolInput(currentToolName, input)
          hasEmittedContent = true
          yield { kind: "tool_use", name: currentToolName, input: shortInput }
        } else if (currentBlockType === "thinking") {
          const elapsed = Date.now() - thinkingStartTime
          yield { kind: "thinking_done", durationMs: elapsed }
        }
        currentBlockType = null
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
    const parseStreamLines = createStreamParser()

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
