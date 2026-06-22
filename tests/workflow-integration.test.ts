// tests/workflow-integration.test.js
import { describe, expect, it, vi } from "vitest";
import { runWorkflowScript } from "../lib/workflow/sandbox.ts";
import { createHostApi } from "../lib/workflow/host-api.ts";
import { createLimiter } from "../lib/workflow/concurrency.ts";

function makeHost(executeIsolated, over: any = {}) {
  return createHostApi({
    executeIsolated,
    baseIsoOpts: { agentId: "a1", parentSessionPath: "/s.jsonl", cwd: "/w" },
    limiter: createLimiter({ maxConcurrent: 4, maxTotal: 100 }),
    onProgress: over.onProgress || (() => {}),
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    args: over.args,
  });
}

const META = `export const meta = { name: 'demo', description: 'd' }\n`;

describe("workflow end-to-end (mock executeIsolated)", () => {
  it("loop-until-count 脚本跑通", async () => {
    const exec = vi.fn(async () => ({ replyText: "bug", error: null }));
    const script = META + `
      const out = [];
      while (out.length < 3) { out.push(await agent('find a bug')); }
      return out;
    `;
    const { result } = await runWorkflowScript(script, makeHost(exec));
    expect(result).toEqual(["bug", "bug", "bug"]);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("parallel + schema 的 fan-out 脚本跑通", async () => {
    const exec = vi.fn(async (p, o) => {
      const tool = o.extraCustomTools?.find((t) => t.name === "structured_output");
      if (tool) await tool.execute("c", { ok: true, file: p });
      return { replyText: "", error: null };
    });
    const script = META + `
      const files = ['a.js', 'b.js', 'c.js'];
      const found = await parallel(files.map((f) => () =>
        agent('audit ' + f, { schema: { type: 'object', properties: { ok: { type: 'boolean' }, file: { type: 'string' } } } })
      ));
      return found.filter((x) => x && x.ok).length;
    `;
    const { result } = await runWorkflowScript(script, makeHost(exec));
    expect(result).toBe(3);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("args 透传给脚本", async () => {
    const host = makeHost(async () => ({ replyText: "", error: null }), { args: { target: 42 } });
    const { result } = await runWorkflowScript(META + `return args.target`, host);
    expect(result).toBe(42);
  });
});
