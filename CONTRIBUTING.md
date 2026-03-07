# Contributing

Thanks for your interest in contributing to telegram-claude!

## Getting Started

1. Fork the repo and clone it
2. Install dependencies: `bun install`
3. Copy `.env.example` to `.env` and fill in your values
4. Run in dev mode: `bun run dev`

## Development

```bash
bun install              # install dependencies
bun run dev              # dev mode (auto-reload)
bun run src/index.ts     # start bot
bun run lint             # check lint/format
bun run fix              # auto-fix lint/format
```

## Code Style

- TypeScript, functional style preferred
- Formatting/linting handled by [Ultracite](https://github.com/47ng/ultracite) (Biome)
- Run `bun run fix` before committing
- Keep files under 400-500 lines
- Minimize comments — only where logic is non-obvious

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Run `bun run lint` to ensure no new issues
4. Open a PR with a clear description of what and why

## Reporting Issues

Use [GitHub Issues](https://github.com/Mark-Life/telegram-claude/issues) with the provided templates for bug reports and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
