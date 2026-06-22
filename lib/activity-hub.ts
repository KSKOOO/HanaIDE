/**
 * ActivityHub — 统一 Agent Activity 实时真相源（内存广播层）
 *
 * subagent / workflow / 巡检 等后台活动产生时往这里 upsert（带 sessionPath + agentId + kind），
 * 前端按当前对话 sessionPath 订阅展示。这是「实时可观测视图」，不取代各源自己的持久化
 * （SubagentRunStore audit / desk ActivityStore），只统一把活动广播给 UI。
 *
 * 内存层：session 结束由 clearBySession 回收；进程重启即清空（历史由各源持久化保留）。
 * 例外：workflow / workflow_agent / subagent 通过可选的 store 做持久化背书（重启不丢右侧卡）。
 */

const VALID_KINDS = new Set(["subagent", "workflow", "workflow_agent", "workflow_step", "heartbeat", "cron"]);
const VALID_STATUSES = new Set(["running", "done", "failed", "aborted"]);

// 右侧活动卡的持久化背书（重启不丢卡）：workflow / workflow_agent / subagent 都写穿。
// subagent 另有 SubagentRunStore（run 生命周期真相 / 内联卡回填），但右侧「子助手」卡是
// ActivityHub 的实时视图，需自己的持久化背书才能重启复原（与 workflow 卡同一套机制）。
// heartbeat / cron 本就瞬时，不持久化。
const PERSISTABLE_KINDS = new Set(["workflow", "workflow_agent", "workflow_step", "subagent"]);

function pickStr(v: any, fallback: any) {
  return typeof v === "string" && v ? v : fallback;
}
function pickNum(v: any, fallback: any) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function normalizeSessionId(value: any) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSessionPath(value: any) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeSessionRef(value: any, resolveSessionIdForPath = null) {
  if (value && typeof value === "object") {
    const sessionPath = normalizeSessionPath(value.sessionPath);
    const sessionId = normalizeSessionId(value.sessionId) || resolveSessionIdForPath?.(sessionPath) || null;
    return { sessionId, sessionPath };
  }
  const sessionPath = normalizeSessionPath(value);
  const sessionId = resolveSessionIdForPath?.(sessionPath) || null;
  return { sessionId, sessionPath };
}

function sameSession(entry: any, sessionRef: any) {
  if (sessionRef.sessionId) return entry.sessionId === sessionRef.sessionId;
  return !!sessionRef.sessionPath && entry.sessionPath === sessionRef.sessionPath;
}

function normalizeEntry(entry: any, existing: any, resolveSessionIdForPath = null) {
  const sessionPath = pickStr(entry.sessionPath, existing?.sessionPath ?? null);
  const sessionId = normalizeSessionId(entry.sessionId)
    || normalizeSessionId(existing?.sessionId)
    || resolveSessionIdForPath?.(sessionPath)
    || null;
  return {
    id: entry.id,
    kind: VALID_KINDS.has(entry.kind) ? entry.kind : (existing?.kind || "subagent"),
    status: VALID_STATUSES.has(entry.status) ? entry.status : (existing?.status || "running"),
    sessionId,
    sessionPath,
    agentId: pickStr(entry.agentId, existing?.agentId ?? null),
    agentName: pickStr(entry.agentName, existing?.agentName ?? null),
    summary: pickStr(entry.summary, existing?.summary ?? null),
    childSessionId: pickStr(entry.childSessionId, existing?.childSessionId ?? null),
    childSessionPath: pickStr(entry.childSessionPath, existing?.childSessionPath ?? null),
    threadId: pickStr(entry.threadId, existing?.threadId ?? null),
    threadKind: pickStr(entry.threadKind, existing?.threadKind ?? null),
    // subagent 展示标签（如 毛毛·探索一）。旧数据里的 reuseInstance 只读作兼容标签。
    label: pickStr(entry.label, pickStr(entry.reuseInstance, existing?.label ?? null)),
    access: pickStr(entry.access, existing?.access ?? null),
    // workflow_agent 子节点专属：归属父 wf + phase 弱分组 + token 消耗。
    parentTaskId: pickStr(entry.parentTaskId, existing?.parentTaskId ?? null),
    phaseLabel: pickStr(entry.phaseLabel, existing?.phaseLabel ?? null),
    tokens: pickNum(entry.tokens, existing?.tokens ?? null),
    // workflow_step 专属：步骤类型（parallel / pipeline / log）。
    stepKind: pickStr(entry.stepKind, existing?.stepKind ?? null),
    // startedAt 取首次（existing 优先），finishedAt 取最新
    startedAt: pickNum(existing?.startedAt, pickNum(entry.startedAt, null)),
    finishedAt: pickNum(entry.finishedAt, existing?.finishedAt ?? null),
  };
}

export class ActivityHub {
  declare _bus: any;
  declare _getSessionIdForPath: any;
  declare _store: any;
  declare _entries: Map<string, any>;
  declare _cbs: any[];

  /**
   * @param {{ emit?: (event: object, sessionPath?: string|null) => void }} [bus]
   * @param {import("./workflow-activity-store.ts").WorkflowActivityStore|null} [store]
   *        可选持久化背书（仅 workflow / workflow_agent 写穿）；传入即在构造时回灌。
   */
  constructor(bus = null, store = null, options: any = {}) {
    this._bus = bus;
    this._getSessionIdForPath = typeof options?.getSessionIdForPath === "function"
      ? options.getSessionIdForPath
      : null;
    this._store = store || null;
    /** @type {Map<string, object>} */
    this._entries = new Map();
    this._cbs = [];
    if (this._store) this._rehydrateFromStore();
  }

  upsert(entry) {
    if (!entry || typeof entry.id !== "string" || !entry.id) return null;
    const existing = this._entries.get(entry.id) || null;
    const next = normalizeEntry(entry, existing, (sessionPath) => this._resolveSessionIdForPath(sessionPath));
    this._entries.set(next.id, next);
    // 持久化背书：仅 workflow / workflow_agent 写穿（其它 kind 各有自己的源 / 本就瞬时）。
    if (this._store && PERSISTABLE_KINDS.has(next.kind)) this._store.upsert(next);
    this._emit(next);
    return { ...next };
  }

  /**
   * 构造时从 store 回灌（重启复原右侧 WorkflowCard）。
   * 上一进程遗留的 running 必是孤儿（能推进它的进程已退出）→ 标 failed，
   * 避免右侧卡永久转圈（用户明确反对「重启退回正在运行」）。修正写回 store 保持落盘一致。
   */
  _rehydrateFromStore() {
    for (const raw of this._store.list()) {
      const orphaned = raw.status === "running";
      const seed = orphaned
        ? { ...raw, status: "failed", finishedAt: raw.finishedAt ?? raw.startedAt ?? null }
        : raw;
      const next = normalizeEntry(seed, null, (sessionPath) => this._resolveSessionIdForPath(sessionPath));
      this._entries.set(next.id, next);
      if (orphaned) this._store.upsert(next);
    }
  }

  /**
   * 重发该 session 的活动（不改状态，只把内存里的活动再广播一次）。
   * 用途：重启后前端 slice 为空，会话载入时调用，让右侧卡重新填充。
   */
  rebroadcastSession(sessionPath) {
    const sessionRef = normalizeSessionRef(sessionPath, (path) => this._resolveSessionIdForPath(path));
    if (!sessionRef.sessionId && !sessionRef.sessionPath) return;
    for (const e of this._entries.values()) {
      if (sameSession(e, sessionRef)) this._emit({ ...e });
    }
  }

  get(id) {
    const e = this._entries.get(id);
    return e ? { ...e } : null;
  }

  list() {
    return [...this._entries.values()].map((e) => ({ ...e }));
  }

  /** 当前对话过滤：只返回归属该 session 的活动。sessionPath 是 legacy locator。 */
  listBySession(sessionRefInput) {
    const sessionRef = normalizeSessionRef(sessionRefInput, (path) => this._resolveSessionIdForPath(path));
    if (!sessionRef.sessionId && !sessionRef.sessionPath) return [];
    const out = [];
    for (const e of this._entries.values()) {
      if (sameSession(e, sessionRef)) out.push({ ...e });
    }
    return out;
  }

  /** session 关闭/退场时回收其活动（内存 + 持久化背书一并清） */
  clearBySession(sessionRefInput) {
    const sessionRef = normalizeSessionRef(sessionRefInput, (path) => this._resolveSessionIdForPath(path));
    if (!sessionRef.sessionId && !sessionRef.sessionPath) return;
    for (const [id, e] of this._entries) {
      if (sameSession(e, sessionRef)) this._entries.delete(id);
    }
    this._store?.removeBySession?.(sessionRef.sessionId ? sessionRef : sessionRef.sessionPath);
  }

  remove(id) {
    return this._entries.delete(id);
  }

  onChange(cb) {
    if (typeof cb !== "function") return () => {};
    this._cbs.push(cb);
    return () => {
      const i = this._cbs.indexOf(cb);
      if (i !== -1) this._cbs.splice(i, 1);
    };
  }

  _emit(entry) {
    const snapshot = { ...entry };
    for (const cb of this._cbs) {
      try { cb(snapshot); } catch { /* best effort */ }
    }
    this._bus?.emit?.({ type: "agent_activity", entry: snapshot }, entry.sessionPath ?? null);
  }

  _resolveSessionIdForPath(sessionPath) {
    if (!sessionPath || typeof this._getSessionIdForPath !== "function") return null;
    try {
      return normalizeSessionId(this._getSessionIdForPath(sessionPath));
    } catch {
      return null;
    }
  }
}
