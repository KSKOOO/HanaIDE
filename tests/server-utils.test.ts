import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { resolveAgent, resolveAgentStrict } from "../server/utils/resolve-agent.ts";
import { HttpRouteError, jsonRouteError } from "../server/http/route-errors.ts";

function mockEngine(agents) {
  return {
    getAgent: (id) => agents[id] || null,
    currentAgentId: "_focus",
  };
}

function mockCtx(agentId) {
  return { req: { query: (k) => k === "agentId" ? agentId : null, param: () => null } };
}

describe("resolveAgentStrict", () => {
  it("找到 agent 时正常返回", () => {
    const engine = mockEngine({ hana: { id: "hana" }, _focus: { id: "_focus" } });
    expect(resolveAgentStrict(engine, mockCtx("hana"))).toEqual({ id: "hana" });
  });

  it("agentId 不存在时抛 AgentNotFoundError", () => {
    const engine = mockEngine({ _focus: { id: "_focus" } });
    expect(() => resolveAgentStrict(engine, mockCtx("ghost"))).toThrow("not found");
  });

  it("无显式 agentId 时抛 AgentNotFoundError", () => {
    const engine = mockEngine({ _focus: { id: "_focus" } });
    expect(() => resolveAgentStrict(engine, mockCtx(null))).toThrow("not found");
  });
});

describe("resolveAgent (读操作)", () => {
  it("显式传入有效 agentId 返回对应 agent", () => {
    const engine = mockEngine({ hana: { id: "hana" }, _focus: { id: "_focus" } });
    expect(resolveAgent(engine, mockCtx("hana"))).toEqual({ id: "hana" });
  });

  it("显式传入无效 agentId 抛 AgentNotFoundError", () => {
    const engine = mockEngine({ _focus: { id: "_focus" } });
    expect(() => resolveAgent(engine, mockCtx("ghost"))).toThrow("not found");
  });

  it("未传 agentId 时用焦点 agent", () => {
    const engine = mockEngine({ _focus: { id: "_focus" } });
    expect(resolveAgent(engine, mockCtx(null))).toEqual({ id: "_focus" });
  });

  it("未传 agentId 且焦点 agent 不存在时抛 AgentNotFoundError", () => {
    const engine = { getAgent: () => null, currentAgentId: "gone" };
    expect(() => resolveAgent(engine, mockCtx(null))).toThrow('agent "gone" not found');
  });
});

describe("HTTP route errors", () => {
  it("serializes HttpRouteError responses with code, message, and trace id", async () => {
    const app = new Hono();
    app.get("/error", (c) => jsonRouteError(c, new HttpRouteError({
      code: "desk_unavailable",
      message: "Desk not initialized",
      status: 503,
      traceId: "trace-1",
    })));

    const res = await app.request("/error");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: "desk_unavailable",
        message: "Desk not initialized",
        traceId: "trace-1",
      },
    });
  });

  it("serializes route error options without a trace id", async () => {
    const app = new Hono();
    app.get("/error", (c) => jsonRouteError(c, {
      code: "bad_request",
      message: "name required",
      status: 400,
    }));

    const res = await app.request("/error");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "bad_request",
        message: "name required",
      },
    });
  });

  it("throws for invalid route error codes", () => {
    expect(() => new HttpRouteError({
      code: "",
      message: "bad request",
      status: 400,
    })).toThrow(TypeError);

    const c = { json: vi.fn() };
    expect(() => jsonRouteError(c, {
      code: " ",
      message: "bad request",
      status: 400,
    })).toThrow(TypeError);
  });

  it("throws for invalid or empty route error messages", () => {
    expect(() => new HttpRouteError({
      code: "bad_request",
      message: "",
      status: 400,
    })).toThrow(TypeError);

    expect(() => jsonRouteError({ json: vi.fn() }, {
      code: "bad_request",
      message: 42,
      status: 400,
    } as any)).toThrow(TypeError);
  });

  it("throws for invalid route error statuses", () => {
    expect(() => new HttpRouteError({
      code: "bad_request",
      message: "bad request",
      status: 200 as any,
    })).toThrow(TypeError);

    expect(() => jsonRouteError({ json: vi.fn() }, {
      code: "bad_request",
      message: "bad request",
      status: 500.5 as any,
    })).toThrow(TypeError);
  });
});
