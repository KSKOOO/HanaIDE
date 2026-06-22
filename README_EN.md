<p align="center">
  <img src=".github/assets/banner.jpg" width="100%" alt="HanaIDE Banner">
</p>

<p align="center">
  <img src=".github/assets/hanaide-280.png" width="80" alt="HanaIDE">
</p>

<h1 align="center">HanaIDE</h1>

<p align="center">A local AI IDE for software development, with project files, code editing, interactive terminals, VS Code extension compatibility, SSH workspaces, and a coding assistant.</p>

<p align="center"><a href="README.md">中文</a></p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](#platform-support)

---

## What is HanaIDE

HanaIDE is a desktop development environment centered on real coding workflows. General chat and channel-style product surfaces are no longer the main entry point. The workbench focuses on file navigation, code editing, terminal execution, extension management, model configuration, coding skills, and AI-assisted development.

The current version is designed for:

- Opening local or SSH remote projects.
- Reading, editing, and previewing source and Markdown files.
- Running tests, builds, scripts, and diagnostics in an interactive terminal.
- Using the right-side coding assistant for code analysis, patch planning, debugging, and documentation.
- Installing and managing VS Code extensions, with priority on language, command, tool, and workspace extensions.
- Constraining AI changes through built-in coding skills and verification prompts.

## Core Features

**Coding Workbench** - The left explorer manages files, the center editor supports tabs, the bottom panel hosts terminal/problems/output/logs, and the right panel hosts the coding assistant.

**Interactive Terminal** - Terminal sessions run through backend PTY sessions instead of raw static text. Windows PowerShell receives UTF-8 bootstrap commands to reduce mojibake.

**File Context Menu** - File tree menus cover open, open with, reveal in explorer, open in integrated terminal, compare, add to assistant, cut, copy, copy path, copy relative path, rename, and delete.

**VS Code Extension Compatibility** - Search, install, enable, disable, and uninstall extensions. The first target is Node/workspace extensions such as language services, code tools, and command extensions.

**SSH Workspaces** - Settings can register SSH workspaces. The backend exposes SSH/SFTP workspace mounts for remote file read/write and remote terminal sessions.

**Models and Skills** - Settings focus on model providers, permissions, skills, and programming-oriented defaults. The default assistant is the HanaIDE coding assistant.

**Local First** - User configuration, workspace state, sessions, skills, and runtime data stay local by default. Uploads, remote access, and network calls require explicit configuration.

## Screenshot

<p align="center">
  <img src=".github/assets/screenshot-main.jpg" width="100%" alt="HanaIDE Coding Workbench">
</p>

## Quick Start

### Development Run

```bash
npm install
npm start
```

For renderer HMR:

```bash
npm run dev:renderer
npm run start:vite
```

### Common Commands

| Command | Description |
|---------|-------------|
| `npm start` | Build preload, renderer, theme, then start Electron |
| `npm run start:vite` | Start the desktop app with Vite HMR |
| `npm run server` | Start the backend server only |
| `npm test` | Run the Vitest suite |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run build:renderer` | Build the renderer |
| `npm run build:server` | Build the backend runtime package |

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

## Architecture

The desktop shell is hosted by Electron. The main process owns windows, menus, IPC, filesystem access, extension installation, and backend process lifecycle. The preload layer exposes a constrained Platform API. The React renderer owns the workbench layout, editor, terminal panel, extension page, settings, and coding assistant.

The backend runs as a standalone Node.js process and communicates with the desktop app over HTTP/WebSocket. Workspace files, SSH mounts, terminal sessions, VS Code extension services, model providers, skills, and plugins enter through testable backend API boundaries.

## Platform Support

| Platform | Status |
|----------|--------|
| Windows | Primary target |
| macOS Apple Silicon / Intel | Supported |
| Linux | Supported |

## Before Uploading to GitHub

The repository `.gitignore` excludes local dependencies, caches, build artifacts, user data, secrets, and scratch files. Before uploading, run:

```bash
npm test
npm run typecheck
npm run build:renderer
git status --short --ignored
```

Do not commit:

- `node_modules/`
- `dist-server/`
- `dist-server-bundle/`
- `desktop/dist-renderer/`
- `.cache/`
- `.superpowers/`
- `.codex/`
- `.env`, private keys, certificates, local databases, or user session data

## License

[Apache License 2.0](LICENSE)

Copyright (c) 2026 liliMozi, kskooo.
