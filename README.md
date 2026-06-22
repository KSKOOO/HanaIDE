<p align="center">
  <img src=".github/assets/banner.jpg" width="100%" alt="HanaIDE Banner">
</p>

<p align="center">
  <img src=".github/assets/hanaide-280.png" width="80" alt="HanaIDE">
</p>

<h1 align="center">HanaIDE</h1>

<p align="center">面向编程开发的本地 AI IDE，集成项目资源管理器、代码编辑器、交互终端、VS Code 扩展兼容层、SSH 工作区和编程助手。</p>

<p align="center"><a href="README_EN.md">English</a></p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](#平台支持)

---

## HanaIDE 是什么

HanaIDE 是一个以代码工作流为核心的桌面开发环境。它不再把通用聊天或频道作为主入口，而是把真实项目开发需要的文件浏览、代码编辑、终端执行、扩展管理、模型配置、技能约束和 AI 编程协作放在同一个工作台里。

当前版本的重点是让开发者能够在一个窗口内完成：

- 打开本地或 SSH 远程项目。
- 阅读、编辑和预览代码与 Markdown 文件。
- 使用交互终端运行测试、构建、脚本和诊断命令。
- 用右侧编程助手分析代码、规划修改、排查错误和整理文档。
- 安装和管理偏 Node/workspace 的 VS Code 扩展能力。
- 通过内置技能约束 AI 修改范围、验证方式和前端质量。

## 核心能力

**编程工作台** - 左侧资源管理器管理文件，中央编辑区支持多标签，底部面板提供终端、问题、输出和日志，右侧固定为编程助手。

**交互终端** - 终端通过后端 PTY 会话运行，不再把原始流直接塞进静态文本块。Windows PowerShell 默认注入 UTF-8 编码，减少中文乱码。

**文件右键菜单** - 文件树菜单覆盖打开、打开方式、资源管理器中显示、在集成终端中打开、比较、添加到助手、剪切、复制、复制路径、复制相对路径、重命名和删除。

**VS Code 扩展兼容层** - 支持搜索、安装、启用、停用和卸载扩展，并优先适配语言服务、代码工具、命令类和 workspace 扩展。

**SSH 工作区** - 设置页可以新增 SSH 工作区，后端通过 SSH/SFTP workspace provider 读写远程文件，并支持远程终端会话。

**模型与技能** - 设置页聚焦编程所需模型、权限、技能和 Provider。默认助手是 HanaIDE 编程助手，默认技能只保留适合软件开发的模板与提示词。

**本地优先** - 用户配置、工作区状态、会话、技能和运行数据默认存储在本机。上传、远程连接和外部网络访问需要用户明确配置。

## 截图

<p align="center">
  <img src=".github/assets/screenshot-main.jpg" width="100%" alt="HanaIDE 编程工作台">
</p>

## 快速开始

### 开发运行

```bash
npm install
npm start
```

使用 Vite HMR 调试渲染层：

```bash
npm run dev:renderer
npm run start:vite
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm start` | 构建 preload、renderer、theme 后启动 Electron |
| `npm run start:vite` | 使用 Vite HMR 启动桌面端 |
| `npm run server` | 单独启动后端服务 |
| `npm test` | 运行 Vitest 测试 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run build:renderer` | 构建前端渲染层 |
| `npm run build:server` | 构建后端运行包 |

## 项目结构

```text
core/           引擎编排与 Manager 层
desktop/        Electron 主进程、preload 与 React 渲染端
lib/            提示词、工具、终端、沙箱、模型和运行时库
server/         Hono HTTP + WebSocket 后端服务
shared/         前后端共享类型、配置、IPC contract 和工具
plugins/        内置系统插件
skills2set/     内置编程技能定义
scripts/        构建、打包、签名和发布脚本
tests/          Vitest 测试套件
```

## 架构概览

桌面壳由 Electron 承载。主进程负责窗口、菜单、IPC、文件系统、扩展安装和后端进程生命周期；preload 暴露受控 Platform API；React 渲染端负责工作台布局、编辑器、终端面板、扩展页、设置页和编程助手。

后端以独立 Node.js 进程运行，通过 HTTP/WebSocket 与桌面端通信。工作区文件、SSH mount、终端会话、VS Code 扩展服务、模型 Provider、技能和插件都从后端统一进入可测试的 API 边界。

## 平台支持

| 平台 | 状态 |
|------|------|
| Windows | 主要适配平台 |
| macOS Apple Silicon / Intel | 支持 |
| Linux | 支持 |

## 上传 GitHub 前检查

仓库 `.gitignore` 已排除本地依赖、缓存、构建产物、用户数据、密钥和开发临时目录。提交前建议执行：

```bash
npm test
npm run typecheck
npm run build:renderer
git status --short --ignored
```

不要提交：

- `node_modules/`
- `dist-server/`
- `dist-server-bundle/`
- `desktop/dist-renderer/`
- `.cache/`
- `.superpowers/`
- `.codex/`
- `.env`、私钥、证书、本地数据库和用户会话数据

## License

[Apache License 2.0](LICENSE)

Copyright (c) 2026 liliMozi, kskooo.
