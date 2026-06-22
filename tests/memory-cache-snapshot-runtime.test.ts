import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

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

import { createMemoryTicker } from "../lib/memory/memory-ticker.ts";
import { readCacheSnapshotObservation } from "../lib/memory/cache-snapshot-observation.ts";
import { buildSessionCacheSnapshot } from "../core/session-cache-snapshot.ts";
import { createUsageLedger } from "../lib/llm/usage-ledger.ts";

function writeSession(sessionPath) {
  const lines = [
    {
      type: "message",
      timestamp: "2026-06-03T10:00:00.000Z",
      message: { role: "user", content: "我想把 rolling summary 接上缓存快照。" },
    },
    {
      type: "message",
      timestamp: "2026-06-03T10:01:00.000Z",
      message: { role: "assistant", content: "我们可以先做 shadow，再切 write。" },
    },
  ];
  fs.writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
}

function makeTicker(tmpDir, mode, summaryManager, memoryReflectionRunner, overrides: Record<string, any> = {}) {
  const agentDir = path.join(tmpDir, "agents", "hana");
  const sessionDir = path.join(agentDir, "sessions");
  const memoryDir = path.join(agentDir, "memory");
  const requestModel = {
    id: "memory-model",
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: "http://localhost:1234",
    quirks: ["enable_thinking"],
    reasoning: true,
  };
  const usageLedger = overrides.usageLedger || { marker: "usage-ledger" };
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "memory.md"), "# Memory\n\n现有正式记忆。\n", "utf-8");

  const ticker = createMemoryTicker({
    agentId: "hana",
    agentDir,
    summaryManager,
    configPath: path.join(agentDir, "config.yaml"),
    factStore: {},
    getResolvedMemoryModel: () => ({
      model: "memory-model",
      provider: "deepseek",
      api: "openai-completions",
      api_key: "test-key",
      base_url: "http://localhost:1234",
      usageLedger,
    }),
    getMemoryMasterEnabled: () => true,
    isSessionMemoryEnabled: () => true,
    getCacheSnapshotReflectionMode: () => mode,
    memoryReflectionRunner,
    buildSessionCacheSnapshot: overrides.buildSessionCacheSnapshot || vi.fn((sessionPath, { reason, messages }) => ({
      strategy: "session_snapshot",
      strict: true,
      sessionPath,
      reason,
      model: {
        id: "memory-model",
        provider: "deepseek",
        api: "openai-completions",
        baseUrl: "http://localhost:1234",
      },
      requestModel,
      cachePrefixHash: "a".repeat(64),
      parentCachePrefixHash: "",
      cacheKeyParams: { thinkingLevel: "medium" },
      tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      messages,
      messageCount: messages.length,
    })),
    ensureSessionLoaded: overrides.ensureSessionLoaded,
    getSessionStreamFn: overrides.getSessionStreamFn || vi.fn(() => vi.fn()),
    sessionDir,
    memoryDir,
    memoryMdPath: path.join(memoryDir, "memory.md"),
    todayMdPath: path.join(memoryDir, "today.md"),
    weekMdPath: path.join(memoryDir, "week.md"),
    longtermMdPath: path.join(memoryDir, "longterm.md"),
    factsMdPath: path.join(memoryDir, "facts.md"),
  });

  return { ticker, agentDir, requestModel, sessionPath: path.join(sessionDir, "2026-06-03T10-00-00-000Z_cache.jsonl"), usageLedger };
}

describe("cache snapshot reflection runtime", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cache-snapshot-runtime-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shadow mode keeps the official rolling summary path and writes only an observation artifact", async () => {
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("official summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockResolvedValue({
        summary: "shadow summary",
        changed: true,
        data: { summary: "shadow summary" },
        usage: {
          input: { uncachedTokens: 3 },
          cache: { readTokens: 997, missTokens: 3 },
        },
        metadata: {
          cacheStrategy: "session_snapshot",
          strict: true,
          cachePrefixHash: "b".repeat(64),
          parentCachePrefixHash: "a".repeat(64),
        },
      }),
    };
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "shadow", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(summaryManager.createRollingSummaryDraft).not.toHaveBeenCalled();
    expect(memoryReflectionRunner.runMemoryReflection).toHaveBeenCalledOnce();
    expect(summaryManager.saveSummary).not.toHaveBeenCalled();

    const observation = readCacheSnapshotObservation(agentDir);
    expect(observation).toMatchObject({
      agentId: "hana",
      sessionPath,
      mode: "shadow",
      status: "success",
      cacheStrategy: "session_snapshot",
      strict: true,
      summaryPreview: "shadow summary",
    });
    expect(observation.usage.cachedTokens).toBe(997);
    expect(observation.memoryMdPreview).toContain("现有正式记忆");
  });

  it("write mode saves the cache snapshot draft as the official rolling summary", async () => {
    const sessionId = "2026-06-03T10-00-00-000Z_cache";
    const writeSummary = "### 重要事实\n- 无\n\n### 事情经过\n- [2026-06-03 10:01] 用户在调缓存快照。";
    const summaryData = {
      session_id: sessionId,
      created_at: "2026-06-03T10:02:00.000Z",
      updated_at: "2026-06-03T10:02:00.000Z",
      summary: writeSummary,
      messageCount: 2,
    };
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("legacy summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockResolvedValue({
        summary: writeSummary,
        changed: true,
        data: summaryData,
        usage: { cache: { readTokens: 1200, missTokens: 4 } },
        metadata: {
          cacheStrategy: "session_snapshot",
          strict: true,
          cachePrefixHash: "b".repeat(64),
          parentCachePrefixHash: "a".repeat(64),
        },
      }),
    };
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "write", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(summaryManager.createRollingSummaryDraft).not.toHaveBeenCalled();
    expect(memoryReflectionRunner.runMemoryReflection).toHaveBeenCalledOnce();
    expect(summaryManager.saveSummary).toHaveBeenCalledWith(sessionId, summaryData);

    const observation = readCacheSnapshotObservation(agentDir);
    expect(observation).toMatchObject({
      mode: "write",
      status: "success",
      cacheStrategy: "session_snapshot",
      strict: true,
      summaryPreview: writeSummary,
    });
  });

  it("write mode falls back to official rolling summary when the live session snapshot is unavailable (#1651)", async () => {
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("official summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn(),
    };
    const buildSessionCacheSnapshot = vi.fn(() => {
      throw new Error("Session cache snapshot unavailable: unknown session /tmp/cold.jsonl");
    });
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "write", summaryManager, memoryReflectionRunner, {
      buildSessionCacheSnapshot,
    });
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(buildSessionCacheSnapshot).toHaveBeenCalledOnce();
    expect(memoryReflectionRunner.runMemoryReflection).not.toHaveBeenCalled();
    expect(summaryManager.rollingSummary).toHaveBeenCalledWith(
      "2026-06-03T10-00-00-000Z_cache",
      expect.any(Array),
      expect.anything(),
      expect.objectContaining({ timeZone: expect.any(String) }),
    );
    expect(summaryManager.saveSummary).not.toHaveBeenCalled();

    const observation = readCacheSnapshotObservation(agentDir);
    expect(observation).toMatchObject({
      mode: "write",
      status: "failed",
      cacheStrategy: "cache_recovery",
      strict: false,
    });
    expect(observation.reason).toMatch(/snapshot unavailable/i);
  });

  it("write mode reloads a cold session runtime before falling back from snapshot reflection (#1782)", async () => {
    const summaryData = {
      summary: "### 重要事实\n- cache snapshot 已恢复。\n\n### 事情经过\n- [2026-06-03 10:01] 恢复 runtime 后写入缓存快照摘要。",
    };
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("official summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockResolvedValue({
        summary: summaryData.summary,
        changed: true,
        data: summaryData,
        metadata: {
          cacheStrategy: "session_snapshot",
          strict: true,
          cachePrefixHash: "b".repeat(64),
          parentCachePrefixHash: "a".repeat(64),
        },
      }),
    };
    const buildSessionCacheSnapshot = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("Session cache snapshot unavailable: unknown session after hibernation");
      })
      .mockImplementationOnce((sessionPath, { reason, messages }) => ({
        strategy: "session_snapshot",
        strict: true,
        sessionPath,
        reason,
        model: { id: "memory-model", provider: "deepseek" },
        requestModel: { id: "memory-model", provider: "deepseek" },
        cachePrefixHash: "a".repeat(64),
        parentCachePrefixHash: "",
        cacheKeyParams: { thinkingLevel: "medium" },
        tools: [],
        messages,
        messageCount: messages.length,
      }));
    const ensureSessionLoaded = vi.fn().mockResolvedValue({ ok: true });
    const { ticker, sessionPath } = makeTicker(tmpDir, "write", summaryManager, memoryReflectionRunner, {
      buildSessionCacheSnapshot,
      ensureSessionLoaded,
    });
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(ensureSessionLoaded).toHaveBeenCalledWith(sessionPath);
    expect(buildSessionCacheSnapshot).toHaveBeenCalledTimes(2);
    expect(memoryReflectionRunner.runMemoryReflection).toHaveBeenCalledOnce();
    expect(summaryManager.rollingSummary).not.toHaveBeenCalled();
    expect(summaryManager.saveSummary).toHaveBeenCalledWith("2026-06-03T10-00-00-000Z_cache", summaryData);
  });

  it("startup recovery uses the same rolling summary fallback for cold sessions in write mode (#1666)", async () => {
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("official recovery summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn(),
    };
    const { ticker, sessionPath } = makeTicker(tmpDir, "write", summaryManager, memoryReflectionRunner, {
      buildSessionCacheSnapshot: vi.fn(() => {
        throw new Error("Session cache snapshot unavailable: unknown session after restart");
      }),
    });
    writeSession(sessionPath);

    await ticker.tick();

    expect(memoryReflectionRunner.runMemoryReflection).not.toHaveBeenCalled();
    expect(summaryManager.rollingSummary).toHaveBeenCalledWith(
      "2026-06-03T10-00-00-000Z_cache",
      expect.any(Array),
      expect.anything(),
      expect.objectContaining({ timeZone: expect.any(String) }),
    );
  });

  it("write mode refuses non-strict reflection results", async () => {
    const summaryManager = {
      rollingSummary: vi.fn(),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockResolvedValue({
        summary: "recovery summary",
        changed: true,
        data: { summary: "recovery summary" },
        usage: { cache: { readTokens: 0, missTokens: 100 } },
        metadata: {
          cacheStrategy: "cache_recovery",
          strict: false,
          degradeReason: "session_snapshot_contract_mismatch",
        },
      }),
    };
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "write", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await expect(ticker.flushSession(sessionPath)).rejects.toThrow("requires a strict session_snapshot");
    expect(summaryManager.saveSummary).not.toHaveBeenCalled();
    const observation = readCacheSnapshotObservation(agentDir);
    expect(observation).toMatchObject({
      mode: "write",
      status: "failed",
      cacheStrategy: "cache_recovery",
      strict: false,
      degradeReason: "session_snapshot_contract_mismatch",
    });
  });

  it("write mode refuses format-violating reflection summaries and keeps the stored summary (#1628)", async () => {
    const summaryManager = {
      rollingSummary: vi.fn(),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockResolvedValue({
        summary: "自由格式摘要，没有重要事实标题段。",
        changed: true,
        data: { session_id: "s1", summary: "自由格式摘要，没有重要事实标题段。" },
        usage: { cache: { readTokens: 900, missTokens: 5 } },
        metadata: {
          cacheStrategy: "session_snapshot",
          strict: true,
          cachePrefixHash: "b".repeat(64),
          parentCachePrefixHash: "a".repeat(64),
        },
      }),
    };
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "write", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await expect(ticker.flushSession(sessionPath)).rejects.toThrow(/rolling summary format/i);
    expect(summaryManager.saveSummary).not.toHaveBeenCalled();
    const observation = readCacheSnapshotObservation(agentDir);
    expect(observation).toMatchObject({
      mode: "write",
      status: "failed",
      cacheStrategy: "session_snapshot",
      strict: true,
    });
    expect(observation.reason).toMatch(/rolling summary format/i);
  });

  it("passes the runtime session model and usage context to the reflection runner", async () => {
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("official summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockResolvedValue({
        summary: "shadow summary",
        changed: true,
        data: { summary: "shadow summary" },
        usage: { cache: { readTokens: 512, missTokens: 8 } },
        metadata: {
          cacheStrategy: "session_snapshot",
          strict: true,
          cachePrefixHash: "b".repeat(64),
          parentCachePrefixHash: "a".repeat(64),
        },
      }),
    };
    const { ticker, requestModel, sessionPath, usageLedger } = makeTicker(tmpDir, "shadow", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(memoryReflectionRunner.runMemoryReflection).toHaveBeenCalledOnce();
    const args = memoryReflectionRunner.runMemoryReflection.mock.calls[0][0];
    expect(args.model).toBe(requestModel);
    expect(args.snapshot.model).not.toHaveProperty("quirks");
    expect(args.cacheKeyParams).toEqual({ thinkingLevel: "medium" });
    expect(args.usageLedger).toBe(usageLedger);
    expect(args.usageContext).toEqual({
      source: {
        subsystem: "memory",
        operation: "cache_snapshot_reflection",
        surface: "system",
        trigger: "manual",
      },
      attribution: {
        kind: "memory",
        agentId: "hana",
      },
    });
  });

  it("records a traceable usage ledger entry for reflection requests (#1621)", async () => {
    const summaryManager = {
      rollingSummary: vi.fn(),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const ledgerLogger = { warn: vi.fn() };
    const realLedger = createUsageLedger({
      logger: ledgerLogger,
      requestIdFactory: () => "req-reflection",
    });
    const requestModelForSnapshot = {
      id: "memory-model",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "http://localhost:1234",
      quirks: ["enable_thinking"],
      reasoning: true,
    };
    const streamFn = vi.fn(async () => ({
      result: async () => ({
        content: [{ type: "text", text: "### 重要事实\n- 无\n\n### 事情经过\n- [2026-06-03 10:01] 用户在调缓存快照。" }],
        stopReason: "stop",
        usage: { input_tokens: 120, cache_read_input_tokens: 100, output_tokens: 16 },
      }),
    }));
    // 不注入 memoryReflectionRunner：走真实 runMemoryReflection → runSessionSnapshotSideTask → ledger 落账链路
    const { ticker, sessionPath } = makeTicker(tmpDir, "write", summaryManager, undefined, {
      usageLedger: realLedger,
      buildSessionCacheSnapshot: vi.fn((snapshotSessionPath, { reason, messages }) => buildSessionCacheSnapshot({
        sessionPath: snapshotSessionPath,
        reason,
        model: requestModelForSnapshot,
        cacheKeyParams: { thinkingLevel: "medium" },
        systemPrompt: "You are Hana.",
        tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
        messages,
      })),
      getSessionStreamFn: vi.fn(() => streamFn),
    });
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(streamFn).toHaveBeenCalledOnce();
    const { entries } = realLedger.list({});
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      requestId: "req-reflection",
      status: "ok",
      source: {
        subsystem: "memory",
        operation: "cache_snapshot_reflection",
        surface: "system",
        trigger: "manual",
      },
      attribution: {
        kind: "memory",
        agentId: "hana",
      },
      metadata: {
        cacheStrategy: "session_snapshot",
        cacheGroup: "memory.reflection",
        strict: true,
      },
    });
    // source/attribution 可解析时，账本不应再告警 unknown usage context
    expect(ledgerLogger.warn).not.toHaveBeenCalled();
    // 账本按 source/attribution 过滤要能找回这笔 reflection 账单（可追溯性）
    expect(realLedger.list({ subsystem: "memory", operation: "cache_snapshot_reflection" }).entries).toHaveLength(1);
    expect(realLedger.list({ attributionKind: "memory", agentId: "hana" }).entries).toHaveLength(1);
  });

  it("records format repair usage as a separate ledger entry with a distinguishable operation", async () => {
    const summaryManager = {
      rollingSummary: vi.fn(),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    let requestSequence = 0;
    const realLedger = createUsageLedger({
      requestIdFactory: () => `req-reflection-${++requestSequence}`,
    });
    const requestModelForSnapshot = {
      id: "memory-model",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "http://localhost:1234",
    };
    const validSummary = "### 重要事实\n- 无\n\n### 事情经过\n- [2026-06-03 10:01] 用户在调缓存快照。";
    const streamFn = vi.fn()
      .mockResolvedValueOnce({
        result: async () => ({
          content: [{ type: "text", text: "用户今天聊了聊缓存快照，没别的。" }],
          stopReason: "stop",
          usage: { input_tokens: 120, output_tokens: 16 },
        }),
      })
      .mockResolvedValueOnce({
        result: async () => ({
          content: [{ type: "text", text: validSummary }],
          stopReason: "stop",
          usage: { input_tokens: 140, output_tokens: 20 },
        }),
      });
    const { ticker, sessionPath } = makeTicker(tmpDir, "write", summaryManager, undefined, {
      usageLedger: realLedger,
      buildSessionCacheSnapshot: vi.fn((snapshotSessionPath, { reason, messages }) => buildSessionCacheSnapshot({
        sessionPath: snapshotSessionPath,
        reason,
        model: requestModelForSnapshot,
        cacheKeyParams: { thinkingLevel: "medium" },
        systemPrompt: "You are Hana.",
        tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
        messages,
      })),
      getSessionStreamFn: vi.fn(() => streamFn),
    });
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(summaryManager.saveSummary).toHaveBeenCalledWith("2026-06-03T10-00-00-000Z_cache", expect.objectContaining({ summary: validSummary }));

    // 初次生成与格式修复各落一笔账，operation 可区分（修复不混进初次的账目）
    const { entries } = realLedger.list({});
    expect(entries).toHaveLength(2);
    expect(entries[0].source.operation).toBe("cache_snapshot_reflection");
    expect(entries[1].source.operation).toBe("cache_snapshot_reflection_repair");
    expect(entries[1].source).toMatchObject({ subsystem: "memory", surface: "system", trigger: "manual" });
    expect(entries[1].attribution).toEqual({ kind: "memory", agentId: "hana" });
    expect(realLedger.list({ subsystem: "memory", operation: "cache_snapshot_reflection" }).entries).toHaveLength(1);
    expect(realLedger.list({ subsystem: "memory", operation: "cache_snapshot_reflection_repair" }).entries).toHaveLength(1);
  });

  it("writes bounded failure diagnostics for shadow reflection errors", async () => {
    const summaryManager = {
      rollingSummary: vi.fn().mockResolvedValue("official summary"),
      createRollingSummaryDraft: vi.fn(),
      saveSummary: vi.fn(),
      getSummary: vi.fn().mockReturnValue(null),
    };
    const error = new TypeError("Cannot read properties of undefined (reading 'includes')");
    error.stack = [
      "TypeError: Cannot read properties of undefined (reading 'includes')",
      "    at providerMatches (core/provider-compat/qwen.js:46:23)",
      "    at runProvider (core/llm-client.js:100:1)",
      "    at extraFrame (core/llm-client.js:101:1)",
      "    at extraFrame2 (core/llm-client.js:102:1)",
      "    at extraFrame3 (core/llm-client.js:103:1)",
    ].join("\n");
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockRejectedValue(error),
    };
    const { ticker, agentDir, sessionPath } = makeTicker(tmpDir, "shadow", summaryManager, memoryReflectionRunner);
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    const observation = readCacheSnapshotObservation(agentDir);
    expect(observation).toMatchObject({
      mode: "shadow",
      status: "failed",
      reason: "Cannot read properties of undefined (reading 'includes')",
      diagnostics: {
        errorName: "TypeError",
        requestModel: {
          id: "memory-model",
          provider: "deepseek",
          api: "openai-completions",
          hasQuirks: true,
        },
      },
    });
    expect(observation.diagnostics.stack).toHaveLength(4);
    expect(observation.diagnostics.stack[1]).toContain("providerMatches");
  });
});
