import Groq from "groq-sdk"
import { mkdtemp, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { $ } from "bun"

const groq = new Groq()
const MAX_SIZE = 20 * 1024 * 1024
const TRANSCRIBE_TIMEOUT = 60_000
const FFMPEG_TIMEOUT = 30_000

/** Race a promise against a timeout, rejecting with a descriptive error */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ])
}

/** Transcribe audio buffer using Groq Whisper, chunking if >20MB */
export async function transcribeAudio(buffer: Buffer, filename: string) {
  if (buffer.length <= MAX_SIZE) {
    return transcribeChunk(buffer, filename)
  }

  const tempDir = await mkdtemp(join(tmpdir(), "tg-voice-"))

  try {
    const inputPath = join(tempDir, filename)
    await Bun.write(inputPath, buffer)

    const probeResult = await withTimeout(
      $`ffprobe -v error -show_entries format=duration -of csv=p=0 ${inputPath}`.text(),
      FFMPEG_TIMEOUT, "ffprobe"
    )
    const totalDuration = parseFloat(probeResult.trim())
    const numChunks = Math.ceil(buffer.length / MAX_SIZE)
    const chunkDuration = totalDuration / numChunks

    const transcriptions: string[] = []

    for (let i = 0; i < numChunks; i++) {
      const start = i * chunkDuration
      const chunkPath = join(tempDir, `chunk_${i}.ogg`)
      await withTimeout(
        $`ffmpeg -y -i ${inputPath} -ss ${start} -t ${chunkDuration} -c copy ${chunkPath}`.quiet(),
        FFMPEG_TIMEOUT, "ffmpeg"
      )

      const chunkBuffer = Buffer.from(await Bun.file(chunkPath).arrayBuffer())
      const text = await transcribeChunk(chunkBuffer, `chunk_${i}.ogg`)
      transcriptions.push(text)
    }

    return transcriptions.join(" ")
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

/** Transcribe a single audio buffer */
async function transcribeChunk(buffer: Buffer, filename: string) {
  const file = new File([new Uint8Array(buffer)], filename, { type: "audio/ogg" })
  const response = await withTimeout(
    groq.audio.transcriptions.create({ file, model: "whisper-large-v3-turbo" }),
    TRANSCRIBE_TIMEOUT, "Groq transcription"
  )
  return response.text
}
