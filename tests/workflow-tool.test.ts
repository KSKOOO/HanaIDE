// tests/workflow-tool.test.js
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowTool } from "../lib/tools/workflow-tool.ts";

function makeCtx() {
  return { sessionManager: { getSessionFile: () => "/s.jsonl", getCwd: () => "/w" } };
}
function makeStore() {
  return { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
}
function makeRunStore() {
  return { register: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
}
const META = `export const meta = { name: 'demo', description: 'd' }\n`;
const flush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

describe("workflow tool", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("工具形状正确", () => {
    const tool = createWorkflowTool({ executeIsolated: async () => ({}) });
    expect(tool.name).toBe("workflow");
    expect(tool.parameters.properties.script).toBeTruthy();
  });

  it("派出后台任务：立即返回 taskId + streamStatus running，并在 deferred store 登记 type=workflow", async () => {
    const store = makeStore();
    const runStore = makeRunStore();
    const exec = vi.fn(async () => ({ replyText: "bug", error: null }));
    const tool = createWorkflowTool({
      executeIsolated: exec, getAgentId: () => "a1", emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => runStore,
    });
    const res = await tool.execute(
      "c1",
      { script: META + `const o=[]; while(o.length<2){o.push(await agent('x'))} return o` },
      undefined, undefined, makeCtx()
    ) as any;
    // 立即返回 taskId（不阻塞、不含同步 result）
    expect(res.details.taskId).toMatch(/^workflow-/);
    expect(res.details.streamStatus).toBe("running");
    expect(res.content[0].text).toMatch(/已派出后台/);
    // defer + register 登记，meta 带 type=workflow + summary=meta.name
    expect(store.defer).toHaveBeenCalledWith(
      res.details.taskId, "/s.jsonl",
      expect.objectContaining({ type: "workflow", summary: "demo" }),
    );
    expect(runStore.register).toHaveBeenCalledWith(
      res.details.taskId, expect.objectContaining({ summary: "demo" }),
    );
  });

  it("后台跑完 resolve 合成结果到 deferred store，子 agent isoOpts 带 subagentTaskId", async () => {
    const store = makeStore();
    const exec = vi.fn(async () => ({ replyText: "bug", error: null }));
    const tool = createWorkflowTool({
      executeIsolated: exec, getAgentId: () => "a1", emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
    });
    const res = await tool.execute(
      "c1",
      { script: META + `const o=[]; while(o.length<2){o.push(await agent('x'))} return o` },
      undefined, undefined, makeCtx()
    ) as any;
    await flush();
    expect(store.resolve).toHaveBeenCalledWith(res.details.taskId, JSON.stringify(["bug", "bug"], null, 2));
    // 脚本内 agent() 派出的子 session 关联到这个 workflow task
    expect((exec.mock.calls[0] as any)[1]).toMatchObject({
      agentId: "a1", parentSessionPath: "/s.jsonl", cwd: "/w",
      subagentContext: true, subagentTaskId: res.details.taskId, emitEvents: true,
    });
  });

  it("派出后台任务时用 parentSessionId 作为内部运行时归属，sessionPath 只作 locator", async () => {
    const store = makeStore();
    const runStore = makeRunStore();
    const upserts = [];
    const hub = { upsert: vi.fn((e) => { upserts.push({ ...e }); return e; }) };
    const exec = vi.fn(async () => ({ replyText: "bug", error: null }));
    const tool = createWorkflowTool({
      executeIsolated: exec,
      getAgentId: () => "a1",
      emitEvent: () => {},
      getSessionIdForPath: (sessionPath) => sessionPath === "/s.jsonl" ? "sess_parent" : null,
      getDeferredStore: () => store,
      getSubagentRunStore: () => runStore,
      getActivityHub: () => hub,
    });

    const res = await tool.execute(
      "c1",
      { script: META + `return await agent('x')` },
      undefined,
      undefined,
      makeCtx(),
    ) as any;
    await flush();

    expect(store.defer).toHaveBeenCalledWith(
      res.details.taskId,
      { sessionId: "sess_parent", sessionPath: "/s.jsonl" },
      expect.objectContaining({ type: "workflow", summary: "demo" }),
    );
    expect(runStore.register).toHaveBeenCalledWith(
      res.details.taskId,
      expect.objectContaining({ parentSessionId: "sess_parent", parentSessionPath: "/s.jsonl" }),
    );
    expect(hub.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: res.details.taskId,
      sessionId: "sess_parent",
      sessionPath: "/s.jsonl",
    }));
    expect((exec.mock.calls[0] as any)[1]).toMatchObject({
      parentSessionId: "sess_parent",
      parentSessionPath: "/s.jsonl",
    });
  });

  it("脚本头非法时同步返回 toolError，不派后台任务", async () => {
    const store = makeStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => ({}), emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
    });
    const res = await tool.execute("c1", { script: `return 1` }, undefined, undefined, makeCtx()) as any;
    expect(res.details.error).toMatch(/脚本非法/);
    expect(store.defer).not.toHaveBeenCalled();
  });

  it("rejects declarative meta.nodes workflows before dispatching a no-op background task (#1639)", async () => {
    const store = makeStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => ({}), emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
    });
    const script = `export const meta = { name: 'nodes', description: 'd', nodes: [{ id: 'a', prompt: 'x' }] }\n`;
    const res = await tool.execute("c1", { script }, undefined, undefined, makeCtx()) as any;
    expect(res.details.error).toMatch(/meta\.nodes/);
    expect(store.defer).not.toHaveBeenCalled();
  });

  it("脚本运行时出错 → 后台 fail 到 deferred store", async () => {
    const store = makeStore();
    const runStore = makeRunStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => ({ replyText: "", error: "boom" }), emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => runStore,
    });
    const res = await tool.execute("c1", { script: META + `return await agent('x')` }, undefined, undefined, makeCtx()) as any;
    await flush();
    expect(res.details.taskId).toBeTruthy();
    expect(store.fail).toHaveBeenCalledWith(res.details.taskId, expect.stringMatching(/boom|agent 失败/));
    expect(runStore.fail).toHaveBeenCalled();
  });

  it("deferred 基础设施不可用时同步兜底执行，直接返回 result", async () => {
    const exec = vi.fn(async () => ({ replyText: "bug", error: null }));
    const tool = createWorkflowTool({
      executeIsolated: exec, getAgentId: () => "a1", emitEvent: () => {},
      // 不提供 getDeferredStore → 同步兜底
    });
    const res = await tool.execute(
      "c1",
      { script: META + `return await agent('x')` },
      undefined, undefined, makeCtx()
    ) as any;
    expect(res.details.result).toBe("bug");
    expect(res.details.agentsSpawned).toBe(1);
  });

  it("emitEvent 收到 workflow_progress（phase/log），带 taskId", async () => {
    const evts = [];
    const store = makeStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => ({ replyText: "ok", error: null }),
      emitEvent: (e, sp) => evts.push({ e, sp }),
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
    });
    const res = await tool.execute(
      "c1",
      { script: META + `phase('Find'); log('hi'); return await agent('x')` },
      undefined, undefined, makeCtx()
    ) as any;
    await flush();
    expect(evts.map((x) => x.e.type)).toContain("workflow_progress");
    expect(evts.find((x) => x.e.title === "Find")).toBeTruthy();
    expect(evts.every((x) => x.e.taskId === res.details.taskId)).toBe(true);
  });

  it("派出时 details 带 startedAt（inline 概览块算时长用）", async () => {
    const store = makeStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => ({ replyText: "ok", error: null }), emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
    });
    const res = await tool.execute("c1", { script: META + `return await agent('x')` }, undefined, undefined, makeCtx()) as any;
    expect(typeof res.details.startedAt).toBe("number");
  });

  it("后台跑完 emit block_update（inline 概览块翻 done + finishedAt）带 parentSessionPath", async () => {
    const evts = [];
    const store = makeStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => ({ replyText: "ok", error: null }),
      emitEvent: (e, sp) => evts.push({ e, sp }),
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
    });
    const res = await tool.execute("c1", { script: META + `return await agent('x')` }, undefined, undefined, makeCtx()) as any;
    await flush();
    const bu = evts.find((x) => x.e.type === "block_update" && x.e.taskId === res.details.taskId);
    expect(bu).toBeTruthy();
    expect(bu.e.patch.streamStatus).toBe("done");
    expect(typeof bu.e.patch.finishedAt).toBe("number");
    expect(bu.sp).toBe("/s.jsonl");
  });

  it("脚本运行时出错 → emit block_update streamStatus failed", async () => {
    const evts = [];
    const store = makeStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => ({ replyText: "", error: "boom" }),
      emitEvent: (e) => evts.push(e),
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
    });
    const res = await tool.execute("c1", { script: META + `return await agent('x')` }, undefined, undefined, makeCtx()) as any;
    await flush();
    const bu = evts.find((e) => e.type === "block_update" && e.patch?.streamStatus === "failed");
    expect(bu).toBeTruthy();
    expect(bu.taskId).toBe(res.details.taskId);
  });

  it("workflow deadline 是 10 分钟，10 分钟前不 fail，到点后 fail", async () => {
    vi.useFakeTimers();
    const store = makeStore();
    const tool = createWorkflowTool({
      executeIsolated: async () => new Promise(() => {}),
      emitEvent: () => {},
      getDeferredStore: () => store,
      getSubagentRunStore: () => makeRunStore(),
    });

    const res = await tool.execute("c1", { script: META + `return await agent('x')` }, undefined, undefined, makeCtx()) as any;
    expect(res.details.streamStatus).toBe("running");

    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    expect(store.fail).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    await vi.waitFor(() => {
      expect(store.fail).toHaveBeenCalledWith(
        res.details.taskId,
        expect.stringMatching(/超时|timeout/i),
      );
    });
  });

  it("脚本里 agent() → ActivityHub workflow_agent 子 entry（parentTaskId/label/childSessionPath）", async () => {
    const store = makeStore();
    const upserts = [];
    const hub = { upsert: (e) => { upserts.push({ ...e }); return e; } };
    const tool = createWorkflowTool({
      executeIsolated: async (p, o) => { o.onSessionReady?.("/child.jsonl"); return { replyText: "x", error: null }; },
      getAgentId: () => "a1", emitEvent: () => {},
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
      getActivityHub: () => hub,
    });
    const res = await tool.execute("c1", { script: META + `return await agent('x', { label: '探索' })` }, undefined, undefined, makeCtx()) as any;
    await flush();
    const childId = `${res.details.taskId}::node-1`;
    const running = upserts.find((e) => e.id === childId && e.status === "running");
    expect(running).toMatchObject({ kind: "workflow_agent", parentTaskId: res.details.taskId, sessionPath: "/s.jsonl", label: "探索" });
    expect(upserts.find((e) => e.id === childId && e.childSessionPath === "/child.jsonl")).toBeTruthy();
    expect(upserts.find((e) => e.id === childId && e.status === "done")).toBeTruthy();
  });

  it("脚本里 agent() → SubagentThreadStore 登记 workflow_node thread 并在完成后关闭", async () => {
    const store = makeStore();
    const threadStore = {
      beginRun: vi.fn(),
      attachSession: vi.fn(),
      finishRun: vi.fn(),
    };
    const tool = createWorkflowTool({
      executeIsolated: async (p, o) => { o.onSessionReady?.("/child.jsonl"); return { replyText: "x", error: null }; },
      getAgentId: () => "a1", emitEvent: () => {},
      getDeferredStore: () => store,
      getSubagentRunStore: () => makeRunStore(),
      getSubagentThreadStore: () => threadStore,
    });

    const res = await tool.execute("c1", { script: META + `return await agent('x', { label: '探索' })` }, undefined, undefined, makeCtx()) as any;
    await flush();
    const threadId = `${res.details.taskId}::node-1`;

    expect(threadStore.beginRun).toHaveBeenCalledWith(threadId, expect.objectContaining({
      kind: "workflow_node",
      parentTaskId: res.details.taskId,
      nodeId: "node-1",
      parentSessionPath: "/s.jsonl",
      agentId: "a1",
      label: "探索",
    }));
    expect(threadStore.attachSession).toHaveBeenCalledWith(threadId, "/child.jsonl", expect.objectContaining({
      parentTaskId: res.details.taskId,
    }));
    expect(threadStore.finishRun).toHaveBeenCalledWith(threadId, expect.objectContaining({
      status: "resolved",
      close: true,
    }));
  });

  it("节点 done 从 UsageLedger 按 childSessionId 汇总 token 写入子 entry", async () => {
    const store = makeStore();
    const upserts = [];
    const hub = {
      upsert: (e) => { upserts.push({ ...e }); return e; },
      get: (id) => {
        const merged: any = {};
        for (const u of upserts) if (u.id === id) Object.assign(merged, u);
        return merged.id ? merged : null;
      },
    };
    const ledger = {
      list: ({ childSessionId }) => ({
        entries: childSessionId === "sess_child"
          ? [{ usage: { totalTokens: 1000 } }, { usage: { totalTokens: 234 } }]
          : [],
      }),
    };
    const tool = createWorkflowTool({
      executeIsolated: async (p, o) => {
        o.onSessionReady?.("/child-moved.jsonl", { sessionId: "sess_child", sessionPath: "/child-moved.jsonl" });
        return { replyText: "x", error: null };
      },
      getAgentId: () => "a1", emitEvent: () => {},
      getSessionIdForPath: (sessionPath) => sessionPath === "/s.jsonl" ? "sess_parent" : null,
      getDeferredStore: () => store, getSubagentRunStore: () => makeRunStore(),
      getActivityHub: () => hub, getUsageLedger: () => ledger,
    });
    const res = await tool.execute("c1", { script: META + `return await agent('x')` }, undefined, undefined, makeCtx()) as any;
    await flush();
    const childId = `${res.details.taskId}::node-1`;
    expect(upserts.find((e) => e.id === childId && e.childSessionId === "sess_child")).toBeTruthy();
    const done = upserts.find((e) => e.id === childId && e.status === "done");
    expect(done.tokens).toBe(1234); // 1000 + 234
  });

  it("workflow agent fan-out 使用独立高并发上限，能同时启动几十个一次性节点", async () => {
    const store = makeStore();
    let active = 0;
    let peak = 0;
    const releases = [];
    const exec = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return { replyText: "x", error: null };
    });
    const tool = createWorkflowTool({
      executeIsolated: exec,
      getAgentId: () => "a1",
      emitEvent: () => {},
      getDeferredStore: () => store,
      getSubagentRunStore: () => makeRunStore(),
    });

    await tool.execute(
      "c1",
      { script: META + `return await parallel(Array.from({ length: 64 }, (_, i) => () => agent('x' + i)))` },
      undefined,
      undefined,
      makeCtx(),
    );
    await vi.waitFor(() => expect(exec.mock.calls.length).toBeGreaterThanOrEqual(64));
    expect(peak).toBeGreaterThanOrEqual(64);
    releases.forEach((release) => release());
    await flush();
  });

  it("脚本内 parallel/pipeline/log 通过 buildAgentEventHandler 生成 workflow_step 条目", async () => {
    const store = makeStore();
    const hubEntries = [];
    const fakeHub = {
      upsert: vi.fn((e) => { hubEntries.push({ ...e }); return e; }),
      get: vi.fn(() => null),
    };
    const exec = vi.fn(async () => ({ replyText: "ok", error: null }));
    const tool = createWorkflowTool({
      executeIsolated: exec,
      getAgentId: () => "a1",
      emitEvent: () => {},
      getDeferredStore: () => store,
      getSubagentRunStore: () => makeRunStore(),
      getActivityHub: () => fakeHub,
    });
    const script = `export const meta = { name: 'test', description: 't' }
log("hello");
await parallel([async () => await agent("a")]);
return "done";`;
    await tool.execute("c1", { script }, undefined, undefined, makeCtx());
    await flush();
    const stepEntries = hubEntries.filter((e) => e.kind === "workflow_step");
    expect(stepEntries.length).toBeGreaterThanOrEqual(2); // log + parallel
    expect(stepEntries.some((e) => e.stepKind === "log")).toBe(true);
    expect(stepEntries.some((e) => e.stepKind === "parallel")).toBe(true);
  });
});
