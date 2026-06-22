import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSessionMock, sessionManagerCreateMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  emitSessionShutdown: vi.fn(async () => false),
  SessionManager: {
    create: sessionManagerCreateMock,
    list: vi.fn(async () => []),
    open: vi.fn(),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
  resizeModelImageInput: vi.fn(async (image) => image),
  formatModelImageDimensionNote: vi.fn(() => undefined),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";

describe("SessionCoordinator session manifest integration", () => {
  let tempDir;
  let sessionPath;
  let sessionManager;
  let store;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-manifest-coord-"));
    sessionPath = path.join(tempDir, "agents", "hana", "sessions", "alpha.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: "alpha", timestamp: "2026-06-18T04:00:00.000Z", cwd: tempDir }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hello" }, timestamp: "2026-06-18T04:00:01.000Z" }),
      "",
    ].join("\n"));
    sessionManager = {
      getSessionFile: () => sessionPath,
      getCwd: () => tempDir,
    };
    sessionManagerCreateMock.mockReturnValue(sessionManager);
    createAgentSessionMock.mockImplementation(async (opts) => ({
      session: {
        sessionManager: opts.sessionManager,
        model: opts.model,
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    }));
    store = new SessionManifestStore({
      dbPath: path.join(tempDir, "session-manifest.db"),
      idGenerator: () => "sess_coord_0001",
      now: () => "2026-06-18T04:00:02.000Z",
    });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createCoordinator() {
    const agent = {
      id: "hana",
      agentName: "Hana",
      name: "Hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.dirname(sessionPath),
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      config: {},
      tools: [],
      buildSystemPrompt: vi.fn(() => "system"),
    };
    return new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "m", provider: "test", name: "Test Model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level || "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      emitDevLog: vi.fn(),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({
        getThinkingLevel: () => "medium",
        getChannelsEnabled: () => true,
      }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [agent],
      sessionManifestStore: store,
    });
  }

  it("creates and exposes stable session manifests through create/list/pin", async () => {
    const coordinator = createCoordinator();

    const created = await coordinator.createSession(null, tempDir, true);
    const sessions = await coordinator.listSessions();
    const pinnedAt = await coordinator.setSessionPinned(sessionPath, true);

    expect(created).toMatchObject({
      sessionPath,
      sessionId: "sess_coord_0001",
      agentId: "hana",
    });
    expect(sessions.find((session) => session.path === sessionPath)).toMatchObject({
      path: sessionPath,
      sessionId: "sess_coord_0001",
      agentId: "hana",
    });
    expect(store.resolveByLocatorPath(sessionPath)).toMatchObject({
      sessionId: "sess_coord_0001",
      ownerAgentId: "hana",
      lifecycle: "active",
      memoryPolicy: { mode: "enabled", inheritedFrom: "session_create" },
      permissionModeSnapshot: {
        mode: "ask",
        source: "session_create",
      },
      pinnedAt,
    });
  });

  it("pins by sessionId after a path move and treats the path as a legacy locator", async () => {
    const coordinator = createCoordinator();

    await coordinator.createSession(null, tempDir, true);
    const movedPath = path.join(tempDir, "agents", "hana", "sessions", "alpha-renamed.jsonl");
    fs.renameSync(sessionPath, movedPath);
    store.updateLocator("sess_coord_0001", movedPath, "rename");

    const pinnedAt = await coordinator.setSessionPinned({
      sessionId: "sess_coord_0001",
      sessionPath,
    }, true);

    expect(store.getBySessionId("sess_coord_0001")?.pinnedAt).toBe(pinnedAt);
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(movedPath), "session-meta.json"), "utf-8"));
    expect(meta[path.basename(movedPath)]?.pinnedAt).toBe(pinnedAt);
    expect(meta[path.basename(sessionPath)]?.pinnedAt).toBeUndefined();
  });

  it("keys live runtime sessions by sessionId and resolves legacy locators at lookup boundaries", async () => {
    const coordinator = createCoordinator();

    const created = await coordinator.createSession(null, tempDir, true);

    expect(coordinator._sessions.has("sess_coord_0001")).toBe(true);
    expect(coordinator._sessions.has(sessionPath)).toBe(false);
    expect(coordinator.getSessionByPath(sessionPath)).toBe(created.session);

    const movedPath = path.join(tempDir, "agents", "hana", "sessions", "alpha-renamed.jsonl");
    store.updateLocator("sess_coord_0001", movedPath, "rename");

    expect(coordinator.getSessionByPath(sessionPath)).toBe(created.session);
    expect(coordinator.getSessionByPath(movedPath)).toBe(created.session);
  });

  it("keys hibernated runtime metadata by sessionId while preserving legacy path lookup", async () => {
    const coordinator = createCoordinator();

    const created = await coordinator.createSession(null, tempDir, true);
    Object.defineProperty(created.session, "isStreaming", { value: false, configurable: true });
    Object.defineProperty(created.session, "isCompacting", { value: false, configurable: true });
    created.session.dispose = vi.fn();
    created.session.getContextUsage = vi.fn(() => ({ tokens: 42, contextWindow: 1000, percent: 4.2 }));

    await expect(coordinator.hibernateSessionRuntime(sessionPath, "test")).resolves.toBe(true);

    expect(coordinator._hibernatedSessionMeta.has("sess_coord_0001")).toBe(true);
    expect(coordinator._hibernatedSessionMeta.has(sessionPath)).toBe(false);
    expect(coordinator.getSessionByPath(sessionPath)).toBeNull();
    expect(coordinator.getSessionContextUsage(sessionPath)).toEqual({
      tokens: 42,
      contextWindow: 1000,
      percent: 4.2,
    });
  });

  it("keeps saved session titles attached to the session id when the path moves", async () => {
    const coordinator = createCoordinator();

    await coordinator.createSession(null, tempDir, true);
    await coordinator.saveSessionTitle(sessionPath, "Stable title");

    const movedPath = path.join(tempDir, "agents", "hana", "sessions", "alpha-renamed.jsonl");
    store.updateLocator("sess_coord_0001", movedPath, "rename");

    await expect(coordinator.getTitlesForPaths([movedPath])).resolves.toEqual({
      [movedPath]: "Stable title",
    });
  });

  it("persists plugin ownership updates in the session manifest across path moves", async () => {
    const coordinator = createCoordinator();

    await coordinator.createSession(null, tempDir, true);
    await coordinator.setSessionPluginMeta(sessionPath, {
      ownerPluginId: "image-gen",
      kind: "media",
      visibility: "private",
    });

    expect(store.getBySessionId("sess_coord_0001")?.plugin).toEqual({
      ownerPluginId: "image-gen",
      kind: "media",
      visibility: "private",
    });

    const movedPath = path.join(tempDir, "agents", "hana", "sessions", "alpha-renamed.jsonl");
    store.updateLocator("sess_coord_0001", movedPath, "rename");
    await coordinator.setSessionPluginMeta(movedPath, { visibility: "public" });

    expect(store.getBySessionId("sess_coord_0001")?.plugin).toEqual({
      ownerPluginId: "image-gen",
      kind: "media",
      visibility: "public",
    });
  });

  it("projects manifest-owned metadata in the session list after a path move", async () => {
    const coordinator = createCoordinator();

    await coordinator.createSession(null, tempDir, true);
    const pinnedAt = await coordinator.setSessionPinned(sessionPath, true);
    await coordinator.saveSessionTitle(sessionPath, "Moved title");
    await coordinator.setSessionPluginMeta(sessionPath, {
      ownerPluginId: "image-gen",
      kind: "media",
      visibility: "private",
    });

    const movedPath = path.join(tempDir, "agents", "hana", "sessions", "alpha-renamed.jsonl");
    fs.renameSync(sessionPath, movedPath);
    store.updateLocator("sess_coord_0001", movedPath, "rename");

    const moved = (await coordinator.listSessions({ includePluginPrivate: true }))
      .find((session) => session.path === movedPath);
    expect(moved).toMatchObject({
      path: movedPath,
      sessionId: "sess_coord_0001",
      title: "Moved title",
      pinnedAt,
      ownerPluginId: "image-gen",
      sessionKind: "media",
      visibility: "private",
    });
  });

  it("restores manifest-owned policy and workspace fields after a path move without runtime cache", async () => {
    const coordinator = createCoordinator();
    const allowedFolder = path.join(tempDir, "allowed");
    fs.mkdirSync(allowedFolder, { recursive: true });

    await coordinator.createSession(null, tempDir, true);
    await coordinator.setSessionMemoryEnabled(sessionPath, false);
    coordinator.setSessionPermissionMode(sessionPath, "operate");
    await coordinator.setSessionThinkingLevel(sessionPath, "high");
    await coordinator.setSessionAuthorizedFolders(sessionPath, [allowedFolder]);

    const movedPath = path.join(tempDir, "agents", "hana", "sessions", "alpha-renamed.jsonl");
    fs.renameSync(sessionPath, movedPath);
    store.updateLocator("sess_coord_0001", movedPath, "rename");

    const restarted = createCoordinator();
    expect(restarted.getSessionMemoryEnabled(movedPath)).toBe(false);
    expect(restarted.getPermissionMode(movedPath)).toBe("operate");
    expect(restarted.getSessionThinkingLevel(movedPath)).toBe("high");
    expect(restarted.getSessionFolderScope(movedPath)).toMatchObject({
      workspaceFolders: [],
      authorizedFolders: [allowedFolder],
    });
  });
});
