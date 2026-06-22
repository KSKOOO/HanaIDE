import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertStudioMount } from "../core/studio-mounts.ts";

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x04, 0x00,
]);

function makeEngine(tmpDir, options: any = {}) {
  const disabled = Array.isArray(options) ? options : (options.disabled || []);
  const agent = {
    id: "agent-1",
    name: "Hana",
    agentName: "Hana",
    config: { tools: { disabled } },
  };
  const emitEvent = vi.fn();
  const executeIsolated = options.executeIsolated || vi.fn(async () => ({ sessionPath: path.join(tmpDir, "agents", "agent-1", "activity", "s.jsonl") }));
  const activityStore = options.activityStore || {
    add: vi.fn((activity) => activity),
    update: vi.fn((id, patch) => ({ id, ...patch })),
  };
  const imageGenCtx = options.imageGenCtx ?? {
    config: { get: vi.fn(() => undefined) },
    _mediaGen: {
      registry: {
        getProtocol: vi.fn(() => null),
        get: vi.fn(() => null),
      },
    },
    bus: { request: vi.fn(async () => ({})) },
  };
  return {
    hanakoHome: path.join(tmpDir, "hana"),
    deskCwd: tmpDir,
    homeCwd: tmpDir,
    getRuntimeContext: () => ({
      serverId: "server_1",
      serverNodeId: "node_1",
      userId: "user_1",
      studioId: "studio_1",
      connectionKind: "local",
      credentialKind: "loopback_token",
    }),
    currentAgentId: agent.id,
    agent,
    agentsDir: path.join(tmpDir, "agents"),
    getAgent: () => agent,
    getPrimaryAgentId: () => options.primaryAgentId ?? agent.id,
    getActivityStore: () => activityStore,
    executeIsolated,
    pluginManager: {
      getAllTools: () => options.pluginTools ?? [{ _pluginId: "beautify", name: "beautify_create-cover" }],
      getPlugin: (id) => (id === "image-gen" ? { ctx: imageGenCtx, status: "loaded" } : null),
    },
    emitEvent,
    _test: { executeIsolated, activityStore, imageGenCtx },
  };
}

describe("desk beautify cover apply route", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cover-route-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies a user-selected local image through the same cover service", async () => {
    const notePath = path.join(tmpDir, "note.md");
    const imagePath = path.join(tmpDir, "cover.png");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");
    fs.writeFileSync(imagePath, PNG_HEADER);

    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const engine = makeEngine(tmpDir);
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/cover/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath, imageFilePath: imagePath }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cover.image).toMatch(/^文本附件\/note-cover-/);
    expect(fs.existsSync(path.join(tmpDir, ...body.cover.image.split("/")))).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
    expect(engine.emitEvent).toHaveBeenCalledWith({
      type: "app_event",
      event: {
        type: "markdown-cover-updated",
        payload: { filePath: notePath },
        source: "server",
      },
    }, null);
  });

  it("applies uploaded cover bytes to a server workbench Markdown target", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const engine = makeEngine(tmpDir);
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const target = { kind: "workbench-file", rootId: "default", subdir: "", name: "note.md" };
    const res = await app.request("/api/desk/beautify/cover/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target,
        image: {
          filename: "client-cover.png",
          contentBase64: PNG_HEADER.toString("base64"),
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.target).toMatchObject(target);
    expect(body.cover.image).toMatch(/^文本附件\/note-cover-/);
    expect(fs.existsSync(path.join(tmpDir, ...body.cover.image.split("/")))).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
    expect(engine.emitEvent).toHaveBeenCalledWith({
      type: "app_event",
      event: {
        type: "markdown-cover-updated",
        payload: { target: expect.objectContaining(target) },
        source: "server",
      },
    }, null);
  });

  it("applies uploaded cover bytes to a non-default workbench mount target", async () => {
    const mountRoot = path.join(tmpDir, "mounted");
    const defaultNotePath = path.join(tmpDir, "note.md");
    const mountedNotePath = path.join(mountRoot, "note.md");
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.writeFileSync(defaultNotePath, "# Default\n", "utf-8");
    fs.writeFileSync(mountedNotePath, "# Mounted\n", "utf-8");

    const engine = makeEngine(tmpDir);
    upsertStudioMount(engine.hanakoHome, {
      mountId: "mount_docs",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Mounted Docs",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });
    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const target = { kind: "workbench-file", mountId: "mount_docs", subdir: "", name: "note.md" };
    const res = await app.request("/api/desk/beautify/cover/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target,
        image: {
          filename: "client-cover.png",
          contentBase64: PNG_HEADER.toString("base64"),
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.target).toMatchObject(target);
    expect(fs.readFileSync(mountedNotePath, "utf-8")).toContain("cover:");
    expect(fs.readFileSync(defaultNotePath, "utf-8")).toBe("# Default\n");
  });

  it("allows direct UI local image apply when the Agent beautify tool is disabled", async () => {
    const notePath = path.join(tmpDir, "note.md");
    const imagePath = path.join(tmpDir, "cover.png");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");
    fs.writeFileSync(imagePath, PNG_HEADER);

    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir, ["beautify"]), null));

    const res = await app.request("/api/desk/beautify/cover/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath, imageFilePath: imagePath }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("applies a built-in cover gallery preset through a whitelist id", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { COVER_GALLERY_PRESETS } = await import("../shared/cover-gallery-presets.ts");
    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const engine = makeEngine(tmpDir);
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/cover/preset/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: notePath,
        presetId: COVER_GALLERY_PRESETS[0].id,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cover.image).toMatch(/^文本附件\/note-cover-/);
    expect(fs.existsSync(path.join(tmpDir, ...body.cover.image.split("/")))).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
    expect(engine.emitEvent).toHaveBeenCalledWith({
      type: "app_event",
      event: {
        type: "markdown-cover-updated",
        payload: { filePath: notePath },
        source: "server",
      },
    }, null);
  });

  it("applies a built-in cover gallery preset to a server workbench Markdown target", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { COVER_GALLERY_PRESETS } = await import("../shared/cover-gallery-presets.ts");
    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const engine = makeEngine(tmpDir);
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const target = { kind: "workbench-file", rootId: "default", subdir: "", name: "note.md" };
    const res = await app.request("/api/desk/beautify/cover/preset/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target,
        presetId: COVER_GALLERY_PRESETS[0].id,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.target).toMatchObject(target);
    expect(body.cover.image).toMatch(/^文本附件\/note-cover-/);
    expect(fs.existsSync(path.join(tmpDir, ...body.cover.image.split("/")))).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
  });

  it("allows built-in cover gallery preset apply when the Agent beautify tool is disabled", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { COVER_GALLERY_PRESETS } = await import("../shared/cover-gallery-presets.ts");
    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir, { disabled: ["beautify"] }), null));

    const res = await app.request("/api/desk/beautify/cover/preset/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: notePath,
        presetId: COVER_GALLERY_PRESETS[0].id,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("reports system cover availability separately from primary-Agent generation availability", async () => {
    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir, { disabled: ["beautify"] }), null));

    const res = await app.request("/api/desk/beautify/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      systemCover: { available: true },
      agentGenerate: {
        enabled: false,
        executorAgentId: "agent-1",
        disabledReason: "beautify-disabled",
      },
    });
  });

  it("rejects Agent cover generation before creating an activity when default image model is missing", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const engine = makeEngine(tmpDir);
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/cover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "default image model is not configured",
      reason: "default-image-model-missing",
    });
    expect(engine._test.activityStore.add).not.toHaveBeenCalled();
    expect(engine._test.executeIsolated).not.toHaveBeenCalled();
  });

  it("rejects Agent cover generation with a structured error when legacy image-gen runtime has no registry", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const imageGenCtx = {
      config: {
        get: vi.fn((key) => key === "defaultImageModel"
          ? { provider: "mock-provider", id: "mock-image" }
          : undefined),
      },
      _mediaGen: {},
      bus: { request: vi.fn(async () => ({})) },
    };
    const engine = makeEngine(tmpDir, { imageGenCtx });
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/cover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "image generation runtime is unavailable",
      reason: "image-generation-runtime-unavailable",
    });
    expect(engine._test.activityStore.add).not.toHaveBeenCalled();
    expect(engine._test.executeIsolated).not.toHaveBeenCalled();
  });

  it("aborts a hanging Agent cover generation and marks the activity timed out", async () => {
    vi.useFakeTimers();
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");
    let capturedSignal: AbortSignal | null = null;
    const activityStore = {
      add: vi.fn((activity) => activity),
      update: vi.fn((id, patch) => ({ id, ...patch })),
    };
    const executeIsolated = vi.fn((_prompt, opts) => {
      capturedSignal = opts.signal;
      return new Promise(() => {});
    });
    const imageGenCtx = {
      dataDir: path.join(tmpDir, "image-gen"),
      config: { get: vi.fn(() => ({ provider: "mock-provider", id: "mock-image" })) },
      _mediaGen: {
        registry: {
          getProtocol: vi.fn(() => ({ id: "mock-protocol" })),
          get: vi.fn(() => null),
        },
      },
      bus: {
        request: vi.fn(async (type) => {
          if (type === "provider:resolve-media-model") {
            return { providerId: "mock-provider", modelId: "mock-image", protocolId: "mock-protocol" };
          }
          return {};
        }),
      },
    };

    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const engine = makeEngine(tmpDir, { executeIsolated, activityStore, imageGenCtx });
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/cover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath }),
    });

    expect(res.status).toBe(200);
    expect(capturedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

    expect(capturedSignal?.aborted).toBe(true);
    expect(activityStore.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: "error",
        error: "timeout",
        summary: expect.stringContaining("超时"),
      }),
    );
    vi.useRealTimers();
  });

  it("rejects unknown built-in cover gallery preset ids", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir), null));

    const res = await app.request("/api/desk/beautify/cover/preset/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: notePath,
        presetId: "../private",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown cover gallery preset" });
  });
});
