# telegram-claude

Telegram bot interface for Claude Code on a VPS. Message the bot from any device, it runs Claude Code in your project directories and streams back results.

## Features

- **Project switching** — select any project directory via inline keyboard
- **Streaming responses** — progressively edited messages with live Claude output
- **Session continuity** — follow-up messages continue the same Claude conversation
- **Voice messages** — voice notes transcribed via Groq Whisper, then sent to Claude as text
- **Long response splitting** — auto-splits messages exceeding Telegram's 4000 char limit
- **MarkdownV2 rendering** — formatted output with plain text fallback
- **Cost & duration tracking** — metadata footer on each response
- **Access control** — single authorized user via Telegram user ID

## Prerequisites

- [Bun](https://bun.sh/) runtime
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated
- [ffmpeg](https://ffmpeg.org/) — required for voice messages >20MB (chunked transcription)
- [Groq](https://console.groq.com/) API key — for voice message transcription

## Setup

### 1. Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. `/newbot` → follow prompts → copy the bot token

### 2. Get Your Telegram User ID

Forward any message to [@userinfobot](https://t.me/userinfobot) — it replies with your user ID.

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:
```
BOT_TOKEN=your_bot_token_here
ALLOWED_USER_ID=your_telegram_user_id
PROJECTS_DIR=/home/agent/projects
GROQ_API_KEY=your_groq_api_key
```

### 4. Install & Run

```bash
bun install
bun run src/index.ts
```

Or as a tmux session:
```bash
tmux new-session -d -s telegram-claude 'cd ~/projects/telegram-claude && bun run src/index.ts'
```

## Commands

| Command | Description |
|-----------|--------------------------------------|
| `/projects` | Select active project directory |
| `/stop` | Kill running Claude process |
| `/status` | Show active project & process state |
| `/new` | Clear session, start fresh conversation |

Text messages are forwarded to Claude Code as prompts. Voice messages are transcribed and forwarded the same way.

## How It Works

- Spawns `claude -p "<msg>" --output-format stream-json` in the selected project dir
- Streams response back by progressively editing a Telegram message (~1.5s interval)
- Long responses auto-split into multiple messages (4000 char limit)
- Follow-up messages continue the same Claude session via `-r <session-id>`
- Voice notes are transcribed via Groq Whisper (`whisper-large-v3-turbo`), files >20MB are chunked with ffmpeg
- One active process per user; use `/stop` to cancel

## Stack

TypeScript, Bun, [grammy](https://grammy.dev/), [Groq SDK](https://github.com/groq/groq-typescript)
