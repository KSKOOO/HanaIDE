/**
 * cron-store.js — 定时任务存储
 *
 * 管理 cron job 的 CRUD 和运行历史。
 * 调度逻辑在 cron-scheduler.js，这里只负责持久化。
 *
 * 参考 OpenClaw：jobs.json + runs/<jobId>.jsonl
 *
 * Job 类型：
 * - "at"：一次性任务（schedule = ISO 时间字符串）
 * - "every"：间隔任务（schedule = 毫秒数，如 3600000 = 1小时）
 * - "cron"：标准 cron 表达式（schedule = "0 7 * * *"）
 */

import fs from "fs";
import path from "path";
import { normalizeAutomationJob, normalizeAutomationJobs } from "./automation-normalizer.ts";
import { parseModelRef } from "../../shared/model-ref.ts";
import { atomicWriteSync } from "../../shared/safe-fs.ts";
import { createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("cron-store");

export function normalizeCronModelRef(model) {
  const parsed = parseModelRef(model);
  if (!parsed?.id) return "";
  if (parsed.provider) return { id: parsed.id, provider: parsed.provider };
  return parsed.id;
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.parse(JSON.stringify(value));
}

function deriveJobLabel({ label, prompt, executor }) {
  if (typeof label === "string" && label.trim()) return label;
  if (typeof prompt === "string" && prompt.trim()) return prompt.slice(0, 30);
  const params = executor && typeof executor === "object" && !Array.isArray(executor)
    ? executor.params
    : null;
  if (typeof params?.title === "string" && params.title.trim()) return params.title.slice(0, 30);
  return "";
}

function validateAutomationExecutorForWrite(executor) {
  if (!executor) return;
  if (!executor.kind || executor.kind === "agent_session") return;
  throw new Error(`unsupported automation executor: ${executor.kind}`);
}

function isAgentSessionAutomation(job) {
  const normalized = normalizeAutomationJob(job);
  return !normalized.executor || normalized.executor.kind === "agent_session";
}

function assertCanEnableAutomationJob(job) {
  if (!job?.enabled) return;
  if (!isAgentSessionAutomation(job)) return;
  if (typeof job.prompt === "string" && job.prompt.trim()) return;
  throw new Error("prompt required to enable agent automation");
}

export class CronStore {
  declare _idPrefix: any;
  declare _jobs: any;
  declare _jobsPath: any;
  declare _nextNum: any;
  declare _runsDir: any;
  /** 退避表（毫秒）：0/1m/5m/15m/60m */
  static BACKOFF = [0, 60_000, 300_000, 900_000, 3_600_000];

  /**
   * @param {string} jobsPath - cron-jobs.json 路径
   * @param {string} runsDir  - cron-runs/ 目录路径
   */
  constructor(jobsPath, runsDir, options: any = {}) {
    this._jobsPath = jobsPath;
    this._runsDir = runsDir;
    this._idPrefix = options.idPrefix || "job";
    this._jobs = [];
    this._nextNum = 1;
    this._load();
  }

  // ════════════════════════════
  //  持久化
  // ════════════════════════════

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this._jobsPath, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") {
        // 首次启动，文件不存在，静默处理
        this._jobs = [];
        this._nextNum = 1;
        return;
      }
      log.error(`读取 jobs 文件失败: ${err.message}`);
      this._jobs = [];
      this._nextNum = 1;
      return;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // JSON 损坏，尝试从 .tmp 恢复
      const tmpPath = this._jobsPath + ".tmp";
      try {
        const tmpRaw = fs.readFileSync(tmpPath, "utf-8");
        data = JSON.parse(tmpRaw);
        log.error("主文件 JSON 损坏，已从 .tmp 恢复");
      } catch {
        log.error("JSON 解析失败且无可用 .tmp，重置为空");
        this._jobs = [];
        this._nextNum = 1;
        return;
      }
    }

    this._jobs = Array.isArray(data.jobs) ? data.jobs : [];
    this._nextNum = data.nextNum ?? (this._jobs.length + 1);

    // 旧数据清洗
    let dirty = false;
    for (const job of this._jobs) {
      // model 统一规范：默认模型为空串；显式模型保留 {id, provider} 复合键。
      const normalizedModel = normalizeCronModelRef(job.model);
      if (JSON.stringify(job.model ?? "") !== JSON.stringify(normalizedModel)) {
        job.model = normalizedModel;
        dirty = true;
      }
      // every 类型最小间隔 clamp
      if (job.type === "every" && typeof job.schedule === "number" && job.schedule < 60000) {
        job.schedule = 60000;
        dirty = true;
      }
      // consecutiveErrors 缺失补 0
      if (job.consecutiveErrors === undefined) {
        job.consecutiveErrors = 0;
        dirty = true;
      }
    }
    const normalizedJobs = normalizeAutomationJobs(this._jobs);
    if (JSON.stringify(this._jobs) !== JSON.stringify(normalizedJobs)) {
      dirty = true;
    }
    this._jobs = normalizedJobs;

    if (dirty) {
      this._save();
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this._jobsPath), { recursive: true });
    const data = JSON.stringify({
      jobs: this._jobs,
      nextNum: this._nextNum,
    }, null, 2) + "\n";
    // atomic write: tmp + rename，防止写到一半崩溃损坏文件
    atomicWriteSync(this._jobsPath, data);
  }

  // ════════════════════════════
  //  Job CRUD
  // ════════════════════════════

  /**
   * 添加任务
   * @param {object} opts
   * @param {"at"|"every"|"cron"} opts.type - 调度类型
   * @param {string|number} opts.schedule - 调度参数
   * @param {string} opts.prompt - 执行时的 prompt
   * @param {string} [opts.mode="isolated"] - 执行模式
   * @param {string} [opts.label] - 显示标签
   * @param {string} [opts.model] - 指定模型（为空则用 agent 默认模型）
   * @returns {object} 新建的 job
   */
  addJob({
    type,
    schedule,
    prompt,
    mode = "isolated",
    label = "",
    model = "",
    actorAgentId = null,
    executionContext = null,
    legacyRef = null,
    executor = null,
    createdBy = null,
    enabled = true,
  }) {
    // type 枚举校验
    const VALID_TYPES = new Set(["at", "every", "cron"]);
    if (!VALID_TYPES.has(type)) {
      throw new Error(`无效的 job type: "${type}"，必须是 at / every / cron`);
    }

    // every 类型最小间隔 clamp
    if (type === "every") {
      const ms = typeof schedule === "number" ? schedule : parseInt(schedule, 10);
      if (ms < 60000) schedule = 60000;
    }

    // at 类型校验
    if (type === "at") {
      const target = new Date(schedule);
      if (isNaN(target.getTime())) {
        throw new Error(`无效的 at schedule: "${schedule}"，无法解析为日期`);
      }
      if (target <= new Date()) {
        throw new Error(`at schedule 已过期: "${schedule}"，必须是未来时间`);
      }
    }

    const now = new Date().toISOString();
    validateAutomationExecutorForWrite(executor);

    const job = {
      id: this._nextJobId(),
      type,
      schedule,
      prompt: typeof prompt === "string" ? prompt : "",
      mode,
      label: deriveJobLabel({ label, prompt, executor }),
      model: normalizeCronModelRef(model),
      enabled: enabled !== false,
      consecutiveErrors: 0,
      createdAt: now,
      lastRunAt: null,
      nextRunAt: this._calcNextRun(type, schedule, now),
    };
    this._attachOwnershipFields(job, { actorAgentId, executionContext, legacyRef });
    this._attachAutomationFields(job, { executor, createdBy });

    const normalized = normalizeAutomationJob(job);
    assertCanEnableAutomationJob(normalized);
    this._jobs.push(normalized);
    this._save();
    return normalized;
  }

  /**
   * 导入已存在的任务，不做 at 未来时间校验，保留运行状态与 nextRunAt。
   * @param {object} input
   * @returns {object}
   */
  addImportedJob(input) {
    const VALID_TYPES = new Set(["at", "every", "cron"]);
    const type = input?.type;
    if (!VALID_TYPES.has(type)) {
      throw new Error(`无效的 job type: "${type}"，必须是 at / every / cron`);
    }
    if (typeof input.prompt !== "string" || !input.prompt.trim()) {
      const explicitExecutor = clonePlainObject(input.executor);
      if (!explicitExecutor) throw new Error("cron import requires prompt");
    }
    validateAutomationExecutorForWrite(input.executor);

    let schedule = input.schedule;
    if (type === "every") {
      const ms = typeof schedule === "number" ? schedule : parseInt(schedule, 10);
      if (Number.isFinite(ms) && ms < 60000) schedule = 60000;
    }

    const now = new Date().toISOString();
    const job = {
      id: this._nextJobId(),
      type,
      schedule,
      prompt: typeof input.prompt === "string" ? input.prompt : "",
      mode: input.mode || "isolated",
      label: deriveJobLabel({ label: input.label, prompt: input.prompt, executor: input.executor }),
      model: normalizeCronModelRef(input.model),
      enabled: input.enabled !== false,
      consecutiveErrors: Number.isFinite(input.consecutiveErrors) ? input.consecutiveErrors : 0,
      createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
      lastRunAt: typeof input.lastRunAt === "string" ? input.lastRunAt : null,
      nextRunAt: typeof input.nextRunAt === "string" || input.nextRunAt === null
        ? input.nextRunAt
        : this._calcNextRun(type, schedule, now),
    };
    this._attachOwnershipFields(job, input);
    this._attachAutomationFields(job, input);

    const normalized = normalizeAutomationJob(job);
    this._jobs.push(normalized);
    this._save();
    return normalized;
  }

  _nextJobId() {
    return `${this._idPrefix}_${this._nextNum++}`;
  }

  _attachOwnershipFields(job, { actorAgentId = null, executionContext = null, legacyRef = null } = {}) {
    if (typeof actorAgentId === "string" && actorAgentId.trim()) {
      job.actorAgentId = actorAgentId.trim();
    }
    if (executionContext && typeof executionContext === "object" && !Array.isArray(executionContext)) {
      job.executionContext = JSON.parse(JSON.stringify(executionContext));
    }
    if (legacyRef && typeof legacyRef === "object" && !Array.isArray(legacyRef)) {
      job.legacyRef = JSON.parse(JSON.stringify(legacyRef));
    }
  }

  _attachAutomationFields(job, { executor = null, createdBy = null } = {}) {
    const normalizedExecutor = clonePlainObject(executor);
    if (normalizedExecutor) job.executor = normalizedExecutor;
    const normalizedCreatedBy = clonePlainObject(createdBy);
    if (normalizedCreatedBy) job.createdBy = normalizedCreatedBy;
  }

  /**
   * 删除任务
   * @param {string} id
   * @returns {boolean}
   */
  removeJob(id) {
    const idx = this._jobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    this._jobs.splice(idx, 1);
    this._save();
    return true;
  }

  /**
   * 获取单个任务
   * @param {string} id
   * @returns {object|null}
   */
  getJob(id) {
    const job = this._jobs.find(j => j.id === id) || null;
    return job ? normalizeAutomationJob(job) : null;
  }

  /**
   * 列出所有任务（每次从磁盘重读，确保跨实例的写入都能被感知）
   * @returns {object[]}
   */
  listJobs() {
    this._load();
    return this._jobs.map((job) => normalizeAutomationJob(job));
  }

  /**
   * 更新任务字段
   * @param {string} id
   * @param {object} partial
   * @returns {object|null}
   */
  updateJob(id, partial) {
    const job = this._jobs.find(j => j.id === id);
    if (!job) return null;
    const before = JSON.parse(JSON.stringify(job));

    const ALLOWED = new Set([
      "label",
      "model",
      "schedule",
      "prompt",
      "enabled",
      "type",
      "actorAgentId",
      "executionContext",
      "executor",
      "createdBy",
    ]);
    const VALID_TYPES = new Set(["at", "every", "cron"]);
    if ("type" in partial && !VALID_TYPES.has(partial.type)) {
      throw new Error(`无效的 job type: "${partial.type}"，必须是 at / every / cron`);
    }
    if ("type" in partial && partial.type !== job.type && !("schedule" in partial)) {
      throw new Error("修改 job type 时必须同时提供 schedule");
    }

    for (const key of Object.keys(partial)) {
      if (!ALLOWED.has(key)) continue;
      let value = partial[key];

      if (key === "model") value = normalizeCronModelRef(value);
      if (key === "type") value = String(value);
      if (key === "actorAgentId") {
        if (typeof value === "string" && value.trim()) job.actorAgentId = value.trim();
        continue;
      }
      if (key === "executionContext") {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          job.executionContext = JSON.parse(JSON.stringify(value));
        }
        continue;
      }
      if (key === "executor") {
        validateAutomationExecutorForWrite(value);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          job.executor = JSON.parse(JSON.stringify(value));
        }
        continue;
      }
      if (key === "createdBy") {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          job.createdBy = JSON.parse(JSON.stringify(value));
        }
        continue;
      }

      job[key] = value;
    }

    if ("schedule" in partial || "type" in partial) {
      if (job.type === "every") {
        const ms = typeof job.schedule === "number" ? job.schedule : parseInt(job.schedule, 10);
        if (!Number.isFinite(ms) || ms <= 0) {
          throw new Error(`无效的 every schedule: "${job.schedule}"，必须是正整数毫秒`);
        }
        job.schedule = Math.max(60000, ms);
      }
      if (job.type === "at") {
        const target = new Date(job.schedule);
        if (isNaN(target.getTime())) {
          throw new Error(`无效的 at schedule: "${job.schedule}"，无法解析为日期`);
        }
        if (target <= new Date()) {
          throw new Error(`at schedule 已过期: "${job.schedule}"，必须是未来时间`);
        }
      }
    }

    // schedule 变更时重新计算 nextRunAt
    if ("schedule" in partial || "type" in partial) {
      job.nextRunAt = this._calcNextRun(job.type, job.schedule, new Date().toISOString());
    }

    const normalized = normalizeAutomationJob(job);
    try {
      assertCanEnableAutomationJob(normalized);
    } catch (err) {
      Object.keys(job).forEach((key) => delete job[key]);
      Object.assign(job, before);
      throw err;
    }
    Object.assign(job, normalized);
    this._save();
    return normalized;
  }

  /**
   * 切换任务启用/禁用
   * @param {string} id
   * @returns {object|null}
   */
  toggleJob(id) {
    const job = this._jobs.find(j => j.id === id);
    if (!job) return null;
    const before = JSON.parse(JSON.stringify(job));
    job.enabled = !job.enabled;
    if (job.enabled) {
      // 重新计算下次执行时间
      job.nextRunAt = this._calcNextRun(job.type, job.schedule, new Date().toISOString());
    }
    const normalized = normalizeAutomationJob(job);
    try {
      assertCanEnableAutomationJob(normalized);
    } catch (err) {
      Object.keys(job).forEach((key) => delete job[key]);
      Object.assign(job, before);
      throw err;
    }
    Object.assign(job, normalized);
    this._save();
    return normalized;
  }

  /**
   * 标记任务已执行，更新 lastRunAt + nextRunAt
   * @param {string} id
   * @param {object} [opts]
   * @param {boolean} [opts.success=true] - 是否执行成功
   */
  markRun(id, { success = true } = {}) {
    const job = this._jobs.find(j => j.id === id);
    if (!job) return;
    const now = new Date().toISOString();
    job.lastRunAt = now;

    if (success) {
      job.consecutiveErrors = 0;
      job.nextRunAt = this._calcNextRun(job.type, job.schedule, now);
    } else {
      job.consecutiveErrors = (job.consecutiveErrors || 0) + 1;
      const normalNext = this._calcNextRun(job.type, job.schedule, now);
      const backoffIdx = Math.min(job.consecutiveErrors, CronStore.BACKOFF.length - 1);
      const backoffMs = CronStore.BACKOFF[backoffIdx];
      const backoffNext = new Date(Date.now() + backoffMs).toISOString();
      job.nextRunAt = normalNext && normalNext > backoffNext ? normalNext : backoffNext;
    }

    // "at" 类型执行一次后自动禁用
    if (job.type === "at") {
      job.enabled = false;
    }

    this._save();
  }

  // ════════════════════════════
  //  运行历史
  // ════════════════════════════

  /**
   * 记录一次运行
   * @param {string} jobId
   * @param {object} run - { status, startedAt, finishedAt, error? }
   */
  logRun(jobId, run) {
    const filePath = path.join(this._runsDir, `${jobId}.jsonl`);
    const line = JSON.stringify({ ...run, timestamp: new Date().toISOString() }) + "\n";
    fs.mkdirSync(this._runsDir, { recursive: true });
    fs.appendFileSync(filePath, line, "utf-8");

    // 修剪：超过 500 行时只留最后 300 行
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n");
      if (lines.length > 500) {
        atomicWriteSync(filePath, lines.slice(-300).join("\n") + "\n");
      }
    } catch { /* 修剪失败不影响主流程 */ }
  }

  /**
   * 读取运行历史
   * @param {string} jobId
   * @param {number} [limit=20]
   * @returns {object[]}
   */
  getRunHistory(jobId, limit = 20) {
    const filePath = path.join(this._runsDir, `${jobId}.jsonl`);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // ════════════════════════════
  //  调度计算
  // ════════════════════════════

  /**
   * 计算下次执行时间
   * @param {"at"|"every"|"cron"} type
   * @param {string|number} schedule
   * @param {string} fromISO - 基准时间（ISO string）
   * @returns {string|null} ISO string
   */
  _calcNextRun(type, schedule, fromISO) {
    const from = new Date(fromISO);

    switch (type) {
      case "at": {
        // 一次性：schedule 就是目标时间
        const target = new Date(schedule);
        if (isNaN(target.getTime())) return null;
        return target > from ? target.toISOString() : null;
      }

      case "every": {
        // 间隔：从现在起 schedule 毫秒后
        const ms = typeof schedule === "number" ? schedule : parseInt(schedule, 10);
        if (isNaN(ms) || ms <= 0) return null;
        return new Date(from.getTime() + ms).toISOString();
      }

      case "cron": {
        // 完整 5 字段 cron 解析
        return this._parseSimpleCron(schedule, from);
      }

      default:
        return null;
    }
  }

  /**
   * 完整 cron 解析：支持标准 5 字段 cron 表达式
   *
   * 字段：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6, 0=周日, 7也=周日)
   * 语法：数字 | * | *\/N | N-M | N-M/S | N,M,...
   *
   * @param {string} expr - cron 表达式
   * @param {Date} from - 基准时间
   * @returns {string|null}
   */
  _parseSimpleCron(expr, from) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length < 5) return null;

    const ranges = [
      [0, 59],  // 分
      [0, 23],  // 时
      [1, 31],  // 日
      [1, 12],  // 月
      [0, 6],   // 周（0=周日）
    ];

    const fields = [];
    for (let i = 0; i < 5; i++) {
      const set = this._parseCronField(parts[i], ranges[i][0], ranges[i][1], i === 4);
      if (!set) return null;
      fields.push(set);
    }

    const [minutes, hours, days, months, weekdays] = fields;
    const dayOfMonthRestricted = parts[2] !== "*";
    const dayOfWeekRestricted = parts[4] !== "*";

    // 从下一分钟开始搜索，上限 366 天（覆盖年度 cron）
    const start = new Date(from);
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);

    const limit = 366 * 24 * 60;
    for (let i = 0; i < limit; i++) {
      const t = new Date(start.getTime() + i * 60_000);
      if (!months.has(t.getMonth() + 1)) continue;
      const matchesDayOfMonth = days.has(t.getDate());
      const matchesDayOfWeek = weekdays.has(t.getDay());
      const matchesDay =
        dayOfMonthRestricted && dayOfWeekRestricted
          ? (matchesDayOfMonth || matchesDayOfWeek)
          : (matchesDayOfMonth && matchesDayOfWeek);
      if (!matchesDay) continue;
      if (!hours.has(t.getHours())) continue;
      if (!minutes.has(t.getMinutes())) continue;
      return t.toISOString();
    }

    return null;
  }

  /**
   * 解析单个 cron 字段为值集合
   * @param {string} field - 字段字符串
   * @param {number} min - 最小值
   * @param {number} max - 最大值
   * @param {boolean} isWeekday - 是否为周字段（7→0）
   * @returns {Set<number>|null}
   */
  _parseCronField(field, min, max, isWeekday = false) {
    const values = new Set();

    for (const segment of field.split(",")) {
      // */N — 步进
      if (segment.startsWith("*/")) {
        const step = parseInt(segment.slice(2), 10);
        if (isNaN(step) || step <= 0) return null;
        for (let v = min; v <= max; v += step) values.add(v);
        continue;
      }

      // * — 全部
      if (segment === "*") {
        for (let v = min; v <= max; v++) values.add(v);
        continue;
      }

      // N-M 或 N-M/S — 范围（可选步进）
      const rangeMatch = segment.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
      if (rangeMatch) {
        const lo = parseInt(rangeMatch[1], 10);
        const hi = parseInt(rangeMatch[2], 10);
        const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;
        if (isNaN(lo) || isNaN(hi) || isNaN(step) || step <= 0) return null;
        if (lo > hi) return null;  // 反向范围
        const effectiveMax = isWeekday ? 7 : max;
        if (lo < min || hi > effectiveMax) return null;  // 越界
        for (let v = lo; v <= hi; v += step) values.add(isWeekday && v === 7 ? 0 : v);
        continue;
      }

      // 纯数字
      const num = parseInt(segment, 10);
      if (isNaN(num)) return null;
      const effectiveMax = isWeekday ? 7 : max;
      if (num < min || num > effectiveMax) return null;  // 越界
      values.add(isWeekday && num === 7 ? 0 : num);
    }

    return values.size > 0 ? values : null;
  }

  /** 任务数量 */
  get size() {
    return this._jobs.length;
  }

  /** 启用的任务数量 */
  get enabledCount() {
    return this._jobs.filter(j => j.enabled).length;
  }
}
