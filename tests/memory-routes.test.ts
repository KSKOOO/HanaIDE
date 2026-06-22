import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigRoute } from "../server/routes/config.ts";

function makeAgent(tmpDir, overrides: any = {}) {
  const agentDir = path.join(tmpDir, "agents", "hana");
  const memoryDir = path.join(agentDir, "memory");
  const summariesDir = path.join(memoryDir, "summaries");
  fs.mkdirSync(summariesDir, { recursive: true });

  for (const name of ["memory.md", "today.md", "week.md", "longterm.md", "facts.md"]) {
    fs.writeFileSync(path.join(memoryDir, name), "old compiled content", "utf-8");
    fs.writeFileSync(path.join(memoryDir, `${name}.fingerprint`), "old-fp", "utf-8");
  }
  fs.writeFileSync(path.join(summariesDir, "old-session.json"), "{}", "utf-8");
  fs.writeFileSync(path.join(summariesDir, "keep.tmp"), "not a summary", "utf-8");

  return {
    id: "hana",
    agentDir,
    memoryMdPath: path.join(memoryDir, "memory.md"),
    summariesDir,
    summaryManager: { clearCache: vi.fn() },
    factStore: {
      exportAll: vi.fn(() => []),
      clearAll: vi.fn(),
    },
    ...overrides,
  };
}

function makeEngine(agent, tmpDir) {
  return {
    config: {},
    configPath: path.join(tmpDir, "config.yaml"),
    currentAgentId: agent.id,
    agentsDir: path.join(tmpDir, "agents"),
    preferences: {
      getExperimentValue: vi.fn((_: string) => undefined),
    },
    getAgent: vi.fn((id) => (id === agent.id ? agent : null)),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  };
}

function mountConfigRoute(engine) {
  const app = new Hono();
  app.route("/api", createConfigRoute(engine));
  return app;
}

function expectCompiledMemoryCleared(agent) {
  const memoryDir = path.dirname(agent.memoryMdPath);
  for (const name of ["memory.md", "today.md", "week.md", "longterm.md", "facts.md"]) {
    expect(fs.readFileSync(path.join(memoryDir, name), "utf-8")).toBe("");
    expect(fs.existsSync(path.join(memoryDir, `${name}.fingerprint`))).toBe(false);
  }
  const marker = JSON.parse(fs.readFileSync(path.join(memoryDir, "reset.json"), "utf-8"));
  expect(Date.parse(marker.compiledResetAt)).not.toBeNaN();
  expect(fs.existsSync(path.join(agent.summariesDir, "old-session.json"))).toBe(false);
  expect(fs.existsSync(path.join(agent.summariesDir, "keep.tmp"))).toBe(true);
  expect(agent.summaryManager.clearCache).toHaveBeenCalledOnce();
}

describe("memory routes", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-routes-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("clears compiled memory sources and writes a reset watermark", async () => {
    const agent = makeAgent(tmpDir);
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled?agentId=hana", { method: "DELETE" });

    expect(res.status).toBe(200);
    expectCompiledMemoryCleared(agent);
    expect(agent.factStore.clearAll).not.toHaveBeenCalled();
    expect(engine.updateConfig).toHaveBeenCalledWith({}, { agentId: "hana" });
  });

  it("clears facts, compiled memory sources, and writes a reset watermark", async () => {
    const agent = makeAgent(tmpDir);
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories?agentId=hana", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(agent.factStore.clearAll).toHaveBeenCalledOnce();
    expectCompiledMemoryCleared(agent);
    expect(engine.updateConfig).toHaveBeenCalledWith({}, { agentId: "hana" });
  });

  it("requires an explicit agentId for memory delete operations", async () => {
    const agent = makeAgent(tmpDir);
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled", { method: "DELETE" });
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toContain("missing agentId");
    expect(agent.summaryManager.clearCache).not.toHaveBeenCalled();
    expect(agent.factStore.clearAll).not.toHaveBeenCalled();
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });

  it("reports memory health for an explicit agent", async () => {
    const health = {
      rollingSummary: { lastSuccessAt: "2026-06-01T10:00:00.000Z", lastErrorAt: null, lastErrorMsg: null, failCount: 0 },
      compileToday: { lastSuccessAt: "2026-06-01T10:05:00.000Z", lastErrorAt: null, lastErrorMsg: null, failCount: 0 },
      compileWeek: { lastSuccessAt: null, lastErrorAt: null, lastErrorMsg: null, failCount: 0 },
      compileLongterm: { lastSuccessAt: null, lastErrorAt: null, lastErrorMsg: null, failCount: 0 },
      compileFacts: { lastSuccessAt: null, lastErrorAt: null, lastErrorMsg: null, failCount: 0 },
      deepMemory: { lastSuccessAt: null, lastErrorAt: "2026-06-01T10:10:00.000Z", lastErrorMsg: "LLM timeout", failCount: 2 },
    };
    const memoryTicker = { getHealthStatus: vi.fn(() => health) };
    const agent = makeAgent(tmpDir, { memoryTicker });
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/health?agentId=hana");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(memoryTicker.getHealthStatus).toHaveBeenCalledOnce();
    expect(data).toMatchObject({
      agentId: "hana",
      status: "degraded",
      reason: null,
      failedSteps: ["deepMemory"],
      maxFailCount: 2,
      lastSuccessAt: "2026-06-01T10:05:00.000Z",
      lastErrorAt: "2026-06-01T10:10:00.000Z",
      steps: {
        deepMemory: health.deepMemory,
      },
    });
  });

  it("requires an explicit agentId for memory health", async () => {
    const agent = makeAgent(tmpDir, {
      memoryTicker: { getHealthStatus: vi.fn(() => ({})) },
    });
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/health");
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toContain("missing agentId");
    expect(agent.memoryTicker.getHealthStatus).not.toHaveBeenCalled();
  });

  it("returns compiled memory sections with editable facts when the experiment is enabled", async () => {
    const agent = makeAgent(tmpDir);
    const memoryDir = path.dirname(agent.memoryMdPath);
    fs.writeFileSync(path.join(memoryDir, "facts.md"), "legacy facts", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "editable-facts.md"), "editable facts", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "today.md"), "today part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "week.md"), "week part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "longterm.md"), "longterm part", "utf-8");
    const engine = makeEngine(agent, tmpDir);
    engine.preferences.getExperimentValue = vi.fn((id) => (
      id === "memory.editable_facts" ? true : undefined
    ));
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled?agentId=hana");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.editableFactsEnabled).toBe(true);
    expect(data.sections).toMatchObject({
      facts: "editable facts",
      today: "today part",
      week: "week part",
      longterm: "longterm part",
    });
    expect(data.content).toContain("## 重要事实\n\neditable facts");
  });

  it("saves editable facts and rebuilds compiled memory when the experiment is enabled", async () => {
    const agent = makeAgent(tmpDir);
    const memoryDir = path.dirname(agent.memoryMdPath);
    fs.writeFileSync(path.join(memoryDir, "facts.md"), "legacy facts", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "today.md"), "today part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "week.md"), "week part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "longterm.md"), "longterm part", "utf-8");
    const engine = makeEngine(agent, tmpDir);
    engine.preferences.getExperimentValue = vi.fn((id) => (
      id === "memory.editable_facts" ? true : undefined
    ));
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled/facts?agentId=hana", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facts: "edited facts" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(fs.readFileSync(path.join(memoryDir, "editable-facts.md"), "utf-8")).toBe("edited facts\n");
    expect(fs.readFileSync(path.join(memoryDir, "facts.md"), "utf-8")).toBe("legacy facts");
    const memoryMd = fs.readFileSync(agent.memoryMdPath, "utf-8");
    expect(memoryMd).toContain("## 重要事实\n\nedited facts");
    expect(memoryMd).toContain("## 今天\n\ntoday part");
    expect(engine.updateConfig).toHaveBeenCalledWith({}, { agentId: "hana" });
  });
});
