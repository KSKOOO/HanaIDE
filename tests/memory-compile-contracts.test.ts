/**
 * Compiled memory contract tests
 *
 * Merged from:
 *   - memory-compile-empty-fingerprint.test.ts
 *   - memory-compiled-reset.test.ts
 *
 * Covers:
 *   1. Fingerprint trap fix: empty sessions must not leave stale fingerprints
 *   2. Compiled section formatting: heading stripping, think-tag removal, facts compilation
 *   3. Compiled memory reset state: watermark read/write, artifact clearing, section normalization
 *   4. SessionSummaryManager reset support: watermark filtering, clearAll, rolling summary across reset
 *   5. Reset watermark filtering: `since` option propagation through compile functions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn().mockResolvedValue("compiled content from llm"),
}));

vi.mock("../lib/i18n.js", () => ({
  getLocale: () => "zh-CN",
}));

import { compileToday, compileWeek, compileLongterm, compileFacts, compileEditableFacts, assemble } from "../lib/memory/compile.ts";
import {
  readCompiledResetAt,
  writeCompiledResetMarker,
  clearCompiledMemoryArtifacts,
  clearCompiledSummarySources,
  normalizeCompiledSectionBody,
} from "../lib/memory/compiled-memory-state.ts";
import { SessionSummaryManager } from "../lib/memory/session-summary.ts";
import { callText } from "../core/llm-client.ts";

const RESOLVED_MODEL = { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" };

function makeFakeSummaryManager(summaries) {
  return {
    getSummariesInRange: vi.fn().mockReturnValue(summaries),
  };
}

// ---------------------------------------------------------------------------
// 1. Fingerprint trap fix — empty sessions
// ---------------------------------------------------------------------------

describe("compileToday empty-sessions fingerprint trap fix", () => {
  let tmpDir;
  let todayPath;
  let fpPath;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-compile-"));
    todayPath = path.join(tmpDir, "today.md");
    fpPath = todayPath + ".fingerprint";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not write fingerprint when sessions are empty", async () => {
    const mgr = makeFakeSummaryManager([]);
    await compileToday(mgr, todayPath, RESOLVED_MODEL);

    expect(fs.existsSync(fpPath)).toBe(false);
    expect(callText).not.toHaveBeenCalled();
  });

  it("recovers immediately after sessions reappear (no stale fingerprint lock)", async () => {
    // 1. 先制造"失败期"：sessions 空，导致写 0 bytes today.md（如果已有内容）
    fs.writeFileSync(todayPath, "stale content from yesterday");
    const mgrEmpty = makeFakeSummaryManager([]);
    await compileToday(mgrEmpty, todayPath, RESOLVED_MODEL);

    // 失败期：today.md 被清空，但没有 fingerprint
    expect(fs.readFileSync(todayPath, "utf-8")).toBe("");
    expect(fs.existsSync(fpPath)).toBe(false);

    // 2. summary 恢复：有新 session
    const mgrRecovered = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-17T10:00:00Z", summary: "new session summary" },
    ]);
    await compileToday(mgrRecovered, todayPath, RESOLVED_MODEL);

    // 恢复路径：LLM 被调用，文件被写入，fingerprint 被落下
    expect(callText).toHaveBeenCalledOnce();
    expect(fs.readFileSync(todayPath, "utf-8")).toBe("compiled content from llm");
    expect(fs.existsSync(fpPath)).toBe(true);
  });

  it("removes stale fingerprint when sessions become empty", async () => {
    // 先有数据 + fingerprint
    const mgrWith = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-17T10:00:00Z", summary: "real summary" },
    ]);
    await compileToday(mgrWith, todayPath, RESOLVED_MODEL);
    expect(fs.existsSync(fpPath)).toBe(true);

    // 进入失败期：sessions 空
    const mgrEmpty = makeFakeSummaryManager([]);
    await compileToday(mgrEmpty, todayPath, RESOLVED_MODEL);

    // 旧 fingerprint 应被删除（保证下次恢复时不会命中老指纹）
    expect(fs.existsSync(fpPath)).toBe(false);
  });

  it("does not rewrite today.md when it is already empty and sessions are empty", async () => {
    // today.md 本就不存在
    const mgrEmpty = makeFakeSummaryManager([]);
    await compileToday(mgrEmpty, todayPath, RESOLVED_MODEL);
    expect(fs.existsSync(todayPath)).toBe(false);

    // 再来一次仍不创建
    await compileToday(mgrEmpty, todayPath, RESOLVED_MODEL);
    expect(fs.existsSync(todayPath)).toBe(false);
  });

  it("skips via fingerprint when sessions are unchanged (non-empty case preserved)", async () => {
    const mgr = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-17T10:00:00Z", summary: "real summary" },
    ]);
    await compileToday(mgr, todayPath, RESOLVED_MODEL);
    expect(callText).toHaveBeenCalledOnce();

    // 相同 sessions 再调：fingerprint 命中，应 skip，LLM 不再被调用
    await compileToday(mgr, todayPath, RESOLVED_MODEL);
    expect(callText).toHaveBeenCalledOnce();
  });
});

describe("compileWeek empty-sessions fingerprint trap fix", () => {
  let tmpDir;
  let weekPath;
  let fpPath;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-compile-week-"));
    weekPath = path.join(tmpDir, "week.md");
    fpPath = weekPath + ".fingerprint";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not write fingerprint when sessions are empty", async () => {
    const mgr = makeFakeSummaryManager([]);
    await compileWeek(mgr, weekPath, RESOLVED_MODEL);

    expect(fs.existsSync(fpPath)).toBe(false);
    expect(callText).not.toHaveBeenCalled();
  });

  it("removes stale fingerprint when sessions become empty", async () => {
    const mgrWith = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-17T10:00:00Z", summary: "week summary" },
    ]);
    await compileWeek(mgrWith, weekPath, RESOLVED_MODEL);
    expect(fs.existsSync(fpPath)).toBe(true);

    const mgrEmpty = makeFakeSummaryManager([]);
    await compileWeek(mgrEmpty, weekPath, RESOLVED_MODEL);

    expect(fs.existsSync(fpPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Compiled section formatting
// ---------------------------------------------------------------------------

describe("compiled section formatting", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-compile-format-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("strips model-emitted headings before writing today.md", async () => {
    (callText as any).mockResolvedValueOnce("# 今日概要\n\n用户关注记忆系统。");
    const todayPath = path.join(tmpDir, "today.md");
    const mgr = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-29T08:30:00.000Z", summary: "用户关注记忆系统。" },
    ]);

    await compileToday(mgr, todayPath, RESOLVED_MODEL);

    expect(fs.readFileSync(todayPath, "utf-8")).toBe("用户关注记忆系统。");
  });

  it("strips closed think and thinking tags before writing compiled memory sections", async () => {
    (callText as any)
      .mockResolvedValueOnce("<think>先整理内部推理</think>\n用户关注记忆系统。")
      .mockResolvedValueOnce("<thinking>先整理内部推理</thinking>\n用户关注长期记忆。");
    const todayPath = path.join(tmpDir, "today.md");
    const weekPath = path.join(tmpDir, "week.md");
    const mgr = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-29T08:30:00.000Z", summary: "用户关注记忆系统。" },
    ]);

    await compileToday(mgr, todayPath, RESOLVED_MODEL);
    await compileWeek(mgr, weekPath, RESOLVED_MODEL);

    expect(fs.readFileSync(todayPath, "utf-8")).toBe("用户关注记忆系统。");
    expect(fs.readFileSync(weekPath, "utf-8")).toBe("用户关注长期记忆。");
  });

  it("rejects dangling leading thinking blocks without overwriting memory or fingerprinting the bad output", async () => {
    (callText as any).mockResolvedValueOnce("<thinking>未闭合的内部推理\n这些内容不应进入记忆");
    const todayPath = path.join(tmpDir, "today.md");
    const fpPath = `${todayPath}.fingerprint`;
    fs.writeFileSync(todayPath, "已有记忆", "utf-8");
    const mgr = makeFakeSummaryManager([
      { session_id: "s1", updated_at: "2026-04-29T08:30:00.000Z", summary: "用户关注记忆系统。" },
    ]);

    await expect(compileToday(mgr, todayPath, RESOLVED_MODEL)).rejects.toThrow(
      "unterminated thinking block",
    );

    expect(fs.readFileSync(todayPath, "utf-8")).toBe("已有记忆");
    expect(fs.existsSync(fpPath)).toBe(false);
  });

  it("compiles short facts updates instead of directly appending them", async () => {
    (callText as any).mockResolvedValueOnce("用户长期关注记忆系统。");
    const factsPath = path.join(tmpDir, "facts.md");
    fs.writeFileSync(factsPath, "用户喜欢清晰边界。", "utf-8");
    const mgr = makeFakeSummaryManager([
      {
        session_id: "s1",
        updated_at: "2026-04-29T08:30:00.000Z",
        summary: "## 重要事实\n用户长期关注记忆系统。\n\n## 事情经过\n无",
      },
    ]);

    await compileFacts(mgr, factsPath, RESOLVED_MODEL);

    expect(callText).toHaveBeenCalledOnce();
    const request = (callText as any).mock.calls[0][0];
    expect(request.messages[0].content).toContain("用户喜欢清晰边界。");
    expect(request.messages[0].content).toContain("用户长期关注记忆系统。");
    expect(request.systemPrompt).toContain("必须控制在 200 字以内");
    expect(request.systemPrompt).toContain("综合");
    expect(request.systemPrompt).toContain("不要追加");
    expect(fs.readFileSync(factsPath, "utf-8")).toBe("用户长期关注记忆系统。");
  });

  it("extracts facts from third-level rolling summary headings", async () => {
    (callText as any).mockResolvedValueOnce("用户长期关注记忆系统。");
    const factsPath = path.join(tmpDir, "facts.md");
    const mgr = makeFakeSummaryManager([
      {
        session_id: "s1",
        updated_at: "2026-04-29T08:30:00.000Z",
        summary: "### 重要事实\n用户长期关注记忆系统。\n\n### 事情经过\n无",
      },
    ]);

    await compileFacts(mgr, factsPath, RESOLVED_MODEL);

    expect(callText).toHaveBeenCalledOnce();
    const request = (callText as any).mock.calls[0][0];
    expect(request.messages[0].content).toContain("用户长期关注记忆系统。");
    expect(fs.readFileSync(factsPath, "utf-8")).toBe("用户长期关注记忆系统。");
  });

  it("extracts facts from English rolling summary headings", async () => {
    (callText as any).mockResolvedValueOnce("The user is focused on memory systems.");
    const factsPath = path.join(tmpDir, "facts.md");
    const mgr = makeFakeSummaryManager([
      {
        session_id: "s1",
        updated_at: "2026-04-29T08:30:00.000Z",
        summary: "### Key Facts\nThe user is focused on memory systems.\n\n### Timeline\nNone",
      },
    ]);

    await compileFacts(mgr, factsPath, RESOLVED_MODEL);

    expect(callText).toHaveBeenCalledOnce();
    const request = (callText as any).mock.calls[0][0];
    expect(request.messages[0].content).toContain("The user is focused on memory systems.");
    expect(fs.readFileSync(factsPath, "utf-8")).toBe("The user is focused on memory systems.");
  });

  it("seeds editable facts and records existing summaries as already processed", async () => {
    const memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    const factsPath = path.join(memoryDir, "facts.md");
    const editableFactsPath = path.join(memoryDir, "editable-facts.md");
    const statePath = path.join(memoryDir, "editable-facts-state.json");
    fs.writeFileSync(factsPath, "用户喜欢清晰边界。", "utf-8");
    const mgr = {
      getAllSummaries: vi.fn(() => [
        {
          session_id: "s1",
          updated_at: "2026-04-29T08:30:00.000Z",
          summary: "### 重要事实\n用户最近在关注记忆系统。\n\n### 事情经过\n无",
        },
      ]),
    };

    await compileEditableFacts(mgr, editableFactsPath, RESOLVED_MODEL, {
      seedFactsPath: factsPath,
      statePath,
    });

    expect(callText).not.toHaveBeenCalled();
    expect(fs.readFileSync(editableFactsPath, "utf-8")).toBe("用户喜欢清晰边界。");
    expect(JSON.parse(fs.readFileSync(statePath, "utf-8"))).toMatchObject({
      lastCompiledSummaryUpdatedAt: "2026-04-29T08:30:00.000Z",
    });
  });

  it("merges editable facts with only summaries after the editable facts watermark", async () => {
    (callText as any).mockResolvedValueOnce("用户喜欢清晰边界。\n用户长期关注记忆系统。");
    const memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    const editableFactsPath = path.join(memoryDir, "editable-facts.md");
    const statePath = path.join(memoryDir, "editable-facts-state.json");
    fs.writeFileSync(editableFactsPath, "用户喜欢清晰边界。", "utf-8");
    fs.writeFileSync(statePath, JSON.stringify({
      lastCompiledSummaryUpdatedAt: "2026-04-29T08:30:00.000Z",
    }), "utf-8");
    const mgr = {
      getAllSummaries: vi.fn(() => [
        {
          session_id: "old",
          updated_at: "2026-04-29T08:30:00.000Z",
          summary: "### 重要事实\n旧摘要不应再次进入编译。\n\n### 事情经过\n无",
        },
        {
          session_id: "new",
          updated_at: "2026-04-30T09:30:00.000Z",
          summary: "### 重要事实\n用户长期关注记忆系统。\n\n### 事情经过\n无",
        },
      ]),
    };

    await compileEditableFacts(mgr, editableFactsPath, RESOLVED_MODEL, { statePath });

    expect(callText).toHaveBeenCalledOnce();
    const request = (callText as any).mock.calls[0][0];
    expect(request.messages[0].content).toContain("## 当前可信 Facts");
    expect(request.messages[0].content).toContain("用户喜欢清晰边界。");
    expect(request.messages[0].content).toContain("## 新增候选 Facts");
    expect(request.messages[0].content).toContain("用户长期关注记忆系统。");
    expect(request.messages[0].content).not.toContain("旧摘要不应再次进入编译");
    expect(request.systemPrompt).toContain("必须控制在 200 字以内");
    expect(request.systemPrompt).toContain("综合");
    expect(request.systemPrompt).toContain("不要追加");
    expect(fs.readFileSync(editableFactsPath, "utf-8")).toBe("用户喜欢清晰边界。\n用户长期关注记忆系统。");
    expect(JSON.parse(fs.readFileSync(statePath, "utf-8"))).toMatchObject({
      lastCompiledSummaryUpdatedAt: "2026-04-30T09:30:00.000Z",
    });
  });

  it("asks the model to rewrite longterm from previous and weekly inputs within a word limit", async () => {
    (callText as any).mockResolvedValueOnce("用户长期关注记忆系统。");
    const weekPath = path.join(tmpDir, "week.md");
    const longtermPath = path.join(tmpDir, "longterm.md");
    fs.writeFileSync(weekPath, "用户本周关注记忆系统。", "utf-8");
    fs.writeFileSync(longtermPath, "用户喜欢清晰边界。", "utf-8");

    await compileLongterm(weekPath, longtermPath, RESOLVED_MODEL);

    expect(callText).toHaveBeenCalledOnce();
    const request = (callText as any).mock.calls[0][0];
    expect(request.messages[0].content).toContain("## 上一份长期情况");
    expect(request.messages[0].content).toContain("用户喜欢清晰边界。");
    expect(request.messages[0].content).toContain("## 本周新增");
    expect(request.messages[0].content).toContain("用户本周关注记忆系统。");
    expect(request.systemPrompt).toContain("必须控制在 400 字以内");
    expect(request.systemPrompt).toContain("综合");
    expect(request.systemPrompt).toContain("重写成一份新的长期情况");
    expect(request.systemPrompt).toContain("不要追加");
  });

  it("ignores unordered-list empty fact markers", async () => {
    const factsPath = path.join(tmpDir, "facts.md");
    const mgr = makeFakeSummaryManager([
      {
        session_id: "s1",
        updated_at: "2026-04-29T08:30:00.000Z",
        summary: "### 重要事实\n- 无\n\n### 事情经过\n- 用户在讨论记忆系统。",
      },
      {
        session_id: "s2",
        updated_at: "2026-04-29T09:30:00.000Z",
        summary: "### Key Facts\n- None\n\n### Timeline\n- The user discussed memory systems.",
      },
    ]);

    await compileFacts(mgr, factsPath, RESOLVED_MODEL);

    expect(callText).not.toHaveBeenCalled();
    expect(fs.readFileSync(factsPath, "utf-8")).toBe("");
  });

  it("assemble strips legacy nested headings from source sections", async () => {
    const factsPath = path.join(tmpDir, "facts.md");
    const todayPath = path.join(tmpDir, "today.md");
    const weekPath = path.join(tmpDir, "week.md");
    const longtermPath = path.join(tmpDir, "longterm.md");
    const memoryPath = path.join(tmpDir, "memory.md");
    fs.writeFileSync(factsPath, "[\"用户喜欢清晰边界\"]", "utf-8");
    fs.writeFileSync(todayPath, "# 今天概要\n\n用户关注记忆系统。", "utf-8");
    fs.writeFileSync(weekPath, "# 本周主题概要\n\n用户持续关注 Project Hana。", "utf-8");
    fs.writeFileSync(longtermPath, "# 长期背景记录\n\n## 偏好\n\n用户偏好沉静 UI。", "utf-8");

    assemble(factsPath, todayPath, weekPath, longtermPath, memoryPath);

    const output = fs.readFileSync(memoryPath, "utf-8");
    expect(output).toContain("## 重要事实\n\n- 用户喜欢清晰边界");
    expect(output).toContain("## 今天\n\n用户关注记忆系统。");
    expect(output).toContain("## 本周早些时候\n\n用户持续关注 Project Hana。");
    expect(output).toContain("## 长期情况\n\n用户偏好沉静 UI。");
    expect(output).not.toContain("# 本周主题概要");
    expect(output).not.toContain("# 长期背景记录");
  });
});

// ---------------------------------------------------------------------------
// 3. Compiled memory reset state
// ---------------------------------------------------------------------------

describe("compiled memory reset state", () => {
  let tmpDir;
  let memoryDir;
  let summariesDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-compiled-reset-"));
    memoryDir = path.join(tmpDir, "memory");
    summariesDir = path.join(memoryDir, "summaries");
    fs.mkdirSync(summariesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads the compiled reset watermark", () => {
    const resetAt = "2026-04-29T08:00:00.000Z";
    writeCompiledResetMarker(memoryDir, resetAt);

    expect(readCompiledResetAt(memoryDir)).toBe(resetAt);
    const raw = JSON.parse(fs.readFileSync(path.join(memoryDir, "reset.json"), "utf-8"));
    expect(raw.compiledResetAt).toBe(resetAt);
  });

  it("clears compiled artifacts and fingerprints without deleting summaries", () => {
    for (const name of ["memory.md", "facts.md", "today.md", "week.md", "longterm.md"]) {
      fs.writeFileSync(path.join(memoryDir, name), "old content", "utf-8");
      fs.writeFileSync(path.join(memoryDir, `${name}.fingerprint`), "fingerprint", "utf-8");
    }
    fs.writeFileSync(path.join(summariesDir, "s1.json"), "{}", "utf-8");

    clearCompiledMemoryArtifacts(memoryDir);

    for (const name of ["memory.md", "facts.md", "today.md", "week.md", "longterm.md"]) {
      expect(fs.readFileSync(path.join(memoryDir, name), "utf-8")).toBe("");
      expect(fs.existsSync(path.join(memoryDir, `${name}.fingerprint`))).toBe(false);
    }
    expect(fs.existsSync(path.join(summariesDir, "s1.json"))).toBe(true);
  });

  it("clears summary source files and calls the cache clearer", () => {
    fs.writeFileSync(path.join(summariesDir, "s1.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(summariesDir, "s1.tmp"), "not a summary", "utf-8");
    let cacheCleared = false;

    clearCompiledSummarySources(summariesDir, { clearCache: () => { cacheCleared = true; } });

    expect(fs.existsSync(path.join(summariesDir, "s1.json"))).toBe(false);
    expect(fs.existsSync(path.join(summariesDir, "s1.tmp"))).toBe(true);
    expect(cacheCleared).toBe(true);
  });

  it("normalizes section body content by removing headings and JSON string arrays", () => {
    expect(normalizeCompiledSectionBody("# 本周主题概要\n\n- 用户关注记忆系统")).toBe("- 用户关注记忆系统");
    expect(normalizeCompiledSectionBody("## 长期背景记录\n\n### 偏好\n\n用户喜欢沉静的 UI")).toBe("用户喜欢沉静的 UI");
    expect(normalizeCompiledSectionBody("[\"用户关注 Project Hana\", \"用户喜欢清晰边界\"]")).toBe("- 用户关注 Project Hana\n- 用户喜欢清晰边界");
  });
});

// ---------------------------------------------------------------------------
// 4. SessionSummaryManager reset support
// ---------------------------------------------------------------------------

describe("SessionSummaryManager reset support", () => {
  let tmpDir;
  let summariesDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-summary-reset-"));
    summariesDir = path.join(tmpDir, "summaries");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("filters summaries at or before the reset watermark", () => {
    const manager = new SessionSummaryManager(summariesDir);
    manager.saveSummary("old", {
      session_id: "old",
      created_at: "2026-04-29T07:00:00.000Z",
      updated_at: "2026-04-29T07:30:00.000Z",
      summary: "old summary",
    });
    manager.saveSummary("new", {
      session_id: "new",
      created_at: "2026-04-29T08:30:00.000Z",
      updated_at: "2026-04-29T08:30:00.000Z",
      summary: "new summary",
    });

    const summaries = manager.getSummariesInRange(
      new Date("2026-04-29T00:00:00.000Z"),
      new Date("2026-04-30T00:00:00.000Z"),
      { since: "2026-04-29T08:00:00.000Z" },
    );

    expect(summaries.map((s) => s.session_id)).toEqual(["new"]);
  });

  it("clearAll removes JSON summary files and clears the in-memory cache", () => {
    const manager = new SessionSummaryManager(summariesDir);
    manager.saveSummary("s1", {
      session_id: "s1",
      created_at: "2026-04-29T08:30:00.000Z",
      updated_at: "2026-04-29T08:30:00.000Z",
      summary: "summary",
    });

    manager.clearAll();

    expect(manager.getAllSummaries()).toEqual([]);
    expect(fs.readdirSync(summariesDir).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("ignores pre-reset existing summary when rolling a post-reset session", async () => {
    (callText as any).mockResolvedValueOnce("## 重要事实\n新事实\n\n## 事情经过\n新事件");
    const manager = new SessionSummaryManager(summariesDir);
    manager.saveSummary("s1", {
      session_id: "s1",
      created_at: "2026-04-29T07:00:00.000Z",
      updated_at: "2026-04-29T07:30:00.000Z",
      summary: "old summary",
      messageCount: 1,
    });
    writeCompiledResetMarker(tmpDir, "2026-04-29T08:00:00.000Z");

    await manager.rollingSummary(
      "s1",
      [{ role: "user", content: "new message", timestamp: "2026-04-29T08:01:00.000Z" }],
      RESOLVED_MODEL,
    );

    const userContent = (callText as any).mock.calls[0][0].messages[0].content;
    expect(userContent).not.toContain("old summary");
    expect(manager.getSummary("s1").summary).toContain("新事实");
  });

  it("does not save a rolling summary that started before reset and finishes after reset", async () => {
    const manager = new SessionSummaryManager(summariesDir);
    (callText as any).mockImplementationOnce(async () => {
      writeCompiledResetMarker(tmpDir, "2026-04-29T08:00:00.000Z");
      return "## 重要事实\n旧事实\n\n## 事情经过\n旧事件";
    });

    await manager.rollingSummary(
      "s1",
      [{ role: "user", content: "old message", timestamp: "2026-04-29T07:59:00.000Z" }],
      RESOLVED_MODEL,
    );

    expect(manager.getSummary("s1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Reset watermark filtering — `since` propagation
// ---------------------------------------------------------------------------

describe("compiled memory reset watermark filtering", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-compile-since-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes since to summary range queries for today and week", async () => {
    const summaries = [
      { session_id: "new", updated_at: "2026-04-29T08:30:00.000Z", summary: "new summary" },
    ];
    const mgr = makeFakeSummaryManager(summaries);

    await compileToday(mgr, path.join(tmpDir, "today.md"), RESOLVED_MODEL, { since: "2026-04-29T08:00:00.000Z" });
    await compileWeek(mgr, path.join(tmpDir, "week.md"), RESOLVED_MODEL, { since: "2026-04-29T08:00:00.000Z" });

    expect(mgr.getSummariesInRange.mock.calls[0][2]).toEqual({ since: "2026-04-29T08:00:00.000Z" });
    expect(mgr.getSummariesInRange.mock.calls[1][2]).toEqual({ since: "2026-04-29T08:00:00.000Z" });
  });

  it("passes since to summary range queries for facts", async () => {
    const mgr = makeFakeSummaryManager([
      {
        session_id: "new",
        updated_at: "2026-04-29T08:30:00.000Z",
        summary: "## 重要事实\n用户关注记忆系统。\n\n## 事情经过\n无",
      },
    ]);

    await compileFacts(mgr, path.join(tmpDir, "facts.md"), RESOLVED_MODEL, { since: "2026-04-29T08:00:00.000Z" });

    expect(mgr.getSummariesInRange.mock.calls[0][2]).toEqual({ since: "2026-04-29T08:00:00.000Z" });
  });
});
