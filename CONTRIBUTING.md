# Contributing to HanaIDE

HanaIDE is being consolidated into a coding-first local AI IDE. Contributions should prioritize the programming workbench, editor, terminal, extension compatibility, model configuration, skills, workspace APIs, and local runtime stability.

## Development Environment

Prerequisites:

- Node.js >= 24.12, following the `engines` field in `package.json`.
- npm compatible with the current Node.js version.
- C/C++ build tools for native modules such as `better-sqlite3`.
- Windows contributors should install Visual Studio Build Tools with the Desktop development with C++ workload.

Run locally:

```bash
npm install
npm start
```

Renderer HMR:

```bash
npm run dev:renderer
npm run start:vite
```

## Useful Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run the Vitest suite |
| `npm run typecheck` | Run TypeScript checks |
| `npm run build:renderer` | Build the renderer |
| `npm run build:server` | Build the backend runtime package |
| `npm run start:vite` | Start the Electron app with renderer HMR |

## Contribution Scope

Good contributions include:

- Workbench layout, file explorer, editor tabs, folder opening, terminal UX, and right-side coding assistant improvements.
- Prompt, skill, permission, and context improvements for coding tasks.
- VS Code extension compatibility, extension host behavior, and workspace command integration.
- SSH workspace, SFTP file access, terminal sessions, and workspace API fixes.
- Windows/macOS/Linux startup, packaging, sandbox, and path-security fixes.
- Focused tests, type cleanup, documentation, and upload hygiene.

Avoid reintroducing general chat or channel surfaces as the primary product entry point. Compatibility code may remain where tests or migration paths still need it, but new UI should serve programming workflows.

## Pull Requests

Before opening a PR, keep the change focused and include:

- The problem being solved.
- UI, backend, IPC, terminal, extension, or settings boundaries touched.
- Verification commands that were run.
- Known limitations or follow-up work.

Recommended verification:

```bash
npm test
npm run typecheck
npm run build:renderer
```

## Project Layout

```text
core/           Engine orchestration and Manager layer
desktop/        Electron main process, preload, and React renderer
lib/            Prompts, tools, terminal, sandbox, model, and runtime libraries
server/         Hono HTTP + WebSocket backend service
shared/         Shared types, config, IPC contract, and utilities
plugins/        Built-in system plugins
skills2set/     Built-in coding skill definitions
scripts/        Build, packaging, signing, and release helpers
tests/          Vitest test suite
```

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
