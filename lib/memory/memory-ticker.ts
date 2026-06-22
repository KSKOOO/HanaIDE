/**
 * memory-ticker.js — 记忆调度器（v3）
 *
 * 触发机制改为 turn-based：
 * - 每 10 轮：滚动摘要 + compileToday + assemble
 * - session 结束：final 滚动摘要 + compileToday + assemble
 * - 每天一次（日期变化时触发）：compileWeek + compileLongterm + compileFacts + assemble + deep-memory
 *
 * session 关闭记忆时，整条记忆流水线都应跳过，避免被写入 summary/facts。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { debugLog, createModuleLogger } from "../debug-log.ts";
import {
  compileToday,
  compileWeek,
  compileLongterm,
  compileFacts,
  compileEditableFacts,
  assemble,
  editableFactsPath,
  ensureEditableFactsBaseline,
} from "./compile.ts";
import { processDirtySessions } from "./deep-memory.ts";
import { getLogicalDay } from "../time-utils.ts";
import { readCompiledResetAt } from "./compiled-memory-state.ts";
import { listSessionFiles, readSessionMessages, sessionIdFromFilename } from "../session-jsonl.ts";
import { isAgentPhoneSessionPath } from "../conversations/agent-phone-session.ts";
import { buildSourceTimeRange } from "./time-context.ts";
import { writeCacheSnapshotObservation } from "./cache-snapshot-observation.ts";
import { runMemoryReflection as defaultRunMemoryReflection } from "./memory-reflection-runner.ts";
import { validateRollingSummaryFormat } from "./rolling-summary-format.ts";
import { CACHE_STRATEGIES } from "../llm/cache-strategy-contract.ts";

const log = createModuleLogger("memory-ticker");

const TURNS_PER_SUMMARY = 10;   // 每隔多少轮触发一次滚动摘要
const CACHE_SNAPSHOT_REFLECTION_MODES = new Set(["shadow", "write"]);
const CACHE_SNAPSHOT_PREVIEW_LIMIT = 16_000;

// ── 主调度器 ──

/**
 * 创建 v3 记忆调度器
 *
 * @param {object} opts
 * @param {import('./session-summary.ts').SessionSummaryManager} opts.summaryManager
 * @param {string} opts.configPath
 * @param {import('./fact-store.ts').FactStore} opts.factStore
 * @param {function} opts.getResolvedMemoryModel - 返回预解析的 { model, provider, api, api_key, base_url }
 * @param {function} [opts.onCompiled] - memory.md 更新后的回调
 * @param {string} opts.sessionDir
 * @param {string} opts.memoryMdPath
 * @param {string} opts.todayMdPath
 * @param {string} opts.weekMdPath
 * @param {string} opts.longtermMdPath
 * @param {string} opts.factsMdPath
 * @param {function} [opts.getMemoryMasterEnabled] - 返回 agent 级别记忆总开关状态
 * @param {(sessionPath: string) => boolean} [opts.isSessionMemoryEnabled] - 返回指定 session 的记忆状态
 * @param {function} [opts.getTimezone] - 返回用户配置时区
 * @param {function} [opts.getCacheSnapshotReflectionMode] - 返回 off / shadow / write
   * @param {function} [opts.getEditableMemoryEnabled] - 返回可编辑 Facts 实验开关
 * @param {(sessionPath: string) => object|null} [opts.readMemoryReflectionSnapshot] - 返回 session 创建时冻结的记忆反思快照
 * @param {string} [opts.agentId] - 当前 agent id，用于实验观察产物归属
 * @param {string} [opts.agentDir] - 当前 agent 数据目录，用于实验观察产物落盘
 */
export function createMemoryTicker(opts) {
  const {
    agentId,
    agentDir,
    summaryManager,
    factStore,
    getResolvedMemoryModel,
    onCompiled,
    sessionDir,
    memoryMdPath,
    todayMdPath,
    weekMdPath,
    longtermMdPath,
    factsMdPath,
    getMemoryMasterEnabled,
    isSessionMemoryEnabled,
    getTimezone,
    getCacheSnapshotReflectionMode,
    getEditableMemoryEnabled,
    readMemoryReflectionSnapshot,
    memoryReflectionRunner,
    buildSessionCacheSnapshot,
    ensureSessionLoaded,
    getSessionStreamFn,
    getSessionIdForPath,
    memoryDir = path.dirname(memoryMdPath),
  } = opts;
  const _memoryReflectionRunner = memoryReflectionRunner || { runMemoryReflection: defaultRunMemoryReflection };

  /** agent 级总开关 */
  const _isMemoryMasterOn = () => !getMemoryMasterEnabled || getMemoryMasterEnabled();
  /** 指定 session 是否允许进入记忆流水线 */
  const _isSessionMemoryOn = (sessionPath) =>
    !isAgentPhoneSessionPath(sessionPath)
    && _isMemoryMasterOn()
    && (!isSessionMemoryEnabled || isSessionMemoryEnabled(sessionPath));
  const _getCompiledResetAt = () => readCompiledResetAt(memoryDir);
  const _getTimezone = () => getTimezone?.() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const _sessionIdentityForPath = (sessionPath) => {
    try {
      const sessionId = getSessionIdForPath?.(sessionPath);
      if (typeof sessionId === "string" && sessionId.trim()) return sessionId.trim();
    } catch {}
    return sessionIdFromFilename(path.basename(sessionPath));
  };
  const _getCacheSnapshotReflectionMode = () => {
    const mode = String(getCacheSnapshotReflectionMode?.() || "off");
    return CACHE_SNAPSHOT_REFLECTION_MODES.has(mode) ? mode : "off";
  };
  const _isEditableMemoryOn = () => getEditableMemoryEnabled?.() === true;
  const _factsSourcePath = () => {
    if (!_isEditableMemoryOn()) return factsMdPath;
    ensureEditableFactsBaseline(memoryDir, summaryManager, {
      seedFactsPath: factsMdPath,
    });
    return editableFactsPath(memoryDir);
  };
  const _createSourceTimeRangeResolver = () => {
    const filesById = new Map(
      listSessionFiles(sessionDir).map((entry) => [_sessionIdentityForPath(entry.filePath), entry.filePath]),
    );
    return (sessionId) => {
      const filePath = filesById.get(sessionId);
      if (!filePath) return null;
      const { messages } = readSessionMessages(filePath);
      return buildSourceTimeRange(messages, { timeZone: _getTimezone() });
    };
  };
  const _readMemoryReflectionSnapshot = (sessionPath) => {
    try {
      const snapshot = readMemoryReflectionSnapshot?.(sessionPath);
      return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? snapshot
        : null;
    } catch {
      return null;
    }
  };

  // 每小时检查日期变化（备用触发，主触发是 notifyTurn）
  const DAILY_CHECK_INTERVAL = 60 * 60 * 1000;

  let _timer = null;
  let _tickInFlight = null;
  let _stopped = false;
  const _activeJobs = new Set();
  let _dailyRunning = false;
  let _lastDailyJobDate = null;
  let _dailyStepsDate = null;               // 当天已完成步骤所属日期
  const _dailyStepsCompleted = new Set();    // 当天已完成的步骤名（断点续跑）
  const _turnCounts = new Map();             // stable session identity → turn count
  const _summaryInProgress = new Set();      // 正在跑滚动摘要的 session

  // ── 错误 dedup：相同根因（如凭证持续无效）只在 console 打一次，避免每轮对话都刷屏 ──
  let _lastErrorSig = null;
  function _logStepError(label, err) {
    const msg = err?.message || String(err);
    const sig = `${label}|${msg}`;
    if (sig === _lastErrorSig) {
      // 同一根因重复 → 只写 debug 文件，不打 console
      debugLog()?.error("memory", `${label} (dup suppressed): ${msg}`);
      return;
    }
    _lastErrorSig = sig;
    log.error(`${label} 失败: ${msg}`);
    debugLog()?.error("memory", `${label} failed: ${msg}`);
  }
  function _markStepRecovered(label) {
    if (!_lastErrorSig) return;
    const prev = _lastErrorSig;
    _lastErrorSig = null;
    log.log(`${label} 恢复正常（之前: ${prev}）`);
    debugLog()?.log("memory", `${label} recovered (was: ${prev})`);
  }

  // ── 步骤健康状态：每步独立记录，方便 UI 层 / healthz 接口读取 ──
  // 注意：failCount 只在连续失败时递增，一次成功立即清零
  const _stepKeys = ["rollingSummary", "cacheSnapshotReflection", "compileToday", "compileWeek", "compileLongterm", "compileFacts", "deepMemory"];
  const _health = {};
  for (const k of _stepKeys) {
    _health[k] = { lastSuccessAt: null, lastErrorAt: null, lastErrorMsg: null, failCount: 0 };
  }
  function _markSuccess(stepKey) {
    const h = _health[stepKey];
    if (!h) return;
    h.lastSuccessAt = new Date().toISOString();
    h.lastErrorAt = null;
    h.lastErrorMsg = null;
    h.failCount = 0;
  }
  function _markFailure(stepKey, err) {
    const h = _health[stepKey];
    if (!h) return;
    h.lastErrorAt = new Date().toISOString();
    h.lastErrorMsg = err?.message || String(err);
    h.failCount += 1;
  }

  function _trackJob(promise) {
    _activeJobs.add(promise);
    promise.then(() => {
      _activeJobs.delete(promise);
    }, () => {
      _activeJobs.delete(promise);
    });
    return promise;
  }

  // ── 内部：滚动摘要 ──

  function _textPreview(text) {
    const value = String(text || "");
    return value.length > CACHE_SNAPSHOT_PREVIEW_LIMIT
      ? value.slice(0, CACHE_SNAPSHOT_PREVIEW_LIMIT)
      : value;
  }

  function _sha256(text) {
    if (!text) return "";
    return crypto.createHash("sha256").update(String(text)).digest("hex");
  }

  function _readMemoryMdPreview() {
    try {
      return _textPreview(fs.readFileSync(memoryMdPath, "utf-8"));
    } catch (err) {
      if (err?.code === "ENOENT") return "";
      throw err;
    }
  }

  function _firstNumber(...values) {
    for (const value of values) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }

  function _observationUsage(usage, resolvedModel, latencyMs) {
    return {
      model: String(resolvedModel?.model?.id || resolvedModel?.id || resolvedModel?.model || ""),
      cachedTokens: _firstNumber(
        usage?.cachedTokens,
        usage?.cacheReadTokens,
        usage?.cache?.readTokens,
      ),
      missTokens: _firstNumber(
        usage?.missTokens,
        usage?.cacheMissTokens,
        usage?.cache?.missTokens,
        usage?.input?.uncachedTokens,
      ),
      latencyMs,
    };
  }

  function _requestModelDiagnostics(model) {
    if (!model || typeof model !== "object" || Array.isArray(model)) return null;
    return {
      id: String(model.id || model.model || ""),
      provider: String(model.provider || ""),
      api: String(model.api || ""),
      hasBaseUrl: Boolean(model.baseUrl || model.base_url),
      hasQuirks: Array.isArray(model.quirks),
    };
  }

  function _errorDiagnostics(err, requestModel) {
    return {
      errorName: String(err?.name || ""),
      stack: typeof err?.stack === "string" ? err.stack.split("\n").slice(0, 4) : [],
      requestModel: _requestModelDiagnostics(requestModel),
    };
  }

  function _isRecoverableSessionSnapshotUnavailable(err) {
    const message = String(err?.message || err || "");
    if (/session cache snapshot unavailable/i.test(message)) return true;
    return /snapshot/i.test(message) && /unknown session/i.test(message);
  }

  async function _buildSessionCacheSnapshotWithRecovery(sessionPath, options) {
    try {
      return buildSessionCacheSnapshot(sessionPath, options);
    } catch (err) {
      if (!_isRecoverableSessionSnapshotUnavailable(err) || typeof ensureSessionLoaded !== "function") {
        throw err;
      }
      debugLog()?.warn?.(
        "memory",
        `cache snapshot runtime missing for ${path.basename(sessionPath)}; loading session before retry`,
      );
      try {
        await ensureSessionLoaded(sessionPath);
        return buildSessionCacheSnapshot(sessionPath, options);
      } catch (retryErr) {
        if (_isRecoverableSessionSnapshotUnavailable(retryErr)) throw retryErr;
        const wrapped: any = new Error(`Session cache snapshot unavailable after runtime recovery: ${retryErr?.message || retryErr}`);
        wrapped.cause = retryErr;
        throw wrapped;
      }
    }
  }

  async function _runSessionSnapshotMemoryReflection({
    sessionPath,
    sessionId,
    messages,
    resolvedModel,
    rollingOptions,
    mode,
    trigger,
  }) {
    const startedAt = Date.now();
    let baseMemoryMd = "";
    let requestModel = null;
    try {
      baseMemoryMd = _readMemoryMdPreview();
    } catch (err) {
      debugLog()?.error("memory", `cache snapshot memory.md preview failed: ${err?.message || err}`);
    }
    try {
      if (!agentDir) {
        throw new Error("agentDir is required for cache snapshot reflection observation");
      }
      if (typeof _memoryReflectionRunner.runMemoryReflection !== "function") {
        throw new Error("memoryReflectionRunner.runMemoryReflection is required for session snapshot reflection");
      }
      if (typeof buildSessionCacheSnapshot !== "function") {
        throw new Error("buildSessionCacheSnapshot is required for session snapshot reflection");
      }

      const snapshot = await _buildSessionCacheSnapshotWithRecovery(sessionPath, {
        reason: "memory.reflection",
        messages,
      });
      const previousSummary = summaryManager.getSummary?.(sessionId)?.summary || "";
      requestModel = snapshot.requestModel || snapshot.model || resolvedModel?.model || resolvedModel;
      const reflection = await _memoryReflectionRunner.runMemoryReflection({
        snapshot,
        model: requestModel,
        cacheKeyParams: snapshot.cacheKeyParams || {},
        previousSummary,
        sessionId,
        messages,
        sourceTimeRange: buildSourceTimeRange(messages, { timeZone: rollingOptions.timeZone }),
        timeZone: rollingOptions.timeZone,
        streamFn: getSessionStreamFn?.(sessionPath),
        options: {
          ...(snapshot.cacheKeyParams?.thinkingLevel && snapshot.cacheKeyParams.thinkingLevel !== "off"
            ? { reasoning: snapshot.cacheKeyParams.thinkingLevel }
            : {}),
          toolChoice: "none",
        },
        usageLedger: resolvedModel?.usageLedger,
        usageContext: {
          source: {
            subsystem: "memory",
            operation: "cache_snapshot_reflection",
            surface: "system",
            trigger,
          },
          attribution: {
            kind: "memory",
            agentId: agentId || resolvedModel?.usageAgentId || null,
          },
        },
      });
      const metadata = reflection?.metadata || {};
      const strictSessionSnapshot = metadata.cacheStrategy === CACHE_STRATEGIES.SESSION_SNAPSHOT && metadata.strict === true;

      if (!strictSessionSnapshot) {
        const err: any = new Error("Cache snapshot memory write requires a strict session_snapshot result");
        err.cacheMetadata = metadata;
        throw err;
      }

      if (mode === "write" && reflection?.data) {
        // 写入前结构校验（#1628）：reflection runner 是可注入依赖，落盘边界
        // 不信任上游；不满足 compileFacts 提取假设的摘要禁止覆盖旧摘要。
        const formatValidation = validateRollingSummaryFormat(String(reflection.data.summary || ""));
        if (!formatValidation.ok) {
          const err: any = new Error(
            `cache snapshot reflection summary violates the rolling summary format: ${formatValidation.issues.join("; ")}`,
          );
          err.cacheMetadata = metadata;
          throw err;
        }
        summaryManager.saveSummary(sessionId, reflection.data);
      }

      const observation = writeCacheSnapshotObservation(agentDir, {
        agentId: agentId || resolvedModel?.usageAgentId || path.basename(agentDir),
        sessionPath,
        trigger,
        mode,
        status: "success",
        reason: reflection?.reason || "",
        usage: _observationUsage(reflection?.usage, requestModel, Date.now() - startedAt),
        summaryPreview: _textPreview(reflection?.summary || ""),
        memoryMdPreview: baseMemoryMd,
        baseMemoryMdHash: _sha256(baseMemoryMd),
        cacheStrategy: metadata.cacheStrategy,
        strict: metadata.strict === true,
        cachePrefixHash: metadata.cachePrefixHash || "",
        parentCachePrefixHash: metadata.parentCachePrefixHash || "",
        contractDiffs: metadata.contractDiffs || [],
        degradeReason: metadata.degradeReason || "",
      });
      _markSuccess("cacheSnapshotReflection");
      return observation.summaryPreview;
    } catch (err) {
      const metadata = err?.cacheMetadata || {};
      _markFailure("cacheSnapshotReflection", err);
      if (err?.stack) {
        debugLog()?.error("memory", `cache snapshot reflection stack: ${err.stack}`);
      }
      try {
        if (agentDir) {
          writeCacheSnapshotObservation(agentDir, {
            agentId: agentId || resolvedModel?.usageAgentId || path.basename(agentDir),
            sessionPath,
            trigger,
            mode,
            status: "failed",
            reason: err?.message || String(err),
            usage: _observationUsage(null, resolvedModel, Date.now() - startedAt),
            summaryPreview: "",
            memoryMdPreview: baseMemoryMd,
            baseMemoryMdHash: _sha256(baseMemoryMd),
            cacheStrategy: metadata.cacheStrategy || CACHE_STRATEGIES.CACHE_RECOVERY,
            strict: metadata.strict === true,
            cachePrefixHash: metadata.cachePrefixHash || "",
            parentCachePrefixHash: metadata.parentCachePrefixHash || "",
            contractDiffs: metadata.contractDiffs || [],
            degradeReason: metadata.degradeReason || err?.message || String(err),
            diagnostics: _errorDiagnostics(err, requestModel),
          });
        }
      } catch (writeErr) {
        debugLog()?.error("memory", `cache snapshot observation write failed: ${writeErr?.message || writeErr}`);
      }
      _logStepError(`cache snapshot reflection (${path.basename(sessionPath)})`, err);
      if (mode === "write") throw err;
      return "";
    }
  }

  async function _doRollingSummary(sessionPath, trigger = "threshold") {
    const sessionId = _sessionIdentityForPath(sessionPath);
    if (_summaryInProgress.has(sessionId)) return; // 并发保护
    _summaryInProgress.add(sessionId);
    try {
      const resetAt = _getCompiledResetAt();
      const { messages } = readSessionMessages(sessionPath, { since: resetAt });
      if (messages.length === 0) return;

      const rollingOptions: { resetAt: any; timeZone: string; memoryReflectionSnapshot?: any } = {
        resetAt,
        timeZone: _getTimezone(),
      };
      const memoryReflectionSnapshot = _readMemoryReflectionSnapshot(sessionPath);
      if (memoryReflectionSnapshot) {
        rollingOptions.memoryReflectionSnapshot = memoryReflectionSnapshot;
      }
      const resolvedModel = getResolvedMemoryModel();
      const cacheSnapshotMode = _getCacheSnapshotReflectionMode();
      if (cacheSnapshotMode === "write") {
        try {
          await _runSessionSnapshotMemoryReflection({
            sessionPath,
            sessionId,
            messages,
            resolvedModel,
            rollingOptions,
            mode: "write",
            trigger,
          });
        } catch (err) {
          if (!_isRecoverableSessionSnapshotUnavailable(err)) throw err;
          debugLog()?.warn?.(
            "memory",
            `cache snapshot unavailable for ${path.basename(sessionPath)}; falling back to rolling summary`,
          );
          await summaryManager.rollingSummary(sessionId, messages, resolvedModel, rollingOptions);
        }
      } else {
        await summaryManager.rollingSummary(sessionId, messages, resolvedModel, rollingOptions);
        if (cacheSnapshotMode === "shadow") {
          await _runSessionSnapshotMemoryReflection({
            sessionPath,
            sessionId,
            messages,
            resolvedModel,
            rollingOptions,
            mode: "shadow",
            trigger,
          });
        }
      }
      debugLog()?.log("memory", `rolling summary updated: ${sessionId.slice(0, 8)}...`);
      _markSuccess("rollingSummary");
      _markStepRecovered("滚动摘要");
    } catch (err) {
      _markFailure("rollingSummary", err);
      _logStepError(`滚动摘要 (${path.basename(sessionPath)})`, err);
      if (trigger === "manual" && _getCacheSnapshotReflectionMode() === "write") {
        throw err;
      }
    } finally {
      _summaryInProgress.delete(sessionId);
    }
  }

  // ── 内部：今天编译 + 组装 ──

  async function _doCompileTodayAndAssemble() {
    try {
      const resetAt = _getCompiledResetAt();
      await compileToday(summaryManager, todayMdPath, getResolvedMemoryModel(), { since: resetAt });
      assemble(_factsSourcePath(), todayMdPath, weekMdPath, longtermMdPath, memoryMdPath);
      onCompiled?.();
      debugLog()?.log("memory", "today compiled + assembled");
      _markSuccess("compileToday");
      _markStepRecovered("compileToday");
    } catch (err) {
      _markFailure("compileToday", err);
      _logStepError("compileToday", err);
    }
  }

  // ── 内部：每日任务 ──

  async function _doDaily() {
    if (_dailyRunning) return;
    _dailyRunning = true;
    try {
      const todayStr = getLogicalDay().logicalDate;
      const resetAt = _getCompiledResetAt();

      // 日期变化时重置步骤跟踪
      if (_dailyStepsDate !== todayStr) {
        _dailyStepsCompleted.clear();
        _dailyStepsDate = todayStr;
      }

      log.log(`每日任务开始 (${todayStr})`);
      let hasFailed = false;

      // Step 0: compileToday（日期切换后刷新 today.md，新一天无 session 时会清空）
      if (!_dailyStepsCompleted.has("compileToday")) {
        try {
          await compileToday(summaryManager, todayMdPath, getResolvedMemoryModel(), { since: resetAt });
          _dailyStepsCompleted.add("compileToday");
          _markSuccess("compileToday");
          _markStepRecovered("compileToday(daily)");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileToday", err);
          _logStepError("compileToday(daily)", err);
        }
      }

      // Step 1: compileWeek
      if (!_dailyStepsCompleted.has("compileWeek")) {
        try {
          await compileWeek(summaryManager, weekMdPath, getResolvedMemoryModel(), { since: resetAt });
          _dailyStepsCompleted.add("compileWeek");
          _markSuccess("compileWeek");
          _markStepRecovered("compileWeek");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileWeek", err);
          _logStepError("compileWeek", err);
        }
      }

      // Step 2: compileLongterm（依赖 compileWeek 产出的 week.md，必须等 compileWeek 完成）
      if (!_dailyStepsCompleted.has("compileLongterm") && _dailyStepsCompleted.has("compileWeek")) {
        try {
          await compileLongterm(weekMdPath, longtermMdPath, getResolvedMemoryModel());
          _dailyStepsCompleted.add("compileLongterm");
          _markSuccess("compileLongterm");
          _markStepRecovered("compileLongterm");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileLongterm", err);
          _logStepError("compileLongterm", err);
        }
      }

      // Step 3: compileFacts（独立于 step 1-2）
      if (!_dailyStepsCompleted.has("compileFacts")) {
        try {
          if (_isEditableMemoryOn()) {
            await compileEditableFacts(summaryManager, editableFactsPath(memoryDir), getResolvedMemoryModel(), {
              since: resetAt,
              seedFactsPath: factsMdPath,
            });
          } else {
            await compileFacts(summaryManager, factsMdPath, getResolvedMemoryModel(), { since: resetAt });
          }
          _dailyStepsCompleted.add("compileFacts");
          _markSuccess("compileFacts");
          _markStepRecovered("compileFacts");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileFacts", err);
          _logStepError("compileFacts", err);
        }
      }

      // Step 4: assemble（纯文件操作，用已有的 .md 文件组装，总是执行）
      try {
        assemble(_factsSourcePath(), todayMdPath, weekMdPath, longtermMdPath, memoryMdPath);
        onCompiled?.();
      } catch (err) {
        hasFailed = true;
        log.error(`assemble 失败: ${err.message}`);
      }

      // Step 5: deep-memory（独立，更新 facts.db）
      if (!_dailyStepsCompleted.has("deepMemory")) {
        try {
          const { processed, factsAdded } = await processDirtySessions(
            summaryManager, factStore, getResolvedMemoryModel(), {
              since: resetAt,
              timeZone: _getTimezone(),
              getSourceTimeRange: _createSourceTimeRangeResolver(),
            },
          );
          _dailyStepsCompleted.add("deepMemory");
          if (processed > 0) {
            log.log(`deep-memory: ${processed} session, ${factsAdded} 条新事实`);
          }
          _markSuccess("deepMemory");
          _markStepRecovered("deep-memory");
        } catch (err) {
          hasFailed = true;
          _markFailure("deepMemory", err);
          _logStepError("deep-memory", err);
        }
      }

      if (hasFailed) {
        const done = [..._dailyStepsCompleted].join(", ");
        log.error(`每日任务部分失败，已完成: [${done}]，1 小时后重试未完成步骤`);
        debugLog()?.error("memory", `daily job partial failure, completed: [${done}]`);
      } else {
        _lastDailyJobDate = todayStr;
        log.log(`每日任务完成`);
      }
    } finally {
      _dailyRunning = false;
    }
  }

  function _checkDailyJob() {
    if (_stopped) return;
    if (!_isMemoryMasterOn()) return;
    const todayStr = getLogicalDay().logicalDate;
    if (_lastDailyJobDate !== todayStr) {
      _trackJob(_doDaily()); // 后台，不 await
    }
  }

  // ── 公开 API ──

  /**
   * 每轮对话结束后调用（由 engine.js 在 prompt() 返回后调用）
   * @param {string} sessionPath - 当前 session 的 .jsonl 文件路径
   */
  function notifyTurn(sessionPath) {
    if (_stopped) return;
    const sessionKey = _sessionIdentityForPath(sessionPath);
    const count = (_turnCounts.get(sessionKey) || 0) + 1;
    _turnCounts.set(sessionKey, count);

    const memoryOn = _isSessionMemoryOn(sessionPath);

    if (count % TURNS_PER_SUMMARY === 0 && memoryOn) {
      _trackJob(_doRollingSummary(sessionPath, "threshold")
        .then(() => _doCompileTodayAndAssemble())
        .catch(() => {}));
    }

    if (memoryOn) _checkDailyJob();
  }

  /**
   * Session 切换或 dispose 前调用（final pass）
   *
   * 设计取舍：fire-and-forget。函数立即 resolve，rollingSummary + compileToday
   * 在后台跑。这样 switchSession / closeSession 的 caller 不会被 LLM 阻塞。
   *
   * 数据可见性：memory.md 只在 `agent.buildSystemPrompt()` 时读，由 agent
   * 初始化和 onCompiled 回调刷新 `_systemPrompt` 快照。新 session 创建时拿
   * snapshot，老 session 用自己创建时的快照。所以"后台刷新"对已运行 session
   * 透明，下次新建 session 时自然吃到最新记忆。
   *
   * 代价：后台 Promise 如果抛错且进程很快退出，这个 session 末尾不满
   * TURNS_PER_SUMMARY 那几轮的 rollingSummary 会丢。兜底机制是启动时
   * `_recoverUnsummarized()` 扫 24h 内 `mtime > summary.updated_at` 的 session
   * 补跑。
   *
   * @param {string} sessionPath
   * @returns {Promise<void>} 返回后台刷新的 Promise。switch/close 场景不需要 await，
   *   直接让它后台跑；dispose 场景可以 Promise.race 上限 4s 等它尽量刷完。
   */
  function notifySessionEnd(sessionPath) {
    if (_stopped) return Promise.resolve();
    if (!sessionPath) return Promise.resolve();
    const sessionKey = _sessionIdentityForPath(sessionPath);
    const count = _turnCounts.get(sessionKey) || 0;
    _turnCounts.delete(sessionKey);
    if (count === 0) return Promise.resolve();
    if (!_isSessionMemoryOn(sessionPath)) return Promise.resolve();
    return _trackJob(_doRollingSummary(sessionPath, "session_end")
      .then(() => _doCompileTodayAndAssemble())
      .catch((err) => {
        log.error(`notifySessionEnd 后台失败: ${err.message}`);
      }));
  }

  /**
   * 启动每小时的日期检查 timer（备用触发，不依赖用户对话）
   */
  function start() {
    if (_stopped) return;
    if (_timer) return;
    _timer = setInterval(() => _checkDailyJob(), DAILY_CHECK_INTERVAL);
    if (_timer.unref) _timer.unref();
    log.log(`v3 已启动（turn-based，每日任务备用 timer 1h）`);
  }

  async function stop() {
    _stopped = true;
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    if (_tickInFlight) await _tickInFlight.catch(() => {});
    while (_activeJobs.size > 0) {
      await Promise.allSettled([..._activeJobs]);
    }
  }

  /**
   * 启动时补偿：扫描最近修改过的 session，如果 JSONL mtime > summary.updated_at，
   * 说明上次崩溃/重启前有未收尾的对话，补跑一次滚动摘要。
   * 只处理过去 24 小时内修改的文件，避免全量扫描。
   */
  async function _recoverUnsummarized() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const resetAt = _getCompiledResetAt();
    const resetMs = resetAt ? Date.parse(resetAt) : null;
    const sessions = listSessionFiles(sessionDir);
    for (const { filePath, mtime } of sessions) {
      if (mtime.getTime() < cutoff) continue;
      if (resetMs && mtime.getTime() <= resetMs) continue;
      if (!_isSessionMemoryOn(filePath)) continue;
      const sessionId = _sessionIdentityForPath(filePath);
      const existing = summaryManager.getSummary(sessionId);
      const existingSummaryAt = existing?.updated_at ? new Date(existing.updated_at).getTime() : 0;
      const summaryAt = resetMs ? Math.max(existingSummaryAt, resetMs) : existingSummaryAt;
      if (mtime.getTime() > summaryAt + 5000) { // 5s 宽限，避免极近时间戳误判
        await _doRollingSummary(filePath, "recovery");
      }
    }
  }

  /**
   * 手动触发一次完整编译（调试 / 启动时用）
   * 先跑 daily job（确保 week/facts/longterm.md 存在），再 compileToday + assemble
   */
  async function tick() {
    if (_stopped) return;
    const p = _tickCore();
    _tickInFlight = p;
    try { await p; } finally { if (_tickInFlight === p) _tickInFlight = null; }
  }

  async function _tickCore() {
    if (!_isMemoryMasterOn()) return;
    await _recoverUnsummarized(); // 补偿崩溃/重启前未收尾的 session
    const todayStr = getLogicalDay().logicalDate;
    if (_lastDailyJobDate !== todayStr) {
      await _doDaily(); // 启动时 await，确保中间文件就绪后再 assemble
    }
    await _doCompileTodayAndAssemble();
  }

  /**
   * 手动触发（兼容旧调用）
   */
  function triggerNow() {
    if (_stopped) return;
    tick().catch(() => {});
  }

  /**
   * Session promote 后调用（心跳/cron session 从 activity/ 移到 sessions/ 后）
   * executeIsolated 不调 notifyTurn，所以需要显式补一次滚动摘要。
   * @param {string} sessionPath - promote 后的新 session 文件路径
   */
  async function notifyPromoted(sessionPath) {
    if (_stopped) return;
    if (!sessionPath) return;
    if (!_isSessionMemoryOn(sessionPath)) return;
    try {
      await _doRollingSummary(sessionPath, "promoted");
      await _doCompileTodayAndAssemble();
      debugLog()?.log("memory", `promoted session summarized: ${path.basename(sessionPath).slice(0, 20)}...`);
    } catch (err) {
      log.error(`notifyPromoted 失败: ${err.message}`);
    }
    // 注册 turn count = 1，后续 notifySessionEnd 不会因 count===0 跳过
    _turnCounts.set(_sessionIdentityForPath(sessionPath), 1);
  }

  /**
   * 强制刷新指定 session 的摘要（日记等功能调用前确保摘要最新）
   * @param {string} sessionPath
   */
  async function flushSession(sessionPath) {
    if (_stopped) return;
    if (!sessionPath) return;
    if (!_isSessionMemoryOn(sessionPath)) return;
    await _doRollingSummary(sessionPath, "manual");
  }

  /**
   * 强制刷新指定 session 的摘要并立刻汇编 memory.md。
   * 用于没有“退出焦点”语义的外部长会话：平时按轮次滚动，日结维护前补齐未满
   * TURNS_PER_SUMMARY 的尾巴，再让 fresh compact 吃到最新系统 prompt。
   *
   * @param {string} sessionPath
   */
  async function flushSessionAndCompile(sessionPath) {
    if (_stopped) return;
    if (!sessionPath) return;
    if (!_isSessionMemoryOn(sessionPath)) return;
    await _doRollingSummary(sessionPath, "manual");
    await _doCompileTodayAndAssemble();
    _turnCounts.delete(_sessionIdentityForPath(sessionPath));
  }

  /**
   * 返回每个编译步骤的健康状态快照（深拷贝，调用方安全持有）
   * @returns {Record<string, { lastSuccessAt: string|null, lastErrorAt: string|null, lastErrorMsg: string|null, failCount: number }>}
   */
  function getHealthStatus() {
    const snapshot = {};
    for (const k of _stepKeys) snapshot[k] = { ..._health[k] };
    return snapshot;
  }

  return { start, stop, tick, triggerNow, notifyTurn, notifySessionEnd, notifyPromoted, flushSession, flushSessionAndCompile, getHealthStatus };
}
