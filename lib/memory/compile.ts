/**
 * compile.js — 记忆编译器（v3 四块独立编译 + assemble）
 *
 * 四个独立函数各自有指纹缓存，互不依赖：
 *   compileToday()    → today.md（当天 sessions）
 *   compileWeek()     → week.md（过去7天滑动窗口）
 *   compileLongterm() → longterm.md（fold 周报到长期）
 *   compileFacts()    → facts.md（重要事实，继承上一版）
 *
 * assemble() 同步读取四个文件，拼成 memory.md（≤2000 token）。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getLogicalDay } from "../time-utils.ts";
import { callText } from "../../core/llm-client.ts";
import { getLocale } from "../i18n.ts";
import { atomicWriteSync, safeReadFile } from "../../shared/safe-fs.ts";
import { normalizeCompiledLLMResult, normalizeCompiledSectionBody } from "./compiled-memory-state.ts";
import { attachPromptLayoutMetadata, buildUtilityPromptLayout } from "../llm/prompt-layout.ts";
import {
  buildCompileEditableFactsPrompt,
  buildCompileFactsPrompt,
  buildCompileLongtermPrompt,
  buildCompileTodayPrompt,
  buildCompileWeekPrompt,
} from "./prompts/compile.ts";
import { withMemoryReasoningBuffer } from "./llm-budget.ts";
import {
  FACT_SECTION_TITLES,
  extractFactSection,
  hasFactSectionHeading,
  isEmptyFactSection,
} from "./rolling-summary-format.ts";
import { createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("memory-compile");

function _isZh() { return getLocale().startsWith("zh"); }

const EMPTY_MEMORY_ZH = "（暂无记忆）\n";
const EMPTY_MEMORY_EN = "(No memory yet)\n";
export function getEmptyMemory() { return _isZh() ? EMPTY_MEMORY_ZH : EMPTY_MEMORY_EN; }

export const EDITABLE_FACTS_FILE = "editable-facts.md";
export const EDITABLE_FACTS_STATE_FILE = "editable-facts-state.json";

const COMPILE_PROMPT_BUILDERS = {
  compile_today: buildCompileTodayPrompt,
  compile_week: buildCompileWeekPrompt,
  compile_longterm: buildCompileLongtermPrompt,
  compile_facts: buildCompileFactsPrompt,
  compile_editable_facts: buildCompileEditableFactsPrompt,
};

// ════════════════════════════
//  v3 四块独立编译 + assemble
// ════════════════════════════

/**
 * 编译今天的 session 摘要 → today.md
 * @param {import('./session-summary.ts').SessionSummaryManager} summaryManager
 * @param {string} outputPath
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<"compiled"|"skipped">}
 */
export async function compileToday(summaryManager, outputPath, resolvedModel, opts: { since?: any } = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const { rangeStart } = getLogicalDay();
  const sessions = summaryManager.getSummariesInRange(rangeStart, new Date(), { since: opts.since || null });
  const fpPath = outputPath + ".fingerprint";

  // 空 sessions 不写 fingerprint：rollingSummary 失败期会让 sessions 持续为空，
  // 若落下 "empty" 指纹，之后 summary 恢复前该指纹仍会命中（因为下一次也是 empty），
  // 导致 today.md 永远卡在 0 bytes。只在有真实 session 摘要时用 fingerprint 去重。
  if (sessions.length === 0) {
    try { fs.unlinkSync(fpPath); } catch {}
    const cur = safeReadFile(outputPath, "");
    if (cur.length > 0) atomicWrite(outputPath, "");
    return "compiled";
  }

  const fpKeys = sessions.map((s) => `${s.session_id}:${s.updated_at}`);
  const fp = computeFingerprint(fpKeys);
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(outputPath)) return "skipped";
  } catch {}

  const input = sessions.map((s) => s.summary).join("\n\n---\n\n");
  const isZh = _isZh();
  const result = await _compactLLM(
    input,
    isZh
      ? `请把今天的对话摘要整理成一份"用户近况与大主题清单"。

提炼原则：
- 把同一主题/项目的多次往返归并为一件事，不要逐条流水账
- 时间标注用主时段（"上午/傍晚"或粗略 HH:MM 区间），不需精确到分钟
- 记忆的核心职责是维护用户模型，优先记录用户是谁、喜欢什么、在意什么、最近关注什么
- 工作相关内容只允许保留到大主题层级：只写用户最近关注的领域/项目/主题，不写该主题里的细节

可以记录：
- 用户的身份、人格特质、审美、兴趣、喜欢或讨厌的事物
- 用户最近关注的大主题，例如"记忆系统""Project Hana""AI Agent"
- 用户生活、创作、关系或长期关注方向的变化

不要记录：
- 不要记录执行步骤、文件名、工具、命令、检查顺序、协作偏好、工作细节
- 任务过程中的方法论选择、工具偏好、格式要求、术语规则
- 具体子问题、具体方案、具体改法、具体测试或发布流程
- 助手具体产出的内容（"生成了一篇关于 X 的文章"够了，不要摘录文章内容）
- 来回修改、重试、被打断又恢复这类过程波动

输出 3-5 条粗颗粒事件，每条 1-2 句。最多 300 字。一天平淡就写得短。不要输出 Markdown 标题，不要以 #、##、### 开头；直接输出正文列表或段落。`
      : `Distill today's conversation summaries into a "user-current-state and broad-theme list".

Principles:
- Merge multiple back-and-forth on the same topic/project into ONE event; do not enumerate line by line
- Time markers use major periods ("morning/evening" or rough HH:MM range), no minute-level precision
- Memory's core job is to maintain a user model: prioritize who the user is, what they like, what they care about, and what they are broadly focused on recently
- Work-related content may only be kept at the broad-theme level: record the domain/project/theme, not details inside that theme

May record:
- The user's identity, personality traits, aesthetics, interests, likes, and dislikes
- Broad themes the user is currently focused on, such as "memory systems", "Project Hana", or "AI Agent"
- Changes in the user's life, creative work, relationships, or long-term areas of attention

Do NOT record:
- Execution steps, filenames, tools, commands, validation order, collaboration preferences, or work details
- Task-level methodology choices, tool preferences, format requirements, terminology rules
- Specific subproblems, concrete solutions, concrete code changes, tests, or release flows
- Specific content of assistant's output ("wrote an article about X" is enough; do not excerpt the article)
- Revisions, retries, interruptions and resumptions — these are process noise

Output 3-5 coarse events, 1-2 sentences each. Max 180 words. Keep it short on quiet days. Do not output Markdown headings. Do not start with #, ##, or ###; output body text only.`,
    resolvedModel,
    450,
    "compile_today",
  );

  atomicWrite(outputPath, normalizeCompiledLLMResult(result, "compileToday"));
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 编译过去 7 天滑动窗口的摘要 → week.md
 * @param {object} resolvedModel
 */
export async function compileWeek(summaryManager, outputPath, resolvedModel, opts: { since?: any } = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

  const sessions = summaryManager.getSummariesInRange(sevenDaysAgo, now, { since: opts.since || null });
  const fpPath = outputPath + ".fingerprint";

  // 空 sessions 不写 fingerprint：同 compileToday 的理由，避免失败态被指纹锁死。
  if (sessions.length === 0) {
    try { fs.unlinkSync(fpPath); } catch {}
    const cur = safeReadFile(outputPath, "");
    if (cur.length > 0) atomicWrite(outputPath, "");
    return "compiled";
  }

  const fpKeys = sessions.map((s) => `${s.session_id}:${s.updated_at}`);
  const fp = computeFingerprint(fpKeys);
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(outputPath)) return "skipped";
  } catch {}

  const input = sessions.map((s) => s.summary).join("\n\n---\n\n");
  const isZh = _isZh();
  const result = await _compactLLM(
    input,
    isZh
      ? `请把过去 7 天的对话摘要整理成一份"本周用户主题概要"。

关键定位：到 week 这一层，记录已经是粗线条的了。它不是"每天发生的事"的集合，而是再上一层——归纳用户这一周大致在关注什么、投入什么、发生了什么重要变化。读这份记录的人只需要知道用户近况和大主题，不需要知道任何过程细节。

提炼层级：
- 记忆的核心职责是维护用户模型：用户是谁、喜欢什么、在意什么、最近关注什么
- 工作相关内容只允许保留到大主题层级：只写用户最近关注的领域/项目/主题，不写该主题里的细节
- 持续性的关注主题（"本周持续关注 X"、"这几天主要在做 Y"）放最前
- 够分量的个人近况、创作主题、关系变化、兴趣变化次之
- 时间用模糊表述（"周初/前几天/这两天"），不留精确时间戳

明确不要保留的内容：
- 不要记录执行步骤、文件名、工具、命令、检查顺序、协作偏好、工作细节
- 某个主题里的具体子问题、具体方案、具体改法、具体测试或发布流程
- 任务过程中的方法论、工具、格式选择
- 单次对话内的来回修改、临时决定
- 助手的具体产出内容
- 不重要的杂事（普通的闲聊、查询、调试）

只记录"用户这一周大致关注什么、发生了什么重要变化"。工作只记大主题，其他可以不写。

输出 3-5 条本周主题/事件。最多 400 字。不要输出 Markdown 标题，不要以 #、##、### 开头；直接输出正文列表或段落。`
      : `Distill the past 7 days' conversation summaries into a "weekly user-theme overview".

Positioning: at the week layer, the record is already coarse-grained. It is NOT a collection of "what happened each day" — it is one level above: distilling what the user was broadly focused on, invested in, and what important changes happened. The reader only needs user current-state and broad themes, not any process detail.

Layering:
- Memory's core job is to maintain a user model: who the user is, what they like, what they care about, and what they are broadly focused on recently
- Work-related content may only be kept at the broad-theme level: record the domain/project/theme, not details inside that theme
- Persistent focus themes ("focused on X this week", "spent several days on Y") come first
- Substantial personal current-state, creative themes, relationship changes, or interest changes come second
- Time is vague ("early in the week / a few days ago / these last two days"); do NOT preserve exact timestamps

Explicitly do NOT keep:
- Execution steps, filenames, tools, commands, validation order, collaboration preferences, or work details
- Specific subproblems, concrete solutions, concrete code changes, tests, or release flows
- Task-level details (how it was done, how many revisions, interruptions and resumptions)
- Task-level methodology, tools, format choices
- Within-conversation revisions and temporary decisions
- Specific content of assistant's output
- Trivial activity (small talk, lookups, debugging)

Record only "what the user was broadly focused on and what important changes happened this week". For work, keep only the broad theme. Skip the rest.

Output 3-5 weekly themes/events. Max 240 words. Do not output Markdown headings. Do not start with #, ##, or ###; output body text only.`,
    resolvedModel,
    600,
    "compile_week",
  );

  atomicWrite(outputPath, normalizeCompiledLLMResult(result, "compileWeek"));
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 将 week.md fold 进 longterm.md（每日一次）
 * @param {object} resolvedModel
 */
export async function compileLongterm(weekMdPath, longtermPath, resolvedModel) {
  fs.mkdirSync(path.dirname(longtermPath), { recursive: true });

  const weekContent = safeReadFile(weekMdPath, "").trim();

  if (!weekContent) return "skipped";

  // fingerprint：week.md 内容没变就跳过，避免每天把同一批内容反复折叠
  const fp = computeFingerprint([weekContent]);
  const fpPath = longtermPath + ".fingerprint";
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(longtermPath)) return "skipped";
  } catch {}

  const prevLongterm = safeReadFile(longtermPath, "").trim();

  const isZh = _isZh();
  const input = prevLongterm
    ? (isZh
        ? `## 上一份长期情况\n\n${prevLongterm}\n\n## 本周新增\n\n${weekContent}`
        : `## Previous long-term context\n\n${prevLongterm}\n\n## This week's additions\n\n${weekContent}`)
    : (isZh
        ? `## 本周新增\n\n${weekContent}`
        : `## This week's additions\n\n${weekContent}`);

  const result = await _compactLLM(
    input,
    buildCompileLongtermPrompt(getLocale()),
    resolvedModel,
    600,
    "compile_longterm",
  );

  atomicWrite(longtermPath, normalizeCompiledLLMResult(result, "compileLongterm"));
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 从近期 session 摘要的 重要事实 / Key Facts 段编译 facts.md
 * @param {object} resolvedModel
 */
export async function compileFacts(summaryManager, outputPath, resolvedModel, opts: { since?: any } = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // 读取上一版 facts.md 作为继承基础（避免 30 天外的稳定属性丢失）
  const prevFacts = safeReadFile(outputPath, "").trim();

  // 取最近 30 天的新摘要，提取 重要事实 / Key Facts 段。
  // 兼容旧 H2 摘要和新 H3 摘要，避免调整 rolling summary 层级时丢老数据。
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const sessions = summaryManager.getSummariesInRange(thirtyDaysAgo, now, { since: opts.since || null });

  const factParts = [];
  const skippedSessionIds = [];
  for (const s of sessions) {
    if (!s.summary) continue;
    // 读时兼容（#1628）：缺少 重要事实 / Key Facts 标题段的旧自由格式摘要
    // 无法提取，显式跳过并记录，不能静默吞掉也不能崩溃。
    if (!hasFactSectionHeading(s.summary)) {
      skippedSessionIds.push(s.session_id);
      continue;
    }
    const text = extractFactSection(s.summary);
    if (text && !isEmptyFactSection(text)) factParts.push(text);
  }
  if (skippedSessionIds.length > 0) {
    log.warn(`compileFacts: ${skippedSessionIds.length} 份摘要缺少 ${FACT_SECTION_TITLES.join("/")} 标题段，已跳过: ${skippedSessionIds.join(", ")}`);
  }

  // 没有新摘要时：保留旧 facts 原样
  if (factParts.length === 0) {
    if (!prevFacts) atomicWrite(outputPath, "");
    return "compiled";
  }

  const newFacts = factParts.join("\n");
  const isZh = _isZh();
  const combined = prevFacts
    ? (isZh
        ? `## 现有 Facts\n\n${prevFacts}\n\n## 新增候选 Facts\n\n${newFacts}`
        : `## Existing Facts\n\n${prevFacts}\n\n## New Candidate Facts\n\n${newFacts}`)
    : (isZh
        ? `## 新增候选 Facts\n\n${newFacts}`
        : `## New Candidate Facts\n\n${newFacts}`);

  const result = await _compactLLM(
    combined,
    buildCompileFactsPrompt(getLocale()),
    resolvedModel,
    300,
    "compile_facts",
  );

  atomicWrite(outputPath, normalizeCompiledLLMResult(result, "compileFacts"));
  return "compiled";
}

export function editableFactsPath(memoryDir) {
  return path.join(memoryDir, EDITABLE_FACTS_FILE);
}

export function editableFactsStatePath(memoryDir) {
  return path.join(memoryDir, EDITABLE_FACTS_STATE_FILE);
}

export function readEditableFactsText(memoryDir) {
  const editablePath = editableFactsPath(memoryDir);
  const sourcePath = fs.existsSync(editablePath)
    ? editablePath
    : path.join(memoryDir, "facts.md");
  return normalizeCompiledSectionBody(safeReadFile(sourcePath, ""));
}

export function readCompiledMemorySections(memoryDir, opts: Record<string, any> = {}) {
  const editableFactsEnabled = opts.editableFactsEnabled === true;
  if (editableFactsEnabled) {
    ensureEditableFactsBaseline(memoryDir, opts.summaryManager || null, {
      seedFactsPath: path.join(memoryDir, "facts.md"),
    });
  }
  const factsPath = editableFactsEnabled ? editableFactsPath(memoryDir) : path.join(memoryDir, "facts.md");
  return {
    facts: normalizeCompiledSectionBody(safeReadFile(factsPath, "")),
    today: normalizeCompiledSectionBody(safeReadFile(path.join(memoryDir, "today.md"), "")),
    week: normalizeCompiledSectionBody(safeReadFile(path.join(memoryDir, "week.md"), "")),
    longterm: normalizeCompiledSectionBody(safeReadFile(path.join(memoryDir, "longterm.md"), "")),
  };
}

export function writeEditableFactsSection(memoryDir, facts, opts: Record<string, any> = {}) {
  ensureEditableFactsBaseline(memoryDir, opts.summaryManager || null, {
    seedFactsPath: path.join(memoryDir, "facts.md"),
  });
  const targetPath = editableFactsPath(memoryDir);
  const normalizedFacts = normalizeCompiledSectionBody(String(facts ?? ""));
  atomicWrite(targetPath, normalizedFacts ? `${normalizedFacts}\n` : "");
  assemble(
    targetPath,
    path.join(memoryDir, "today.md"),
    path.join(memoryDir, "week.md"),
    path.join(memoryDir, "longterm.md"),
    opts.memoryMdPath || path.join(memoryDir, "memory.md"),
  );
  return normalizedFacts;
}

export function ensureEditableFactsBaseline(memoryDir, summaryManager = null, opts: Record<string, any> = {}) {
  fs.mkdirSync(memoryDir, { recursive: true });
  const outputPath = opts.outputPath || editableFactsPath(memoryDir);
  const statePath = opts.statePath || editableFactsStatePath(memoryDir);
  const seedFactsPath = opts.seedFactsPath || path.join(memoryDir, "facts.md");
  const summaries = opts.summaries || getAllSummariesForFacts(summaryManager);
  const latestSummaryUpdatedAt = latestSummaryUpdate(summaries);
  let changed = false;

  if (!fs.existsSync(outputPath)) {
    const seedFacts = normalizeCompiledSectionBody(safeReadFile(seedFactsPath, ""));
    atomicWrite(outputPath, seedFacts);
    changed = true;
  }

  const state = readEditableFactsState(statePath);
  if (!state.lastCompiledSummaryUpdatedAt && latestSummaryUpdatedAt) {
    writeEditableFactsState(statePath, latestSummaryUpdatedAt);
    changed = true;
  }

  return { changed, latestSummaryUpdatedAt };
}

export async function compileEditableFacts(summaryManager, outputPath, resolvedModel, opts: Record<string, any> = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const statePath = opts.statePath || path.join(path.dirname(outputPath), EDITABLE_FACTS_STATE_FILE);
  const summaries = getAllSummariesForFacts(summaryManager);
  const baseline = ensureEditableFactsBaseline(path.dirname(outputPath), summaryManager, {
    ...opts,
    outputPath,
    statePath,
    summaries,
  });
  if (baseline.changed) return "compiled";

  const state = readEditableFactsState(statePath);
  const since = latestIso(state.lastCompiledSummaryUpdatedAt, opts.since || null);
  const sessions = summaries.filter((s) => {
    const updated = s?.updated_at || s?.created_at || "";
    return updated && (!since || updated > since);
  });
  if (sessions.length === 0) return "skipped";

  const factParts = [];
  const skippedSessionIds = [];
  for (const s of sessions) {
    if (!s.summary) continue;
    if (!hasFactSectionHeading(s.summary)) {
      skippedSessionIds.push(s.session_id);
      continue;
    }
    const text = extractFactSection(s.summary);
    if (text && !isEmptyFactSection(text)) factParts.push(text);
  }
  if (skippedSessionIds.length > 0) {
    log.warn(`compileEditableFacts: ${skippedSessionIds.length} 份摘要缺少 ${FACT_SECTION_TITLES.join("/")} 标题段，已跳过: ${skippedSessionIds.join(", ")}`);
  }

  const nextWatermark = latestSummaryUpdate(sessions);
  if (factParts.length === 0) {
    if (nextWatermark) writeEditableFactsState(statePath, nextWatermark);
    return "compiled";
  }

  const prevFacts = normalizeCompiledSectionBody(safeReadFile(outputPath, ""));
  const newFacts = factParts.join("\n");
  const isZh = _isZh();
  const combined = prevFacts
    ? (isZh
        ? `## 当前可信 Facts\n\n${prevFacts}\n\n## 新增候选 Facts\n\n${newFacts}`
        : `## Current Trusted Facts\n\n${prevFacts}\n\n## New Candidate Facts\n\n${newFacts}`)
    : (isZh
        ? `## 新增候选 Facts\n\n${newFacts}`
        : `## New Candidate Facts\n\n${newFacts}`);
  const result = await _compactLLM(
    combined,
    buildCompileEditableFactsPrompt(getLocale()),
    resolvedModel,
    300,
    "compile_editable_facts",
  );

  atomicWrite(outputPath, normalizeCompiledLLMResult(result, "compileEditableFacts"));
  if (nextWatermark) writeEditableFactsState(statePath, nextWatermark);
  return "compiled";
}

/**
 * 将四个中间文件组装成 memory.md（同步，不调 LLM）
 * @param {string} factsPath
 * @param {string} todayPath
 * @param {string} weekPath
 * @param {string} longtermPath
 * @param {string} memoryMdPath
 */
export function assemble(factsPath, todayPath, weekPath, longtermPath, memoryMdPath) {
  const read = (p) => { try { return fs.readFileSync(p, "utf-8").trim(); } catch { return ""; } };

  const facts    = normalizeCompiledSectionBody(read(factsPath));
  const today    = normalizeCompiledSectionBody(read(todayPath));
  const week     = normalizeCompiledSectionBody(read(weekPath));
  const longterm = normalizeCompiledSectionBody(read(longtermPath));

  atomicWrite(memoryMdPath, buildCompiledMemoryMarkdown({ facts, today, week, longterm }));
}

export function buildCompiledMemoryMarkdown({ facts = "", today = "", week = "", longterm = "" } = {}) {
  // 四个标题始终保留，空栏写占位符，避免格式漂移
  const isZh = _isZh();
  const empty = isZh ? "（暂无）" : "(none)";
  const section = (title, content) =>
    `## ${title}\n\n${normalizeCompiledSectionBody(content) || empty}`;

  return [
    section(isZh ? "重要事实" : "Key facts", facts),
    section(isZh ? "今天" : "Today", today),
    section(isZh ? "本周早些时候" : "Earlier this week", week),
    section(isZh ? "长期情况" : "Long-term context", longterm),
  ].join("\n\n") + "\n";
}

/**
 * 通用 LLM 压缩调用（内部）
 * @param {string} input
 * @param {string} systemPrompt
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @param {number} maxTokens
 */
async function _compactLLM(input, systemPrompt, resolvedModel, maxTokens, operation) {
  const { model, api, api_key, base_url } = resolvedModel;
  const fallbackPromptSpec = {
    systemPrompt,
    templateVersion: `${operation || "compile"}.v1`,
    cacheGroup: `memory.${operation || "compile"}`,
  };
  const promptSpec = typeof systemPrompt === "object" && systemPrompt !== null
    ? systemPrompt
    : _compilePromptSpecForOperation(operation, systemPrompt) || fallbackPromptSpec;
  const layout = buildUtilityPromptLayout({
    cacheGroup: promptSpec.cacheGroup,
    templateVersion: promptSpec.templateVersion,
    systemPrompt: promptSpec.systemPrompt,
    userContent: input,
  });
  const usageContext = attachPromptLayoutMetadata({
    source: {
      subsystem: "memory",
      operation: operation || "compile",
      surface: "system",
      trigger: "daily",
    },
    attribution: {
      kind: "memory",
      agentId: resolvedModel.usageAgentId || null,
    },
  }, layout.usageMetadata);
  return callText({
    api, model,
    apiKey: api_key,
    baseUrl: base_url,
    headers: undefined,
    messages: layout.messages,
    systemPrompt: layout.systemPrompt,
    temperature: 0.3,
    maxTokens: withMemoryReasoningBuffer(maxTokens, resolvedModel),
    timeoutMs: 60_000,
    signal: undefined,
    usageLedger: resolvedModel.usageLedger,
    usageContext,
  });
}

function _compilePromptSpecForOperation(operation, systemPrompt) {
  const builder = COMPILE_PROMPT_BUILDERS[operation];
  if (!builder) return null;
  const promptSpec = builder(getLocale());
  return promptSpec.systemPrompt === systemPrompt ? promptSpec : null;
}

// ════════════════════════════
//  辅助
// ════════════════════════════

function computeFingerprint(keys) {
  return crypto.createHash("md5").update(keys.join("\n")).digest("hex");
}

function atomicWrite(filePath, content) {
  atomicWriteSync(filePath, content);
}

function readEditableFactsState(statePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const value = raw?.lastCompiledSummaryUpdatedAt;
    return {
      lastCompiledSummaryUpdatedAt: value && !Number.isNaN(Date.parse(value)) ? value : null,
    };
  } catch {
    return { lastCompiledSummaryUpdatedAt: null };
  }
}

function writeEditableFactsState(statePath, lastCompiledSummaryUpdatedAt) {
  if (!lastCompiledSummaryUpdatedAt || Number.isNaN(Date.parse(lastCompiledSummaryUpdatedAt))) return;
  atomicWrite(statePath, JSON.stringify({
    lastCompiledSummaryUpdatedAt,
    updatedAt: new Date().toISOString(),
  }, null, 2) + "\n");
}

function getAllSummariesForFacts(summaryManager) {
  if (!summaryManager) return [];
  if (typeof summaryManager.getAllSummaries === "function") {
    return summaryManager.getAllSummaries().filter((s) => s?.summary);
  }
  if (typeof summaryManager.getSummariesInRange === "function") {
    return summaryManager.getSummariesInRange(new Date(0), new Date()).filter((s) => s?.summary);
  }
  return [];
}

function latestSummaryUpdate(summaries) {
  return (summaries || [])
    .map((s) => s?.updated_at || s?.created_at || "")
    .filter((value) => value && !Number.isNaN(Date.parse(value)))
    .sort()
    .at(-1) || null;
}

function latestIso(a, b) {
  const values = [a, b]
    .filter((value) => value && !Number.isNaN(Date.parse(value)))
    .sort();
  return values.at(-1) || null;
}
