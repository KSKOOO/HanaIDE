import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HanaEngine } from "../core/engine.ts";

describe("HanaEngine.buildTools", () => {
  let tmpDir;
  let engines: HanaEngine[] = [];

  afterEach(async () => {
    for (const engine of engines.splice(0).reverse()) {
      await engine.dispose();
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("throws when opts.agentDir points at an unknown agent instead of using focus tools", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-"));
    const focusAgentDir = path.join(tmpDir, "agents", "focus");
    const missingAgentDir = path.join(tmpDir, "agents", "missing");

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => null);
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir: focusAgentDir,
        tools: [{ name: "focus_custom_tool", execute: vi.fn() }],
      },
    };

    expect(() => engine.buildTools(tmpDir, undefined, {
      agentDir: missingAgentDir,
      workspace: tmpDir,
    })).toThrow(/agent "missing" not found/);
  });

  it("uses an explicit permission mode provider instead of the desktop session default", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const sessionPath = path.join(tmpDir, "sessions", "bridge.jsonl");
    const execute = vi.fn(async () => ({ details: { executed: true } }));
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-tool-1",
        promise: Promise.resolve({ action: "rejected" }),
      })),
    };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = confirmStore;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "ask");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { customTools } = engine.buildTools(tmpDir, [
      { name: "stage_files", execute },
    ], {
      agentDir,
      workspace: tmpDir,
      getPermissionMode: () => "operate",
    });

    const result = await customTools[0].execute(
      "call-1",
      { path: "x" },
      { sessionManager: { getSessionFile: () => sessionPath } },
    );

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("passes the engine approval gateway into auto-mode tool execution", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-auto-approval-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const sessionPath = path.join(tmpDir, "sessions", "auto.jsonl");
    const execute = vi.fn(async () => ({ details: { executed: true } }));
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "test-approved",
        risk: "low",
      })),
    };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._approvalGateway = approvalGateway;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "auto");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { customTools } = engine.buildTools(tmpDir, [
      { name: "stage_files", execute },
    ], {
      agentDir,
      workspace: tmpDir,
      getPermissionMode: () => "auto",
    });

    const result = await customTools[0].execute(
      "call-1",
      { path: "x" },
      { sessionManager: { getSessionFile: () => sessionPath } },
    );

    expect(approvalGateway.review).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "stage_files", sessionPath }),
      expect.any(Object),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("wires utility model reviewers into the default approval gateway", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-engine-approval-gateway-"));
    const engine = new HanaEngine({
      hanakoHome: tmpDir,
      productDir: tmpDir,
      agentId: "hana",
    } as any);
    engines.push(engine);
    engine.resolveUtilityConfig = vi.fn(() => ({
      utility: { id: "small-reviewer", provider: "test" },
      utility_large: { id: "large-reviewer", provider: "test" },
      api: "openai-completions",
      api_key: "small-key",
      base_url: "https://small.example.test",
      large_api: "openai-completions",
      large_api_key: "large-key",
      large_base_url: "https://large.example.test",
    }));
    engine._callApprovalReviewerText = vi.fn(async () => JSON.stringify({
      action: "allow",
      reason: "workspace edit is in scope",
      risk: "low",
    }));

    const decision = await engine._approvalGateway.review({
      id: "approval-1",
      kind: "tool_action",
      sessionPath: path.join(tmpDir, "sessions", "approval.jsonl"),
      agentId: "hana",
      toolName: "write",
      actionName: "execute",
      params: { path: "notes.md" },
      target: { type: "file", label: "notes.md", path: "notes.md" },
      blastRadius: "workspace",
      reversibility: "moderate",
    });

    expect(engine.resolveUtilityConfig).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "hana",
    }));
    expect(engine._callApprovalReviewerText).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: "small-reviewer", provider: "test" },
      apiKey: "small-key",
      baseUrl: "https://small.example.test",
    }));
    expect(decision).toMatchObject({
      action: "allow",
      reviewer: "small_tool_model",
      reason: "workspace edit is in scope",
    });
  });

  it("resolves utility config through the session owner when only sessionPath is known", () => {
    const sessionPath = "/tmp/agents/target/sessions/s1.jsonl";
    const engine = Object.create(HanaEngine.prototype);
    engine._agentMgr = { activeAgentId: "focus" };
    engine.agentIdFromSessionPath = vi.fn(() => "target");
    engine._configCoord = {
      resolveUtilityConfig: vi.fn(() => ({ utility: { id: "target-utility" } })),
    };
    engine._usageLedger = { id: "ledger" };
    engine.getSessionIdForPath = vi.fn(() => "sess_target_1");

    const result = engine.resolveUtilityConfig({ sessionPath });

    expect(engine.agentIdFromSessionPath).toHaveBeenCalledWith(sessionPath);
    expect(engine.getSessionIdForPath).toHaveBeenCalledWith(sessionPath);
    expect(engine._configCoord.resolveUtilityConfig).toHaveBeenCalledWith({
      sessionPath,
      agentId: "target",
    });
    expect(result).toMatchObject({
      utility: { id: "target-utility" },
      usageAgentId: "target",
      usageSessionPath: sessionPath,
      usageSessionId: "sess_target_1",
    });
  });

  it("hides stable availability-disabled tools before building the model schema", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-availability-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const agent = {
      id: "focus",
      agentDir,
      config: { tools: { disabled: ["browser"] } },
      tools: [],
    };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => agent);
    engine.isChannelsEnabled = vi.fn(() => false);
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent,
    };

    const { customTools } = engine.buildTools(tmpDir, [
      { name: "browser", execute: vi.fn() },
      { name: "channel", execute: vi.fn() },
      { name: "dm", execute: vi.fn() },
      { name: "automation", execute: vi.fn() },
    ], {
      agentDir,
      workspace: tmpDir,
      getPermissionMode: () => "operate",
    });

    expect(customTools.map((tool) => tool.name)).toEqual(["automation"]);
  });

  it("passes a session workbench execution boundary into plugin tools", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-boundary-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const sessionPath = path.join(agentDir, "sessions", "main.jsonl");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const agent = {
      id: "focus",
      agentDir,
      config: {},
      tools: [],
    };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine._runtimeContext = {
      serverId: "server_engine",
      serverNodeId: "node_engine",
      studioId: "studio_engine",
    };
    engine.getAgent = vi.fn(() => agent);
    engine._pluginManager = {
      getAllTools: () => [{
        name: "plugin_tool",
        execute,
      }],
    };
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = { agent };

    const { customTools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => sessionPath,
      getPermissionMode: () => "operate",
    });
    const pluginTool = customTools.find((tool) => tool.name === "plugin_tool");

    await pluginTool.execute("call-1", { ok: true }, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { ok: true },
      expect.objectContaining({
        sessionManager: expect.any(Object),
      }),
      undefined,
      expect.objectContaining({
        agentId: "focus",
        serverNodeId: "node_engine",
        sessionPath,
        executionBoundary: expect.objectContaining({
          boundaryId: "execb_node_engine_studio_engine",
          serverNodeId: "node_engine",
          studioId: "studio_engine",
          workbench: {
            kind: "legacy_agent_workbench",
            root: workspace,
          },
        }),
      }),
    );
  });

  it("passes the explicit buildTools session path into plugin tool runtime context", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-plugin-session-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const bridgeSessionPath = path.join(agentDir, "sessions", "bridge", "owner", "chat.jsonl");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const agent = {
      id: "focus",
      agentDir,
      config: {},
      tools: [],
    };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine._runtimeContext = {
      serverId: "server_engine",
      serverNodeId: "node_engine",
      studioId: "studio_engine",
    };
    engine.getAgent = vi.fn(() => agent);
    engine._pluginManager = {
      getAllTools: () => [{
        name: "plugin_tool",
        execute,
      }],
    };
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = { agent };

    const { customTools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => bridgeSessionPath,
      getPermissionMode: () => "operate",
    });
    const pluginTool = customTools.find((tool) => tool.name === "plugin_tool");

    await pluginTool.execute("call-1", { ok: true }, {});

    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { ok: true },
      {},
      undefined,
      expect.objectContaining({
        sessionPath: bridgeSessionPath,
      }),
    );
  });

  it("passes Pi SDK fifth-argument session ctx into plugin tools", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-plugin-pi-ctx-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const desktopSessionPath = path.join(agentDir, "sessions", "desktop.jsonl");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const agent = {
      id: "focus",
      agentDir,
      config: {},
      tools: [],
    };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine._runtimeContext = {
      serverId: "server_engine",
      serverNodeId: "node_engine",
      studioId: "studio_engine",
    };
    engine.getAgent = vi.fn(() => agent);
    engine._pluginManager = {
      getAllTools: () => [{
        name: "plugin_tool",
        execute,
      }],
    };
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = { agent };

    const { customTools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getPermissionMode: () => "operate",
    });
    const pluginTool = customTools.find((tool) => tool.name === "plugin_tool");
    const signal = new AbortController().signal;
    const onUpdate = vi.fn();

    await pluginTool.execute("call-1", { ok: true }, signal, onUpdate, {
      sessionManager: { getSessionFile: () => desktopSessionPath },
    });

    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { ok: true },
      signal,
      onUpdate,
      expect.objectContaining({
        sessionPath: desktopSessionPath,
      }),
    );
  });

  it("registers files created or modified by write and edit tools in the active session", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-touch-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const sessionPath = path.join(agentDir, "sessions", "touch.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");

    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, operation }) => ({
      id: `sf_${operation}`,
      sessionPath,
      filePath,
      label,
      origin,
      operation,
    }));
    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.registerSessionFile = registerSessionFile;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: false });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { tools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => sessionPath,
    });
    const write = tools.find(tool => tool.name === "write");
    const edit = tools.find(tool => tool.name === "edit");

    const writeResult = await write.execute("write-1", { path: "draft.md", content: "hello\n" });
    const editResult = await edit.execute("edit-1", {
      path: "draft.md",
      edits: [{ oldText: "hello", newText: "hello Hana" }],
    });

    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath,
      filePath: path.join(workspace, "draft.md"),
      label: "draft.md",
      origin: "agent_write",
      operation: "created",
    }));
    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath,
      filePath: path.join(workspace, "draft.md"),
      label: "draft.md",
      origin: "agent_edit",
      operation: "modified",
    }));
    expect(writeResult.details.sessionFile).toMatchObject({
      id: "sf_created",
      filePath: path.join(workspace, "draft.md"),
      origin: "agent_write",
    });
    expect(editResult.details.sessionFile).toMatchObject({
      id: "sf_modified",
      filePath: path.join(workspace, "draft.md"),
      origin: "agent_edit",
    });
    expect(engine._emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "app_event",
      event: expect.objectContaining({
        type: "session-file-updated",
        payload: expect.objectContaining({
          sessionPath,
          filePath: path.join(workspace, "draft.md"),
          fileId: "sf_created",
          origin: "agent_write",
          operation: "created",
        }),
      }),
    }), null);
    expect(engine._emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "app_event",
      event: expect.objectContaining({
        type: "session-file-updated",
        payload: expect.objectContaining({
          sessionPath,
          filePath: path.join(workspace, "draft.md"),
          fileId: "sf_modified",
          origin: "agent_edit",
          operation: "modified",
        }),
      }),
    }), null);
  });

  it("registers write and edit session files when Pi SDK uses the file_path alias", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-file-path-alias-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const sessionPath = path.join(agentDir, "sessions", "touch-alias.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");

    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, operation }) => ({
      id: `sf_${operation}`,
      sessionPath,
      filePath,
      label,
      origin,
      operation,
    }));
    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.registerSessionFile = registerSessionFile;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: false });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { tools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => sessionPath,
    });
    const write = tools.find(tool => tool.name === "write");
    const edit = tools.find(tool => tool.name === "edit");

    const writeResult = await write.execute("write-1", { file_path: "alias.md", content: "hello\n" });
    const editResult = await edit.execute("edit-1", {
      file_path: "alias.md",
      edits: [{ oldText: "hello", newText: "hello Hana" }],
    });

    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath,
      filePath: path.join(workspace, "alias.md"),
      label: "alias.md",
      origin: "agent_write",
      operation: "created",
    }));
    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath,
      filePath: path.join(workspace, "alias.md"),
      label: "alias.md",
      origin: "agent_edit",
      operation: "modified",
    }));
    expect(writeResult.details.sessionFile).toMatchObject({
      id: "sf_created",
      filePath: path.join(workspace, "alias.md"),
      origin: "agent_write",
    });
    expect(editResult.details.sessionFile).toMatchObject({
      id: "sf_modified",
      filePath: path.join(workspace, "alias.md"),
      origin: "agent_edit",
    });
  });

  it("lets built-in file tools pick up newly authorized session folders without rebuilding tools", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-authorized-folders-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const authorized = path.join(tmpDir, "authorized");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(authorized, { recursive: true });
    const hanakoHome = path.join(tmpDir, "hanako-home");
    fs.mkdirSync(hanakoHome, { recursive: true });
    let authorizedFolders = [];

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = hanakoHome;
    engine.registerSessionFile = vi.fn((entry) => ({
      id: "sf-authorized",
      ...entry,
    }));
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { tools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getAuthorizedFolders: () => authorizedFolders,
      getSessionPath: () => path.join(agentDir, "sessions", "authorized.jsonl"),
      getPermissionMode: () => "operate",
    });
    const write = tools.find(tool => tool.name === "write");
    const targetPath = path.join(authorized, "note.md");

    const blocked = await write.execute("write-blocked", {
      path: targetPath,
      content: "before\n",
    });
    expect(blocked.content[0].text).toContain(targetPath);
    expect(fs.existsSync(targetPath)).toBe(false);

    authorizedFolders = [authorized];
    const allowed = await write.execute("write-allowed", {
      path: targetPath,
      content: "after\n",
    });

    expect(fs.readFileSync(targetPath, "utf-8")).toBe("after\n");
    expect(allowed.details.sessionFile).toMatchObject({
      id: "sf-authorized",
      filePath: targetPath,
      origin: "agent_write",
    });
  });

  it("blocks direct agent config edits from built-in file tools even when sandbox is disabled", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-managed-config-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const configPath = path.join(agentDir, "config.yaml");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(configPath, "agent:\n  name: Hana\n  yuan: hanako\n", "utf-8");

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.registerSessionFile = vi.fn();
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: false });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { tools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
    });
    const write = tools.find(tool => tool.name === "write");
    const edit = tools.find(tool => tool.name === "edit");

    const writeResult = await write.execute("write-config", {
      path: configPath,
      content: "agent:\n  name: Hana\n  yuan: caikangyong\n",
    });
    const editResult = await edit.execute("edit-config", {
      path: configPath,
      edits: [{ oldText: "yuan: hanako", newText: "yuan: caikangyong" }],
    });

    expect(writeResult.content[0].text).toContain("managed");
    expect(editResult.content[0].text).toContain("managed");
    expect(fs.readFileSync(configPath, "utf-8")).toContain("yuan: hanako");
    expect(engine.registerSessionFile).not.toHaveBeenCalled();
  });

  it("keeps plugin dev Agent tools hidden until the global dev setting is enabled", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-dev-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._pluginDevService = { getDiagnostics: vi.fn() };
    engine._prefs = {
      getFileBackup: () => ({ enabled: false }),
      getPluginDevToolsEnabled: () => false,
    };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { customTools } = engine.buildTools(tmpDir, [], {
      agentDir,
      workspace: tmpDir,
      getPermissionMode: () => "operate",
    });

    expect(customTools.some((tool) => tool.name.startsWith("plugin_dev_"))).toBe(false);
  });

  it("adds plugin dev Agent tools when the user enables the dev setting", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-dev-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._pluginDevService = {
      installFromSource: vi.fn(),
      reloadPlugin: vi.fn(),
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(),
      resetPlugin: vi.fn(),
      uninstallPlugin: vi.fn(),
      invokeTool: vi.fn(),
      getDiagnostics: vi.fn(),
      listSurfaces: vi.fn(),
      describeSurfaceDebug: vi.fn(),
      runScenario: vi.fn(),
    };
    engine._prefs = {
      getFileBackup: () => ({ enabled: false }),
      getPluginDevToolsEnabled: () => true,
    };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { customTools } = engine.buildTools(tmpDir, [], {
      agentDir,
      workspace: tmpDir,
      getPermissionMode: () => "operate",
    });

    expect(customTools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "plugin_dev_install",
      "plugin_dev_reload",
      "plugin_dev_uninstall",
      "plugin_dev_invoke_tool",
      "plugin_dev_run_scenario",
    ]));
  });
});
