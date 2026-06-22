/**
 * memory-ticker 编排 + 健康状态 综合测试
 *
 * 合并自 memory-ticker-daily.test.ts 与 memory-ticker-health.test.ts
 *
 * _doDaily 步骤编排（关键路径）：
 * - 5 个步骤各自独立 try-catch
 * - compileLongterm 依赖 compileWeek（compileWeek 失败则跳过）
 * - 断点续跑：已完成步骤在重试时跳过
 * - assemble 总是执行（step 4）
 *
 * getHealthStatus API：
 * - 验证每步（rollingSummary / compileToday / compileWeek / compileLongterm /
 *   compileFacts / deepMemory）的成功/失败都记录在 _health，并通过
 *   getHealthStatus() 暴露，供 UI 层判断"记忆编译是否在静默失败"。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

// ── Mock compile / deep-memory / debug ──

vi.mock("../lib/memory/compile.js", () => ({
  compileToday: vi.fn().mockResolvedValue("compiled"),
  compileWeek: vi.fn().mockResolvedValue("compiled"),
  compileLongterm: vi.fn().mockResolvedValue("compiled"),
  compileFacts: vi.fn().mockResolvedValue("compiled"),
  assemble: vi.fn(),
}));

vi.mock("../lib/memory/deep-memory.js", () => ({
  processDirtySessions: vi.fn().mockResolvedValue({ processed: 0, factsAdded: 0 }),
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ── Import under test ──

import { createMemoryTicker } from "../lib/memory/memory-ticker.ts";
import {
  compileToday,
  compileWeek,
  compileLongterm,
  compileFacts,
  assemble,
} from "../lib/memory/compile.ts";
import { processDirtySessions } from "../lib/memory/deep-memory.ts";

// ── Helpers ──

function writeSession(sessionPath: any) {
  const lines = [
    { type: "message", timestamp: "2026-04-17T10:00:00.000Z", message: { role: "user", content: "hi" } },
    { type: "message", timestamp: "2026-04-17T10:00:10.000Z", message: { role: "assistant", content: "hello" } },
  ];
  fs.writeFileSync(sessionPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function makeTicker(tmpDir: any, summaryManagerOverride?: any) {
  fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
  const summaryManager = summaryManagerOverride || {
    rollingSummary: vi.fn().mockResolvedValue("summary"),
    getSummary: vi.fn().mockReturnValue(null),
    listSummaries: vi.fn().mockReturnValue([]),
  };
  return createMemoryTicker({
    summaryManager,
    configPath: path.join(tmpDir, "config.yaml"),
    factStore: {},
    getResolvedMemoryModel: () => ({ model: "test-model", provider: "test", api: "openai-completions", api_key: "test-key", base_url: "http://localhost:1234" }),
    onCompiled: vi.fn(),
    sessionDir: path.join(tmpDir, "sessions"),
    memoryMdPath: path.join(tmpDir, "memory.md"),
    todayMdPath: path.join(tmpDir, "today.md"),
    weekMdPath: path.join(tmpDir, "week.md"),
    longtermMdPath: path.join(tmpDir, "longterm.md"),
    factsMdPath: path.join(tmpDir, "facts.md"),
  });
}

// ── _doDaily step orchestration ──

describe("_doDaily step orchestration", () => {
  let tmpDir;
  let ticker;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-test-"));
    ticker = makeTicker(tmpDir);
  });

  afterEach(() => {
    ticker.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs all 5 steps when everything succeeds", async () => {
    await ticker.tick();

    expect(compileWeek).toHaveBeenCalledOnce();
    expect(compileLongterm).toHaveBeenCalledOnce();
    expect(compileFacts).toHaveBeenCalledOnce();
    expect(processDirtySessions).toHaveBeenCalledOnce();
    // daily step 0 + final compileTodayAndAssemble
    expect(compileToday).toHaveBeenCalledTimes(2);
    // assemble: once in _doDaily(step 4) + once in _doCompileTodayAndAssemble
    expect(assemble).toHaveBeenCalledTimes(2);
  });

  it("skips compileLongterm when compileWeek fails (dependency)", async () => {
    (compileWeek as any).mockRejectedValueOnce(new Error("LLM timeout"));

    await ticker.tick();

    expect(compileWeek).toHaveBeenCalledOnce();
    expect(compileLongterm).not.toHaveBeenCalled();
    // independent steps still run
    expect(compileFacts).toHaveBeenCalledOnce();
    expect(processDirtySessions).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalled();
  });

  it("retries only failed steps on second tick (checkpoint resume)", async () => {
    // First tick: compileWeek fails
    (compileWeek as any).mockRejectedValueOnce(new Error("network error"));
    await ticker.tick();

    vi.clearAllMocks();

    // Second tick: compileWeek should retry + compileLongterm should run
    await ticker.tick();

    expect(compileWeek).toHaveBeenCalledOnce();
    expect(compileLongterm).toHaveBeenCalledOnce();
    // Already completed in first tick — should be skipped
    expect(compileFacts).not.toHaveBeenCalled();
    expect(processDirtySessions).not.toHaveBeenCalled();
  });

  it("does not re-run _doDaily after full success", async () => {
    await ticker.tick();
    vi.clearAllMocks();

    // Second tick: _lastDailyJobDate already set → _doDaily skipped
    await ticker.tick();

    expect(compileWeek).not.toHaveBeenCalled();
    expect(compileLongterm).not.toHaveBeenCalled();
    expect(compileFacts).not.toHaveBeenCalled();
    expect(processDirtySessions).not.toHaveBeenCalled();
    // _doCompileTodayAndAssemble always runs regardless
    expect(compileToday).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalledOnce();
  });

  it("compileFacts failure does not block other steps", async () => {
    (compileFacts as any).mockRejectedValueOnce(new Error("facts error"));

    await ticker.tick();

    expect(compileWeek).toHaveBeenCalledOnce();
    expect(compileLongterm).toHaveBeenCalledOnce();
    expect(processDirtySessions).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalled();
  });

  it("deepMemory failure retries on next tick", async () => {
    (processDirtySessions as any).mockRejectedValueOnce(new Error("db locked"));
    await ticker.tick();

    vi.clearAllMocks();
    await ticker.tick();

    // Only deepMemory should retry
    expect(compileWeek).not.toHaveBeenCalled();
    expect(compileLongterm).not.toHaveBeenCalled();
    expect(compileFacts).not.toHaveBeenCalled();
    expect(processDirtySessions).toHaveBeenCalledOnce();
  });

  it("multiple failures: both compileWeek and compileFacts retry together", async () => {
    (compileWeek as any).mockRejectedValueOnce(new Error("fail1"));
    (compileFacts as any).mockRejectedValueOnce(new Error("fail2"));
    await ticker.tick();

    vi.clearAllMocks();
    await ticker.tick();

    // Both should retry
    expect(compileWeek).toHaveBeenCalledOnce();
    expect(compileFacts).toHaveBeenCalledOnce();
    // compileLongterm depends on compileWeek — should now run
    expect(compileLongterm).toHaveBeenCalledOnce();
    // deepMemory already succeeded — skipped
    expect(processDirtySessions).not.toHaveBeenCalled();
  });

  it("assemble runs even when all LLM steps fail", async () => {
    (compileWeek as any).mockRejectedValueOnce(new Error("fail"));
    (compileFacts as any).mockRejectedValueOnce(new Error("fail"));
    (processDirtySessions as any).mockRejectedValueOnce(new Error("fail"));

    await ticker.tick();

    // assemble (step 4) always executes
    expect(assemble).toHaveBeenCalled();
  });
});

// ── getHealthStatus API ──

describe("memory-ticker getHealthStatus", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-health-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exposes initial health status with all null fields", () => {
    const ticker = makeTicker(tmpDir);
    const h: any = ticker.getHealthStatus();

    for (const key of ["rollingSummary", "compileToday", "compileWeek", "compileLongterm", "compileFacts", "deepMemory"]) {
      expect(h[key]).toEqual({
        lastSuccessAt: null,
        lastErrorAt: null,
        lastErrorMsg: null,
        failCount: 0,
      });
    }
  });

  it("records lastSuccessAt for each step after a successful tick", async () => {
    const ticker = makeTicker(tmpDir);
    await ticker.tick();

    const h: any = ticker.getHealthStatus();
    expect(h.compileToday.lastSuccessAt).not.toBeNull();
    expect(h.compileWeek.lastSuccessAt).not.toBeNull();
    expect(h.compileLongterm.lastSuccessAt).not.toBeNull();
    expect(h.compileFacts.lastSuccessAt).not.toBeNull();
    expect(h.deepMemory.lastSuccessAt).not.toBeNull();
    // 所有步骤都应无错误
    for (const key of ["compileToday", "compileWeek", "compileLongterm", "compileFacts", "deepMemory"]) {
      expect(h[key].lastErrorMsg).toBeNull();
      expect(h[key].failCount).toBe(0);
    }
  });

  it("records lastErrorMsg + increments failCount on step failure", async () => {
    (compileFacts as any).mockRejectedValueOnce(new Error("boom"));
    const ticker = makeTicker(tmpDir);
    await ticker.tick();

    const h: any = ticker.getHealthStatus();
    expect(h.compileFacts.lastErrorMsg).toBe("boom");
    expect(h.compileFacts.lastErrorAt).not.toBeNull();
    expect(h.compileFacts.failCount).toBe(1);
    // 其他步骤不受影响
    expect(h.compileWeek.failCount).toBe(0);
    expect(h.compileToday.failCount).toBe(0);
  });

  it("clears error state once a failing step recovers", async () => {
    (compileFacts as any).mockRejectedValueOnce(new Error("boom1"));
    const ticker = makeTicker(tmpDir);
    await ticker.tick();
    expect((ticker.getHealthStatus() as any).compileFacts.failCount).toBe(1);

    // 第二次 tick：compileFacts 成功（mock 默认返回）
    await ticker.tick();

    const h: any = ticker.getHealthStatus();
    expect(h.compileFacts.lastErrorMsg).toBeNull();
    expect(h.compileFacts.lastErrorAt).toBeNull();
    expect(h.compileFacts.failCount).toBe(0);
    expect(h.compileFacts.lastSuccessAt).not.toBeNull();
  });

  it("increments failCount on consecutive failures", async () => {
    (compileFacts as any).mockRejectedValue(new Error("persistent"));
    const ticker = makeTicker(tmpDir);

    await ticker.tick();
    await ticker.tick();
    await ticker.tick();

    const h: any = ticker.getHealthStatus();
    expect(h.compileFacts.failCount).toBeGreaterThanOrEqual(2);
    expect(h.compileFacts.lastErrorMsg).toBe("persistent");
  });

  it("tracks rollingSummary failure only on the tenth notifyTurn", async () => {
    const rollingSummary = vi.fn().mockRejectedValue(new Error("llm down"));
    const ticker = makeTicker(tmpDir, {
      rollingSummary,
      getSummary: vi.fn().mockReturnValue(null),
    });

    const sessionPath = path.join(tmpDir, "sessions", "s1.jsonl");
    writeSession(sessionPath);

    for (let i = 0; i < 9; i++) ticker.notifyTurn(sessionPath);
    await new Promise((r) => setTimeout(r, 50));
    expect(rollingSummary).not.toHaveBeenCalled();

    ticker.notifyTurn(sessionPath);
    await new Promise((r) => setTimeout(r, 50));

    const h: any = ticker.getHealthStatus();
    expect(h.rollingSummary.lastErrorMsg).toBe("llm down");
    expect(h.rollingSummary.failCount).toBeGreaterThanOrEqual(1);
  });

  it("returns a deep copy that cannot mutate internal state", () => {
    const ticker = makeTicker(tmpDir);
    const h1: any = ticker.getHealthStatus();
    h1.compileToday.failCount = 999;
    const h2: any = ticker.getHealthStatus();
    expect(h2.compileToday.failCount).toBe(0);
  });
});
