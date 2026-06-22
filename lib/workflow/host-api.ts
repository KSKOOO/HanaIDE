
import { createStructuredOutputTool } from "./structured-output.ts";
import { WorkflowJournal } from "./journal.ts";

/**
 * 组装注入沙箱的宿主 API。引擎层不认识 agent 名字，agentType→agentId 的解析由调用方注入 resolveAgentId。
 * @param {{
 *   executeIsolated: (prompt: string, isoOpts: object) => Promise<{ replyText?: string, error?: string|null }>,
 *   baseIsoOpts: object,
 *   limiter: { run: (thunk: () => Promise<any>) => Promise<any> },
 *   signal?: AbortSignal,
 *   onProgress?: (evt: object) => void,
 *   onAgentEvent?: (evt: { phase: 'start'|'session'|'done'|'fail', nodeId: string, threadId?: string|null, threadKind?: string|null, label?: string|null, agentId?: string|null, phaseLabel?: string|null, childSessionId?: string|null, childSessionPath?: string|null }) => void,
 *   budget?: { total: number|null, spent: () => number, remaining: () => number },
 *   args?: any,
 *   resolveAgentId?: (agentType?: string) => string|undefined,
 *   journal?: import("./journal.ts").WorkflowJournal|null,
 *   replayJournal?: import("./journal.ts").WorkflowJournal|null,
 *   runWorkflow?: (script: string, args?: any) => Promise<any>,
 * }} deps
 * @returns {{ agent: Function, parallel: Function, pipeline: Function, log: Function, phase: Function, workflow: Function, budget: any, args: any }}
 */
export function createHostApi(deps) {
  const { executeIsolated, baseIsoOpts, limiter, signal, budget, args, resolveAgentId } = deps;
  const onAgentEvent = typeof deps.onAgentEvent === "function" ? deps.onAgentEvent : () => {};
  const journal = deps.journal || null;
  const replayJournal = deps.replayJournal || null;
  let nodeSeq = 0;
  let currentPhase = null;

  async function agent(prompt, opts: { label?: string; model?: string; agentType?: string; toolFilter?: any; schema?: any } = {}) {
    // nodeId 在调用入口分配：用纯计数器，不依赖沙箱里被禁用的 Date.now/Math.random。
    const seq = ++nodeSeq;
    const nodeId = `node-${seq}`;
    const parentTaskId = typeof baseIsoOpts.subagentTaskId === "string" && baseIsoOpts.subagentTaskId
      ? baseIsoOpts.subagentTaskId
      : null;
    const threadId = parentTaskId ? `${parentTaskId}::${nodeId}` : null;
    const threadKind = threadId ? "workflow_node" : null;
    const label = typeof opts.label === "string" && opts.label ? opts.label : null;

    // ── journal 回放：cache hit 不消耗 limiter slot，瞬间返回 ──
    if (replayJournal) {
      const journalKey = WorkflowJournal.computeKey(prompt, opts);
      const cached = replayJournal.tryReplay(seq, journalKey);
      if (cached) {
        onAgentEvent({ phase: "start", nodeId, threadId, threadKind, label, agentId: baseIsoOpts.agentId ?? null, phaseLabel: currentPhase });
        onAgentEvent({ phase: "done", nodeId, threadId, threadKind });
        journal?.record(seq, journalKey, cached.result, "ok");
        return cached.result;
      }
    }

    return limiter.run(async () => {
      if (signal?.aborted) throw new Error("workflow 已中止");

      // budget 硬上限：spent >= total 时拒绝新 agent
      if (budget?.total != null && budget.remaining() <= 0) {
        throw new Error(`workflow token 预算耗尽（已用 ${budget.spent()}）`);
      }

      const isoOpts = { ...baseIsoOpts, signal };
      if (threadId) {
        isoOpts.subagentThreadId = threadId;
        isoOpts.subagentThreadKind = threadKind;
      }
      if (opts.model) isoOpts.model = opts.model;
      let nodeAgentId = isoOpts.agentId ?? null;
      if (opts.agentType && typeof resolveAgentId === "function") {
        const id = resolveAgentId(opts.agentType);
        if (id) { isoOpts.agentId = id; nodeAgentId = id; }
      }
      if (opts.toolFilter) isoOpts.toolFilter = opts.toolFilter;

      // 节点级活动上报（→ workflow-tool → ActivityHub 子 entry，右侧 WorkflowCard 的每个 agent 节点行）。
      onAgentEvent({ phase: "start", nodeId, threadId, threadKind, label, agentId: nodeAgentId, phaseLabel: currentPhase });
      // 子 session 创建后回补稳定身份 + locator：ID 用于内部归属，path 用于实时流定位。
      isoOpts.onSessionReady = (sp, meta: any = {}) => onAgentEvent({
        phase: "session",
        nodeId,
        threadId,
        threadKind,
        childSessionId: typeof meta?.sessionId === "string" && meta.sessionId.trim() ? meta.sessionId.trim() : null,
        childSessionPath: sp,
      });

      let structured = null;
      let finalPrompt = prompt;
      if (opts.schema) {
        structured = createStructuredOutputTool(opts.schema);
        isoOpts.extraCustomTools = [...(isoOpts.extraCustomTools || []), structured.tool];
        finalPrompt = prompt + "\n\n完成后必须调用一次 structured_output 工具，返回严格符合所需 schema 的结果。";
      }

      const journalKey = journal ? WorkflowJournal.computeKey(prompt, opts) : null;

      try {
        const res = await executeIsolated(finalPrompt, isoOpts);
        if (res?.error) throw new Error(`agent 失败: ${res.error}`);
        let result;
        if (structured) {
          const out = structured.getResult();
          if (out === undefined) throw new Error("agent 未调用 structured_output 返回结构化结果");
          result = out;
        } else {
          result = res?.replyText ?? "";
        }
        onAgentEvent({ phase: "done", nodeId, threadId, threadKind });
        if (journalKey) journal.record(seq, journalKey, result, "ok");
        return result;
      } catch (err) {
        onAgentEvent({ phase: "fail", nodeId, threadId, threadKind });
        if (journalKey) journal.record(seq, journalKey, null, "error");
        throw err;
      }
    });
  }

  async function parallel(thunks) {
    const seq = ++nodeSeq;
    const stepNodeId = `step-${seq}`;
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "parallel", phaseLabel: currentPhase });
    try {
      const result = await Promise.all((thunks || []).map((thunk) =>
        Promise.resolve().then(thunk).catch(() => null)
      ));
      onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "parallel" });
      return result;
    } catch (err) {
      onAgentEvent({ phase: "fail", nodeId: stepNodeId, stepKind: "parallel" });
      throw err;
    }
  }

  async function pipeline(items, ...stages) {
    const seq = ++nodeSeq;
    const stepNodeId = `step-${seq}`;
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "pipeline", phaseLabel: currentPhase });
    try {
      const result = await Promise.all((items || []).map(async (item, index) => {
        let cur = item;
        for (const stage of stages) {
          try { cur = await stage(cur, item, index); }
          catch { return null; }
        }
        return cur;
      }));
      onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "pipeline" });
      return result;
    } catch (err) {
      onAgentEvent({ phase: "fail", nodeId: stepNodeId, stepKind: "pipeline" });
      throw err;
    }
  }

  // ── workflow 嵌套：子 workflow 共享 limiter / signal / budget，限一层 ──
  async function workflow(script, childArgs) {
    if (typeof deps.runWorkflow !== "function") {
      throw new Error("当前环境不支持 workflow 嵌套调用");
    }
    return deps.runWorkflow(script, childArgs);
  }

  const onProgress = typeof deps.onProgress === "function" ? deps.onProgress : () => {};
  function log(message) {
    const seq = ++nodeSeq;
    const stepNodeId = `step-${seq}`;
    const msg = String(message);
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "log", label: msg, phaseLabel: currentPhase });
    onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "log" });
    onProgress({ type: "log", message: msg });
  }
  function phase(title) {
    // 记住最近一次 phase 标题，作为后续 agent 节点的弱分组标签（best-effort，非契约）。
    currentPhase = String(title);
    onProgress({ type: "phase", title: currentPhase });
  }

  return { agent, parallel, pipeline, workflow, log, phase, budget, args };
}
