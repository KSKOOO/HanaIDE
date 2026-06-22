/**
 * Integration test for createSession tool snapshot behavior (Task 5).
 *
 * Covers the three branches:
 *   A. restore=true + meta has toolNames  → replay snapshot
 *   B. restore=true + meta missing        → legacy, keep all tools
 *   C. restore=false                       → fresh compute from config
 * Plus tampering protection: core tools survive even if listed in disabled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

const { createAgentSessionMock, sessionManagerCreateMock, sessionManagerOpenMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: sessionManagerOpenMock,
  },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
  estimateTokens: vi.fn(() => 0),
  findCutPoint: vi.fn(),
  generateSummary: vi.fn(),
  emitSessionShutdown: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";
import { isBeautifyEnabledForAgentConfig } from "../plugins/beautify/lib/availability.ts";
import { CORE_TOOL_NAMES } from "../shared/tool-categories.ts";

// Fake tool objects — only needs `.name` to satisfy `.map(t => t.name)` paths
function makeTool(name) {
  return { name, execute: vi.fn() };
}

// Pi SDK built-in tools — in production these come from
// createSandboxedTools().tools, NOT from agent.tools. Mirror that structure so
// tests exercise the real code paths.
const SDK_BUILTIN_OBJS = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
].map(makeTool);

// HanaIDE custom tools — in production these come from agent.tools getter
// and flow through buildTools.customTools.
const HANAKO_CUSTOM_OBJS = [
  "search_memory", "pin_memory", "unpin_memory", "web_search",
  "web_fetch", "todo_write", "notify",
  "stage_files", "subagent", "channel", "record_experience",
  "recall_experience", "check_pending_tasks", "current_status", "stop_task",
  "session_folders", "browser", "automation", "dm", "install_skill", "update_settings",
].map(makeTool);

function allNames() {
  return [
    ...SDK_BUILTIN_OBJS.map((t) => t.name),
    ...HANAKO_CUSTOM_OBJS.map((t) => t.name),
  ];
}

function defaultBaselineNames() {
  return allNames().filter((name) => name !== "dm");
}

function restoredSnapshot(names, availableNames = allNames()) {
  const available = new Set(availableNames);
  const seen = new Set();
  const result = [];
  for (const name of names || []) {
    if (typeof name !== "string" || name.length === 0 || seen.has(name) || !available.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  for (const name of CORE_TOOL_NAMES) {
    if (!available.has(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

describe("session-coordinator tool snapshot (createSession)", () => {
  let tmpDir, agentDir, sessionDir, coord, fakeSessionPath, activeToolsSpy, buildSystemPromptSpy, currentAgentConfig, channelsEnabled, defaultModeSaveSpy, storedDefaultMode, storedThinkingLevel, lastSessionOptions, fakeEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-snapshot-"));
    agentDir = path.join(tmpDir, "agents", "test");
    sessionDir = path.join(agentDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fakeSessionPath = path.join(sessionDir, "test-session.jsonl");

    currentAgentConfig = {}; // tests mutate this before calling createSession
    channelsEnabled = true;

    activeToolsSpy = vi.fn();
    buildSystemPromptSpy = vi.fn(() => "mock-prompt");
    defaultModeSaveSpy = vi.fn((mode) => {
      storedDefaultMode = mode;
      return mode;
    });
    storedDefaultMode = "ask";
    storedThinkingLevel = "auto";
    lastSessionOptions = null;
    fakeEngine = {
      getUiContext: vi.fn(() => null),
      isVisionAuxiliaryEnabled: vi.fn(() => false),
      getVisionBridge: vi.fn(() => null),
    };

    sessionManagerCreateMock.mockReturnValue({ getCwd: () => tmpDir });
    sessionManagerOpenMock.mockReturnValue({ getCwd: () => tmpDir });
    createAgentSessionMock.mockImplementation(async (options) => {
      lastSessionOptions = options;
      return {
      session: {
        sessionManager: { getSessionFile: () => fakeSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
      };
    });

    const agent = {
      id: "test",
      agentDir,
      sessionDir,
      tools: HANAKO_CUSTOM_OBJS,
      get config() { return currentAgentConfig; },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: buildSystemPromptSpy,
      memoryEnabled: true,
    };

    coord = new SessionCoordinator({
      agentsDir: path.join(tmpDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "test",
      getModels: () => ({
        currentModel: { id: "test-model", name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level === "auto" ? "medium" : level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "mock-prompt",
        getAppendSystemPrompt: () => [],
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: SDK_BUILTIN_OBJS, customTools: HANAKO_CUSTOM_OBJS }),
      emitEvent: vi.fn(),
      emitDevLog: vi.fn(),
      getHomeCwd: () => tmpDir,
      agentIdFromSessionPath: () => "test",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({
        getThinkingLevel: () => storedThinkingLevel,
        getChannelsEnabled: () => channelsEnabled,
        getSessionPermissionModeDefault: () => storedDefaultMode,
        setSessionPermissionModeDefault: defaultModeSaveSpy,
      }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
      getDeferredResultStore: () => null,
      getEngine: () => fakeEngine,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Case C tests ─────────────────────────────────────────────

  it("Case C: new session with NO tools config applies DEFAULT_DISABLED (dm off, update_settings on)", async () => {
    currentAgentConfig = {}; // fresh agent or upgrade, tools field absent
    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toContain("update_settings");
    expect(appliedList).not.toContain("dm");
    // everything else still on
    expect(appliedList).toContain("browser");
    expect(appliedList).toContain("automation");
    expect(appliedList).toContain("install_skill");
    expect(appliedList).toContain("read"); // SDK built-in preserved
    expect(coord.getAccessMode()).toBe("operate");

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)].accessMode).toBe("operate");
  });

  it("starts fresh sessions from the persisted global permission default", async () => {
    storedDefaultMode = "operate";
    currentAgentConfig = { tools: { disabled: [] } };

    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    expect(coord.getPermissionModeDefault()).toBe("operate");
    expect(coord.getPermissionMode(sessionPath)).toBe("operate");
    expect(coord.getAccessMode(sessionPath)).toBe("operate");
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)]).toMatchObject({
      permissionMode: "operate",
      accessMode: "operate",
      planMode: false,
    });
  });

  it("projects persisted permission mode for cold sessions in the session list", async () => {
    fs.writeFileSync(fakeSessionPath, [
      JSON.stringify({
        type: "session",
        id: "cold-auto",
        cwd: tmpDir,
        timestamp: "2026-06-08T08:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "hello",
          timestamp: "2026-06-08T08:01:00.000Z",
        },
      }),
    ].join("\n") + "\n");
    fs.writeFileSync(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(fakeSessionPath)]: {
          permissionMode: "auto",
          accessMode: "operate",
          planMode: false,
        },
      }, null, 2),
    );
    coord._d.listAgents = () => [{ id: "test", name: "Test" }];

    const sessions = await coord.listSessions();

    expect(coord._sessions.has(fakeSessionPath)).toBe(false);
    expect(sessions).toEqual([
      expect.objectContaining({
        path: fakeSessionPath,
        permissionMode: "auto",
      }),
    ]);
  });

  it("keeps active-session permission changes out of the global new-session default", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: firstPath } = await coord.createSession(null, tmpDir, true);

    coord.setPermissionMode("operate");

    const secondSessionPath = path.join(sessionDir, "second-session.jsonl");
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => secondSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
    });
    const { sessionPath: secondPath } = await coord.createSession(null, tmpDir, true);

    expect(coord.getPermissionMode(firstPath)).toBe("operate");
    expect(coord.getPermissionMode(secondPath)).toBe("ask");
    expect(coord.getPermissionModeDefault()).toBe("ask");
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();
  });

  it("can stage a pending new-session permission mode without mutating the active session", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: activePath } = await coord.createSession(null, tmpDir, true);

    const result = coord.setPendingPermissionMode("read_only");

    expect(result).toMatchObject({ ok: true, mode: "read_only", enabled: true });
    expect(coord.getPermissionMode(activePath)).toBe("ask");
    expect(coord.getPermissionModeDefault()).toBe("read_only");
    expect(defaultModeSaveSpy).toHaveBeenCalledWith("read_only");

    const secondSessionPath = path.join(sessionDir, "pending-read-only.jsonl");
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => secondSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
    });
    const { sessionPath: nextPath } = await coord.createSession(null, tmpDir, true);

    expect(coord.getPermissionMode(nextPath)).toBe("read_only");
  });

  it("creates detached sessions without changing the focused session", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: focusedPath } = await coord.createSession(null, tmpDir, true);

    const detachedSessionPath = path.join(sessionDir, "quick-chat-detached.jsonl");
    createAgentSessionMock.mockImplementationOnce(async (options) => {
      lastSessionOptions = options;
      return {
      session: {
        sessionManager: { getSessionFile: () => detachedSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
      };
    });

    const { sessionPath: detachedPath } = await coord.createDetachedSession({
      cwd: tmpDir,
      memoryEnabled: true,
      visibleInSessionList: true,
    });

    expect(detachedPath).toBe(detachedSessionPath);
    expect(coord.currentSessionPath).toBe(focusedPath);
    expect(coord.session.sessionManager.getSessionFile()).toBe(focusedPath);
    expect(coord._sessions.get(detachedPath)?.visibleInSessionList).toBe(true);
    expect(coord.getPermissionMode(detachedPath)).toBe("ask");
  });

  it("persists the resolved thinking level as session-owned state when creating a session", async () => {
    storedThinkingLevel = "high";
    currentAgentConfig = { tools: { disabled: [] } };

    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    expect(lastSessionOptions.thinkingLevel).toBe("high");
    expect(coord.getSessionThinkingLevel(sessionPath)).toBe("high");

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)]).toMatchObject({
      thinkingLevel: "high",
    });
  });

  it("can switch only the current session permission mode without mutating the runtime default", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: firstPath } = await coord.createSession(null, tmpDir, true);

    const result = coord.setCurrentSessionPermissionMode("operate");

    expect(result).toMatchObject({ ok: true, mode: "operate", enabled: false });
    expect(coord.getPermissionMode(firstPath)).toBe("operate");
    expect(coord.getPermissionModeDefault()).toBe("ask");

    const secondSessionPath = path.join(sessionDir, "second-ask-session.jsonl");
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => secondSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
    });
    const { sessionPath: secondPath } = await coord.createSession(null, tmpDir, true);

    expect(coord.getPermissionMode(secondPath)).toBe("ask");
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(firstPath)]).toMatchObject({
      permissionMode: "operate",
      accessMode: "operate",
      planMode: false,
    });
    expect(meta[path.basename(secondPath)]).toMatchObject({
      permissionMode: "ask",
      accessMode: "operate",
      planMode: false,
    });
  });

  it("does not let explicit loaded-session permission changes rewrite the global default", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    const result = coord.setSessionPermissionMode(sessionPath, "auto", { persistDefault: true });

    expect(result).toMatchObject({ ok: true, mode: "auto", enabled: false });
    expect(coord.getPermissionMode(sessionPath)).toBe("auto");
    expect(coord.getPermissionModeDefault()).toBe("ask");
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();
  });

  it("can switch an explicit loaded session permission mode without relying on focus", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: firstPath } = await coord.createSession(null, tmpDir, true);
    coord.setPermissionMode("read_only");

    const secondSessionPath = path.join(sessionDir, "focused-session.jsonl");
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => secondSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
    });
    const { sessionPath: secondPath } = await coord.createSession(null, tmpDir, true);
    expect(coord.currentSessionPath).toBe(secondPath);

    const result = coord.setSessionPermissionMode(firstPath, "operate");

    expect(result).toMatchObject({ ok: true, mode: "operate", enabled: false });
    expect(coord.getPermissionMode(firstPath)).toBe("operate");
    expect(coord.getPermissionMode(secondPath)).toBe("ask");
    expect(coord.getPermissionModeDefault()).toBe("ask");
  });

  it("new session with pending read-only access mode keeps tool schema stable", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    coord.setPendingAccessMode("read_only");

    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toEqual(allNames());

    const entry = coord._sessions.get(sessionPath);
    expect(entry.accessMode).toBe("read_only");
    expect(entry.permissionMode).toBe("read_only");
    expect(entry.planMode).toBe(true);

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)].permissionMode).toBe("read_only");
    expect(meta[path.basename(sessionPath)].accessMode).toBe("read_only");
  });

  it("Case C: new session with EXPLICIT empty disabled includes all tools in snapshot", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    // setActiveToolsByName should have been called with the full list
    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toEqual(allNames());

    // sessionEntry.toolNames should match
    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toEqual(allNames());

    // Persisted to meta
    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].toolNames).toEqual(allNames());
  });

  it("Case C: fresh session hides channel and dm when the global phone feature is disabled", async () => {
    channelsEnabled = false;
    currentAgentConfig = { tools: { disabled: [] } };

    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("channel");
    expect(appliedList).not.toContain("dm");
    expect(appliedList).toContain("browser");

    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).not.toContain("channel");
    expect(entry.toolNames).not.toContain("dm");
  });

  it("Case A: restore applies the global phone feature gate over frozen toolNames", async () => {
    channelsEnabled = false;
    currentAgentConfig = { tools: { disabled: [] } };
    const replayList = ["read", "channel", "dm", "browser"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toEqual(restoredSnapshot(["read", "browser"]));
    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toEqual(restoredSnapshot(["read", "browser"]));
  });

  it("Case C: snapshot includes Pi SDK built-ins (regression for P1 — bundle must carry read/bash/etc)", async () => {
    currentAgentConfig = { tools: { disabled: ["browser"] } };
    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    // All 7 Pi SDK built-ins must be in the active set even though agent.tools
    // doesn't contain them — they come from sessionTools. Without the P1 fix,
    // setActiveToolsByName would receive only custom tool names and silently
    // disable read/bash/edit/write/grep/find/ls for every fresh session.
    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
      expect(appliedList).toContain(name);
    }
  });

  it("Case C: browser disabled is excluded from snapshot", async () => {
    currentAgentConfig = { tools: { disabled: ["browser"] } };
    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("browser");
    expect(appliedList).toContain("automation");
    expect(appliedList).toContain("read");
  });

  it("Case C: fresh sessions exclude plugin tools disabled by runtime agent config", async () => {
    const mcpTool = {
      ...makeTool("mcp_github_search"),
      isEnabledForAgentConfig: (config) => config?.mcp?.servers?.github?.enabled === true,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, mcpTool],
    });
    currentAgentConfig = { tools: { disabled: [] }, mcp: { servers: { github: { enabled: false } } } };

    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("mcp_github_search");
    expect(appliedList).toContain("read");
    expect(appliedList).toContain("browser");
  });

  it("Case C: fresh sessions exclude computer when its global experiment gate is closed", async () => {
    const computerTool = {
      ...makeTool("computer"),
      isEnabledForAgentConfig: () => false,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, computerTool],
    });
    currentAgentConfig = { tools: { disabled: [] } };

    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("computer");
    expect(appliedList).toContain("read");
    expect(appliedList).toContain("browser");
  });

  it("Case C: beautify plugin tools are default-off for fresh configs", async () => {
    const beautifyTool = {
      ...makeTool("beautify_create-cover"),
      _pluginId: "beautify",
      isEnabledForAgentConfig: isBeautifyEnabledForAgentConfig,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, beautifyTool],
    });
    currentAgentConfig = {};

    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("beautify_create-cover");
    expect(appliedList).toContain("read");
  });

  it("Case C: beautify plugin tools join fresh sessions after explicit opt-in", async () => {
    const beautifyTool = {
      ...makeTool("beautify_create-cover"),
      _pluginId: "beautify",
      isEnabledForAgentConfig: isBeautifyEnabledForAgentConfig,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, beautifyTool],
    });
    currentAgentConfig = { tools: { disabled: ["dm"] } };

    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toContain("beautify_create-cover");
    expect(appliedList).not.toContain("dm");
  });

  it("Case C: tampering with core tool name still keeps it (subset tamper protection)", async () => {
    currentAgentConfig = { tools: { disabled: ["browser", "read"] } };
    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toContain("read");  // core tool preserved
    expect(appliedList).not.toContain("browser");  // optional tool excluded
  });

  it("Case C: persists toolNames to session-meta.json", async () => {
    currentAgentConfig = { tools: { disabled: ["browser", "automation"] } };
    await coord.createSession(null, tmpDir, true);

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    const persisted = meta[path.basename(fakeSessionPath)].toolNames;
    expect(persisted).not.toContain("browser");
    expect(persisted).not.toContain("automation");
    expect(persisted).toContain("dm");
    expect(persisted).toContain("install_skill");
  });

  // ── Case A tests ─────────────────────────────────────────────

  it("Case A: restore with meta containing toolNames replays that exact snapshot", async () => {
    // Pre-write meta with a specific short snapshot
    const replayList = restoredSnapshot(["read", "bash", "edit", "todo_write"]);
    const metaPath = path.join(sessionDir, "session-meta.json");
    await fsp.writeFile(
      metaPath,
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(replayList);
  });

  it("Case A: restore deduplicates frozen toolNames before applying them", async () => {
    const replayList = ["read", "bash", "read", "todo_write", "bash"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(restoredSnapshot(["read", "bash", "todo_write"]));

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].toolNames).toEqual(restoredSnapshot(["read", "bash", "todo_write"]));
  });

  it("Case A: restore repairs corrupted snapshots that lost available core tools only", async () => {
    currentAgentConfig = { tools: { disabled: ["browser", "dm"] } };
    const replayList = ["todo_write", "retired_tool", "todo_write"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    const expected = restoredSnapshot(["todo_write"]);
    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(expected);
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("retired_tool");
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("browser");
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("dm");

    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toEqual(expected);

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].toolNames).toEqual(expected);
  });

  it("Case A: restore keeps newly registered tools inactive when they are absent from the frozen snapshot", async () => {
    const dynamicTool = { ...makeTool("mcp_new_dynamic_tool"), _pluginId: "mcp" };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, dynamicTool],
    });
    const replayList = ["read", "bash", "todo_write"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(
      restoredSnapshot(replayList, [...allNames(), "mcp_new_dynamic_tool"]),
    );
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("mcp_new_dynamic_tool");
  });

  it("Case A: restore replays frozen plugin tool snapshot even if MCP is currently disabled", async () => {
    const mcpTool = {
      ...makeTool("mcp_github_search"),
      isEnabledForAgentConfig: () => false,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, mcpTool],
    });
    const replayList = ["read", "mcp_github_search"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(
      restoredSnapshot(replayList, [...allNames(), "mcp_github_search"]),
    );
  });

  it("Case A: restore replays frozen computer snapshot even if its global gate is now closed", async () => {
    const computerTool = {
      ...makeTool("computer"),
      isEnabledForAgentConfig: () => false,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, computerTool],
    });
    const replayList = ["read", "computer"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(
      restoredSnapshot(replayList, [...allNames(), "computer"]),
    );
  });

  // ── Case B tests ─────────────────────────────────────────────

  it("Case B: restore with meta missing toolNames creates a stable non-plugin baseline snapshot", async () => {
    // Pre-write meta WITHOUT toolNames
    const metaPath = path.join(sessionDir, "session-meta.json");
    await fsp.writeFile(
      metaPath,
      JSON.stringify({ [path.basename(fakeSessionPath)]: { memoryEnabled: true } }, null, 2),
    );
    const dynamicTool = { ...makeTool("mcp_new_dynamic_tool"), _pluginId: "mcp" };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, dynamicTool],
    });

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("mcp_new_dynamic_tool");
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(defaultBaselineNames());

    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).not.toContain("mcp_new_dynamic_tool");
    expect(entry.toolNames).toEqual(defaultBaselineNames());

    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].toolNames).toEqual(entry.toolNames);
  });

  it("Case B: restore when session-meta.json doesn't exist also creates a baseline snapshot", async () => {
    // No meta file on disk
    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toEqual(defaultBaselineNames());

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].toolNames).toEqual(defaultBaselineNames());
  });

  // ── Meta read-failure fallback (P2) ──────────────────────────

  it("restore with unreadable session-meta.json recomputes from current config (fallback) instead of enabling all tools", async () => {
    // Write malformed JSON to trigger a parse error (non-ENOENT)
    await fsp.writeFile(path.join(sessionDir, "session-meta.json"), "{ not valid json ]", "utf-8");
    currentAgentConfig = { tools: { disabled: ["browser"] } };

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    // Snapshot must have been applied (not silent Case B fallback)
    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("browser"); // current disabled list honored
    expect(appliedList).toContain("automation");
    expect(appliedList).toContain("read");

    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).not.toContain("browser");
  });

  // ── Runtime permission mode after session creation ─────────────────────

  it("updates setPlanMode after session creation without changing the default or active tools", async () => {
    currentAgentConfig = { tools: { disabled: ["browser"] } };
    const { sessionPath } = await coord.createSession(null, tmpDir, true);
    expect(activeToolsSpy).toHaveBeenCalledTimes(1); // initial snapshot apply

    const result = coord.setPlanMode(true, SDK_BUILTIN_OBJS.map((t) => t.name));

    expect(result).toMatchObject({ ok: true, mode: "read_only", enabled: true });
    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();
    expect(coord.getPermissionModeDefault()).toBe("ask");
    expect(coord.getAccessMode()).toBe("read_only");
    expect(coord.getPermissionMode(sessionPath)).toBe("read_only");
  });

  it("keeps runtime permission changes out of dynamic append system prompt", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    await coord.createSession(null, tmpDir, true);

    const before = lastSessionOptions.resourceLoader.getAppendSystemPrompt();
    coord.setPermissionMode("read_only");
    const after = lastSessionOptions.resourceLoader.getAppendSystemPrompt();

    expect(after).toEqual(before);
    expect(after.join("\n")).not.toMatch(/READ-ONLY MODE|ASK MODE|只读模式|先问模式/);
  });

  it("does not inject passive UI context into the last user message", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    fakeEngine.getUiContext.mockReturnValue({
      currentViewed: tmpDir,
      activeFile: path.join(tmpDir, "diary.md"),
      activePreview: null,
      pinnedFiles: [],
    });
    await coord.createSession(null, tmpDir, true);

    const extensions = lastSessionOptions.resourceLoader.getExtensions().extensions;
    const contextHandlers = extensions.flatMap((extension) => extension.handlers?.get?.("context") || []);
    const messages = [{ role: "user", content: "跑一遍测试" }];
    for (const handler of contextHandlers) {
      await handler({ messages }, {
        cwd: tmpDir,
        sessionManager: { getSessionFile: () => fakeSessionPath },
      });
    }

    expect(messages).toEqual([{ role: "user", content: "跑一遍测试" }]);
  });

  it("restores accessMode from session meta before applying tools", async () => {
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(fakeSessionPath)]: {
          memoryEnabled: true,
          accessMode: "read_only",
          toolNames: allNames(),
        },
      }, null, 2),
    );
    await coord.createSession(null, tmpDir, true, null, { restore: true });

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toContain("browser");
    expect(appliedList).toContain("web_search");
    expect(appliedList).toContain("bash");
    expect(coord.getAccessMode()).toBe("read_only");
  });

  it("restores plugin tools from the sessionId capability snapshot even when legacy meta is partial", async () => {
    const manifestStore = new SessionManifestStore({
      dbPath: path.join(tmpDir, "session-manifest.db"),
      idGenerator: () => "sess_media_restore",
      now: () => "2026-06-20T10:00:00.000Z",
    });
    coord._sessionManifestStore = manifestStore;
    const mediaTool = { ...makeTool("media_generate-image"), _pluginId: "media" };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, mediaTool],
    });
    const manifest = manifestStore.createForPath({
      sessionPath: fakeSessionPath,
      ownerAgentId: "test",
      domain: "desktop",
      permissionModeSnapshot: { mode: "auto", source: "test" },
    });
    manifestStore.setCapabilitySnapshot(manifest.sessionId, {
      toolNames: [...defaultBaselineNames(), "media_generate-image"],
    }, { source: "legacy_session_meta_backup" });
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(fakeSessionPath)]: {
          toolNames: defaultBaselineNames(),
        },
      }, null, 2),
    );

    try {
      const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

      const appliedList = activeToolsSpy.mock.calls[0][0];
      expect(appliedList).toContain("media_generate-image");
      expect(coord.getPermissionMode(sessionPath)).toBe("auto");
      const entry = coord._sessions.get(manifest.sessionId);
      expect(entry.toolNames).toContain("media_generate-image");
    } finally {
      manifestStore.close();
    }
  });

  it("restores permission from manifest when legacy session-meta lacks permission fields", async () => {
    const manifestStore = new SessionManifestStore({
      dbPath: path.join(tmpDir, "session-manifest.db"),
      idGenerator: () => "sess_permission_restore",
      now: () => "2026-06-20T10:00:00.000Z",
    });
    coord._sessionManifestStore = manifestStore;
    manifestStore.createForPath({
      sessionPath: fakeSessionPath,
      ownerAgentId: "test",
      domain: "desktop",
      permissionModeSnapshot: { mode: "auto", source: "legacy_session_meta" },
    });
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(fakeSessionPath)]: {
          toolNames: allNames(),
        },
      }, null, 2),
    );

    try {
      const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

      expect(coord.getPermissionMode(sessionPath)).toBe("auto");
      expect(coord.getAccessMode(sessionPath)).toBe("operate");
    } finally {
      manifestStore.close();
    }
  });

  it("maps legacy planMode meta to read-only access mode", async () => {
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(fakeSessionPath)]: {
          memoryEnabled: true,
          planMode: true,
          toolNames: allNames(),
        },
      }, null, 2),
    );
    await coord.createSession(null, tmpDir, true, null, { restore: true });

    const planList = activeToolsSpy.mock.calls[0][0];
    expect(planList).toContain("read");
    expect(planList).toContain("browser");
    expect(planList).toContain("bash");
    expect(planList).toContain("automation");
    expect(coord.getAccessMode()).toBe("read_only");
  });

  // ── #1624: dormant capability drift template ─────────────

  describe("capability drift (#1624)", () => {
    function promptSnapshotEntry(systemPrompt) {
      return {
        version: 1,
        systemPrompt,
        appendSystemPrompt: [],
        skillsResult: { skills: [], diagnostics: [] },
        agentsFilesResult: { agentsFiles: [] },
      };
    }

    it("restore keeps the frozen snapshot but no longer computes or wakes capability drift", async () => {
      sessionManagerCreateMock.mockReturnValue({
        getCwd: () => tmpDir,
        getSessionFile: () => fakeSessionPath,
      });
      const newTool = { ...makeTool("office"), _pluginId: "office" };
      coord._d.buildTools = () => ({
        tools: SDK_BUILTIN_OBJS,
        customTools: [...HANAKO_CUSTOM_OBJS, newTool],
      });
      currentAgentConfig = { tools: { disabled: [] } };
      const frozen = restoredSnapshot(allNames());
      await fsp.writeFile(
        path.join(sessionDir, "session-meta.json"),
        JSON.stringify({
          [path.basename(fakeSessionPath)]: {
            toolNames: frozen,
            promptSnapshot: promptSnapshotEntry("mock-prompt"),
          },
        }, null, 2),
      );

      buildSystemPromptSpy.mockClear();
      const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

      // 默认行为零变化：active 工具仍是冻结快照；但不再额外构造 live prompt / drift 提示。
      expect(activeToolsSpy.mock.calls[0][0]).not.toContain("office");
      expect(coord.getSessionCapabilityDriftNotice(sessionPath)).toBeNull();
      expect(buildSystemPromptSpy).not.toHaveBeenCalled();
    });

    it("manual drift entries still use the existing notice and dismiss chain", async () => {
      currentAgentConfig = { tools: { disabled: [] } };
      await fsp.writeFile(
        path.join(sessionDir, "session-meta.json"),
        JSON.stringify({
          [path.basename(fakeSessionPath)]: {
            toolNames: restoredSnapshot(allNames()),
            promptSnapshot: promptSnapshotEntry("mock-prompt"),
          },
        }, null, 2),
      );

      const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });
      const entry = coord._sessions.get(sessionPath);
      entry.capabilityDrift = {
        version: 1,
        hasDrift: true,
        fingerprint: "fp-live",
        frozenFingerprint: "fp-frozen",
        addedToolNames: ["office"],
        removedToolNames: [],
        invalidToolNames: [],
        promptChanged: false,
      };
      const notice = coord.getSessionCapabilityDriftNotice(sessionPath);
      expect(notice).not.toBeNull();
      expect(notice.addedToolNames).toEqual(["office"]);

      await coord.dismissSessionCapabilityDrift(sessionPath, notice.fingerprint);

      // 当前 fingerprint 已被 dismiss → 不再提示
      expect(coord.getSessionCapabilityDriftNotice(sessionPath)).toBeNull();
      // dismiss 状态持久化在 session-meta（跟 session 走）
      const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
      expect(meta[path.basename(fakeSessionPath)].capabilityDriftDismissedFingerprint).toBe(notice.fingerprint);
    });
  });

  // ── #1624: explicit refresh (fresh compact rebuilds both snapshots) ──

  describe("refreshCapabilitySnapshots (#1624)", () => {
    it("rebuilds the tool snapshot with Case C semantics (plugin tools included) and persists it", async () => {
      const pluginTool = { ...makeTool("office"), _pluginId: "office" };
      coord._d.buildTools = () => ({
        tools: SDK_BUILTIN_OBJS,
        customTools: [...HANAKO_CUSTOM_OBJS, pluginTool],
      });
      currentAgentConfig = { tools: { disabled: [] } };
      await fsp.writeFile(
        path.join(sessionDir, "session-meta.json"),
        JSON.stringify({
          [path.basename(fakeSessionPath)]: {
            toolNames: ["read", "bash"],
            promptSnapshot: {
              version: 1,
              systemPrompt: "an older persona prompt",
              appendSystemPrompt: [],
              skillsResult: { skills: [], diagnostics: [] },
              agentsFilesResult: { agentsFiles: [] },
            },
            capabilityDriftDismissedFingerprint: "previously-dismissed",
          },
        }, null, 2),
      );

      const { sessionPath } = await coord.createSession(null, tmpDir, true, null, {
        restore: true,
        refreshCapabilitySnapshots: true,
      });

      // 工具快照按当前配置重算，含插件工具
      const appliedList = activeToolsSpy.mock.calls[0][0];
      expect(appliedList).toContain("office");
      expect(appliedList).toContain("browser");

      // session-meta 同步更新：toolNames + promptSnapshot 重建，dismiss 状态清空
      const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
      const entry = meta[path.basename(fakeSessionPath)];
      expect(entry.toolNames).toContain("office");
      expect(entry.promptSnapshot.systemPrompt).toBe("mock-prompt");
      expect(entry.capabilityDriftDismissedFingerprint).toBeNull();

      // 刷新后无漂移
      expect(coord.getSessionCapabilityDriftNotice(sessionPath)).toBeNull();
    });

    it("reloadSessionRuntime passes the refresh flag through", async () => {
      const pluginTool = { ...makeTool("office"), _pluginId: "office" };
      coord._d.buildTools = () => ({
        tools: SDK_BUILTIN_OBJS,
        customTools: [...HANAKO_CUSTOM_OBJS, pluginTool],
      });
      coord._d.getAgentById = (id) => (id === "test" ? coord._d.getAgent() : null);
      currentAgentConfig = { tools: { disabled: [] } };
      await fsp.writeFile(
        path.join(sessionDir, "session-meta.json"),
        JSON.stringify({
          [path.basename(fakeSessionPath)]: { toolNames: ["read", "bash"] },
        }, null, 2),
      );
      sessionManagerOpenMock.mockReturnValue({ getCwd: () => tmpDir });

      await coord.createSession(null, tmpDir, true, null, { restore: true });
      expect(activeToolsSpy.mock.calls[0][0]).not.toContain("office");

      await coord.reloadSessionRuntime(fakeSessionPath, { refreshCapabilitySnapshots: true });

      const lastApplied = activeToolsSpy.mock.calls[activeToolsSpy.mock.calls.length - 1][0];
      expect(lastApplied).toContain("office");
      const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
      expect(meta[path.basename(fakeSessionPath)].toolNames).toContain("office");
    });
  });
});
