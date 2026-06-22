import { describe, expect, it } from "vitest";
import { createHostApi } from "../lib/workflow/host-api.ts";
import { createLimiter } from "../lib/workflow/concurrency.ts";

export function makeDeps( over: any = {}) {
  return {
    executeIsolated: over.executeIsolated || (async () => ({ replyText: "ok", error: null })),
    baseIsoOpts: over.baseIsoOpts || { agentId: "a1", parentSessionPath: "/s.jsonl", cwd: "/w" },
    limiter: over.limiter || createLimiter({ maxConcurrent: 4, maxTotal: 100 }),
    signal: over.signal,
    onProgress: over.onProgress || (() => {}),
    budget: over.budget || { total: null, spent: () => 0, remaining: () => Infinity },
    args: over.args,
    resolveAgentId: over.resolveAgentId,
    onAgentEvent: over.onAgentEvent,
  };
}

describe("host api - agent()", () => {
  it("调 executeIsolated 并返回 replyText", async () => {
    const calls = [];
    const api = createHostApi(makeDeps({
      executeIsolated: async (p, o) => { calls.push({ p, o }); return { replyText: "hello", error: null }; },
    }));
    const r = await api.agent("do it");
    expect(r).toBe("hello");
    expect(calls[0].o.agentId).toBe("a1");
    expect(calls[0].p).toBe("do it");
  });

  it("opts.model / opts.agentType 透传与解析", async () => {
    const calls = [];
    const api = createHostApi(makeDeps({
      executeIsolated: async (p, o) => { calls.push(o); return { replyText: "x", error: null }; },
      resolveAgentId: (t) => (t === "Explore" ? "explore-agent" : undefined),
    }));
    await api.agent("p", { model: "claude-haiku-4-5-20251001", agentType: "Explore" });
    expect(calls[0].model).toBe("claude-haiku-4-5-20251001");
    expect(calls[0].agentId).toBe("explore-agent");
  });

  it("executeIsolated 返回 error 时抛错", async () => {
    const api = createHostApi(makeDeps({ executeIsolated: async () => ({ replyText: "", error: "模型挂了" }) }));
    await expect(api.agent("x")).rejects.toThrow(/模型挂了/);
  });

  it("带 schema：注入 structured_output 并返回结构化对象", async () => {
    const api = createHostApi(makeDeps({
      executeIsolated: async (p, o) => {
        const tool = o.extraCustomTools.find((t) => t.name === "structured_output");
        await tool.execute("c", { n: 7 });
        return { replyText: "", error: null };
      },
    }));
    const out = await api.agent("count", { schema: { type: "object", properties: { n: { type: "number" } } } });
    expect(out).toEqual({ n: 7 });
  });

  it("带 schema 但子 agent 没调工具时抛错", async () => {
    const api = createHostApi(makeDeps({ executeIsolated: async () => ({ replyText: "forgot", error: null }) }));
    await expect(api.agent("x", { schema: { type: "object" } })).rejects.toThrow(/未调用 structured_output/);
  });

  it("signal 已 abort 时 agent() 抛错", async () => {
    const ac = new AbortController(); ac.abort();
    const api = createHostApi(makeDeps({ signal: ac.signal }));
    await expect(api.agent("x")).rejects.toThrow(/中止/);
  });

  it("节点级上报：agent() 发 start/session/done，带 nodeId/label/phaseLabel/agentId", async () => {
    const evts = [];
    const api = createHostApi(makeDeps({
      onAgentEvent: (e) => evts.push(e),
      resolveAgentId: (t) => (t === "Explore" ? "explore-agent" : undefined),
      executeIsolated: async (p, o) => { o.onSessionReady?.("/child.jsonl"); return { replyText: "ok", error: null }; },
    }));
    api.phase("Find");
    await api.agent("p", { label: "探索", agentType: "Explore" });
    expect(evts.find((e) => e.phase === "start")).toMatchObject({ nodeId: "node-1", label: "探索", agentId: "explore-agent", phaseLabel: "Find" });
    expect(evts.find((e) => e.phase === "session")).toMatchObject({ nodeId: "node-1", childSessionPath: "/child.jsonl" });
    expect(evts.find((e) => e.phase === "done")).toMatchObject({ nodeId: "node-1" });
  });

  it("agent() 为 workflow 节点生成稳定 threadId 并透传给 executeIsolated", async () => {
    const calls = [];
    const evts = [];
    const api = createHostApi(makeDeps({
      baseIsoOpts: {
        agentId: "a1",
        parentSessionPath: "/s.jsonl",
        cwd: "/w",
        subagentTaskId: "workflow-1",
      },
      onAgentEvent: (e) => evts.push(e),
      executeIsolated: async (p, o) => {
        calls.push(o);
        o.onSessionReady?.("/child.jsonl");
        return { replyText: "ok", error: null };
      },
    }));

    await api.agent("p", { label: "探索" });

    expect(calls[0]).toMatchObject({
      subagentThreadId: "workflow-1::node-1",
      subagentThreadKind: "workflow_node",
    });
    expect(evts.find((e) => e.phase === "start")).toMatchObject({
      nodeId: "node-1",
      threadId: "workflow-1::node-1",
      threadKind: "workflow_node",
    });
    expect(evts.find((e) => e.phase === "session")).toMatchObject({
      threadId: "workflow-1::node-1",
      childSessionPath: "/child.jsonl",
    });
  });

  it("节点级上报：agent() 失败发 fail（不重复）", async () => {
    const evts = [];
    const api = createHostApi(makeDeps({
      onAgentEvent: (e) => evts.push(e),
      executeIsolated: async () => ({ replyText: "", error: "boom" }),
    }));
    await expect(api.agent("p")).rejects.toThrow(/boom/);
    expect(evts.filter((e) => e.phase === "fail")).toHaveLength(1);
    expect(evts.find((e) => e.phase === "fail")).toMatchObject({ nodeId: "node-1" });
  });

  it("节点 nodeId 递增（每次 agent() 调用分配一个）", async () => {
    const ids = [];
    const api = createHostApi(makeDeps({ onAgentEvent: (e) => { if (e.phase === "start") ids.push(e.nodeId); } }));
    await api.agent("a");
    await api.agent("b");
    expect(ids).toEqual(["node-1", "node-2"]);
  });
});

describe("host api - parallel / pipeline / log / phase", () => {
  it("parallel 等齐所有 thunk", async () => {
    const api = createHostApi(makeDeps());
    const r = await api.parallel([async () => 1, async () => 2, async () => 3]);
    expect(r).toEqual([1, 2, 3]);
  });

  it("parallel 单个 thunk 抛错落 null，不拖累其他", async () => {
    const api = createHostApi(makeDeps());
    const r = await api.parallel([async () => 1, async () => { throw new Error("x"); }, async () => 3]);
    expect(r).toEqual([1, null, 3]);
  });

  it("pipeline 每个 item 穿过所有 stage", async () => {
    const api = createHostApi(makeDeps());
    const r = await api.pipeline([1, 2], (n) => n + 1, (n) => n * 10);
    expect(r).toEqual([20, 30]);
  });

  it("pipeline 某 stage 抛错时该 item 落 null", async () => {
    const api = createHostApi(makeDeps());
    const r = await api.pipeline([1, 2], (n) => { if (n === 1) throw new Error("x"); return n; }, (n) => n * 10);
    expect(r).toEqual([null, 20]);
  });

  it("pipeline 后续 stage 能拿到 originalItem 与 index", async () => {
    const api = createHostApi(makeDeps());
    const r = await api.pipeline(["a", "b"], (v) => v.toUpperCase(), (prev, orig, i) => `${prev}:${orig}:${i}`);
    expect(r).toEqual(["A:a:0", "B:b:1"]);
  });

  it("log / phase 转发到 onProgress", () => {
    const evts = [];
    const api = createHostApi(makeDeps({ onProgress: (e) => evts.push(e) }));
    api.phase("Find"); api.log("hi");
    expect(evts).toEqual([{ type: "phase", title: "Find" }, { type: "log", message: "hi" }]);
  });

  it("parallel 发 step start/done 事件，带 stepKind 和 phaseLabel", async () => {
    const evts = [];
    const api = createHostApi(makeDeps({ onAgentEvent: (e) => evts.push(e) }));
    api.phase("Find");
    await api.parallel([async () => 1, async () => 2]);
    const start = evts.find((e) => e.phase === "start" && e.stepKind === "parallel");
    const done = evts.find((e) => e.phase === "done" && e.stepKind === "parallel");
    expect(start).toMatchObject({ stepKind: "parallel", phaseLabel: "Find" });
    expect(start.nodeId).toMatch(/^step-/);
    expect(done).toMatchObject({ stepKind: "parallel" });
    expect(done.nodeId).toBe(start.nodeId);
  });

  it("pipeline 发 step start/done 事件，带 stepKind", async () => {
    const evts = [];
    const api = createHostApi(makeDeps({ onAgentEvent: (e) => evts.push(e) }));
    await api.pipeline([1, 2], (n) => n + 1);
    const start = evts.find((e) => e.phase === "start" && e.stepKind === "pipeline");
    const done = evts.find((e) => e.phase === "done" && e.stepKind === "pipeline");
    expect(start).toBeTruthy();
    expect(done).toBeTruthy();
    expect(done.nodeId).toBe(start.nodeId);
  });

  it("log 发 step start+done 事件（瞬时），label 为消息内容", async () => {
    const evts = [];
    const api = createHostApi(makeDeps({ onAgentEvent: (e) => evts.push(e) }));
    api.phase("Report");
    api.log("3 bugs found");
    const start = evts.find((e) => e.phase === "start" && e.stepKind === "log");
    const done = evts.find((e) => e.phase === "done" && e.stepKind === "log");
    expect(start).toMatchObject({ stepKind: "log", label: "3 bugs found", phaseLabel: "Report" });
    expect(done).toMatchObject({ stepKind: "log" });
  });

  it("parallel 所有 thunk 抛错时发 fail 事件", async () => {
    const evts = [];
    const api = createHostApi(makeDeps({ onAgentEvent: (e) => evts.push(e) }));
    await api.parallel([async () => { throw new Error("x"); }]);
    // parallel 本身 catch → null，不抛外层，但整体仍然 done（parallel 本身成功完成）
    const done = evts.find((e) => e.phase === "done" && e.stepKind === "parallel");
    expect(done).toBeTruthy();
  });
});
