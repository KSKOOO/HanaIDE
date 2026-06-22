import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

const { runAgentSessionMock, runAgentPhoneSessionMock } = vi.hoisted(() => ({
  runAgentSessionMock: vi.fn(async () => "OK"),
  runAgentPhoneSessionMock: vi.fn(async () => "OK"),
}));

const { callTextMock } = vi.hoisted(() => ({
  callTextMock: vi.fn(async () => "YES"),
}));

vi.mock("../hub/agent-executor.js", () => ({
  runAgentSession: runAgentSessionMock,
  runAgentPhoneSession: runAgentPhoneSessionMock,
}));

vi.mock("../core/llm-client.js", () => ({
  callText: callTextMock,
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ChannelRouter } from "../hub/channel-router.ts";
import { readAgentPhoneProjection, getAgentPhoneProjectionPath } from "../lib/conversations/agent-phone-projection.ts";

describe("ChannelRouter reply tool boundary", () => {
  it("runs channel phone delivery with channel-scoped decision tools", async () => {
    runAgentSessionMock.mockClear();
    runAgentPhoneSessionMock.mockClear();
    callTextMock.mockClear();

    const engine = { marker: "engine" };
    const router = new ChannelRouter({
      hub: {
        engine,
        eventBus: { emit: vi.fn() },
      },
    });

    const result = await router._executeReply(
      "hanako",
      "ch_crew",
      "user: @Hanako please reply OK",
    );

    expect(result).toMatchObject({ replied: false, missingDecision: true });
    expect(runAgentPhoneSessionMock).toHaveBeenCalledOnce();
    const options = (runAgentPhoneSessionMock.mock.calls as any)[0][2];
    expect(options).toMatchObject({
      engine,
      conversationId: "ch_crew",
      conversationType: "channel",
      toolMode: "read_only",
    });
    expect(options).not.toHaveProperty("allowedBaseToolNames");
    expect(options.extraCustomTools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining(["channel_read_context", "channel_reply", "channel_pass"]),
    );
    expect(callTextMock).not.toHaveBeenCalled();
  });

  it("adds concrete yuan reflection guidance and channel reply range without forcing API budget", async () => {
    runAgentPhoneSessionMock.mockClear();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-phone-prompt-"));
    const channelsDir = path.join(root, "channels");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.writeFileSync(
      path.join(channelsDir, "ch_crew.md"),
      "---\nid: ch_crew\nmembers: [butter, hanako]\nagentPhoneReplyMinChars: 20\nagentPhoneReplyMaxChars: 80\n---\n",
      "utf-8",
    );
    const router = new ChannelRouter({
      hub: {
        engine: {
          marker: "engine",
          channelsDir,
          getAgent: () => ({ config: { agent: { yuan: "butter" } } }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    await router._executeReply(
      "butter",
      "ch_crew",
      "user: 大家怎么看？",
    );

    const rounds = (runAgentPhoneSessionMock.mock.calls as any)[0][1];
    const phonePrompt = rounds![0].text;
    expect(phonePrompt).not.toContain("<mood>");
    expect(phonePrompt).not.toContain("</mood>");
    expect(phonePrompt).toContain("PULSE");
    expect(phonePrompt).toContain("<pulse>");
    expect(phonePrompt).toContain("实际发到群聊的回复正文");
    expect(phonePrompt).toContain("优先口语化");
    expect(phonePrompt).toContain("内容很长");
    expect(phonePrompt).toContain("20");
    expect(phonePrompt).toContain("80");
    expect((runAgentPhoneSessionMock.mock.calls as any)[0][2]).not.toHaveProperty("maxTokens");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("guides non-mentioned channel members to avoid stealing an explicit mention", async () => {
    runAgentPhoneSessionMock.mockClear();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-mentioned-prompt-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "hana"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "yui"), { recursive: true });
    fs.writeFileSync(
      path.join(channelsDir, "ch_crew.md"),
      "---\nid: ch_crew\nmembers: [hana, yui]\n---\n",
      "utf-8",
    );

    const router = new ChannelRouter({
      hub: {
        engine: {
          marker: "engine",
          channelsDir,
          agentsDir,
          getAgent: (id) => ({ id, agentName: id === "yui" ? "Yui" : "Hana", config: { agent: { yuan: "hanako" } } }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    await router._executeReply(
      "hana",
      "ch_crew",
      "user: @Yui 可以先看一下吗？",
      { mentionedAgents: ["yui"], mentionTargeted: false },
    );

    const phonePrompt = (runAgentPhoneSessionMock.mock.calls as any)[0][1][0].text;
    expect(phonePrompt).toContain("这轮消息明确 @ 了 Yui");
    expect(phonePrompt).toContain("不要抢答");
    expect(phonePrompt).toContain("channel_pass");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("passes a channel model override into the phone session when enabled", async () => {
    runAgentPhoneSessionMock.mockClear();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-model-override-"));
    const channelsDir = path.join(root, "channels");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.writeFileSync(
      path.join(channelsDir, "ch_crew.md"),
      [
        "---",
        "id: ch_crew",
        "members: [butter, hanako]",
        "agentPhoneModelOverrideEnabled: true",
        "agentPhoneModelOverrideId: deepseek-v4-flash",
        "agentPhoneModelOverrideProvider: deepseek",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );
    const router = new ChannelRouter({
      hub: {
        engine: {
          marker: "engine",
          channelsDir,
          getAgent: () => ({ config: { agent: { yuan: "butter" } } }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    await router._executeReply(
      "butter",
      "ch_crew",
      "user: 大家怎么看？",
    );

    expect((runAgentPhoneSessionMock.mock.calls as any)[0][2]).toMatchObject({
      modelOverride: { id: "deepseek-v4-flash", provider: "deepseek" },
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("passes channel write tool mode into the phone session when enabled", async () => {
    runAgentPhoneSessionMock.mockClear();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-tool-mode-"));
    const channelsDir = path.join(root, "channels");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.writeFileSync(path.join(channelsDir, "ch_crew.md"), "---\nid: ch_crew\nmembers: [hanako, yui]\nagentPhoneToolMode: write\n---\n", "utf-8");

    const router = new ChannelRouter({
      hub: {
        engine: { marker: "engine", channelsDir },
        eventBus: { emit: vi.fn() },
      },
    });

    await router._executeReply(
      "hanako",
      "ch_crew",
      "user: @Hanako please reply OK",
    );

    expect((runAgentPhoneSessionMock.mock.calls as any)[0][2]).toMatchObject({
      toolMode: "write",
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("tells phone sessions that unread delivery is a rolling window, not full channel history", async () => {
    runAgentPhoneSessionMock.mockClear();

    const router = new ChannelRouter({
      hub: {
        engine: { marker: "engine" },
        eventBus: { emit: vi.fn() },
      },
    });

    await router._executeReply(
      "hanako",
      "ch_crew",
      "user: message 6\nuser: message 7",
      {
        messageCount: 20,
        deliveryWindow: {
          totalUnreadCount: 25,
          droppedUnreadCount: 5,
          bookmarkState: "never",
        },
      },
    );

    const phonePrompt = (runAgentPhoneSessionMock.mock.calls as any)[0][1][0].text;
    expect(phonePrompt).toContain("本次投递窗口内未处理的新消息");
    expect(phonePrompt).toContain("不是频道全部历史");
    expect(phonePrompt).toContain("较早的 5 条未读消息没有放入本次投递窗口");
    expect(phonePrompt).toContain("channel_read_context");
    expect(phonePrompt).toContain("频道 Truth");
    expect(phonePrompt).toContain("此前 Phone Session");
    expect(phonePrompt).not.toContain("频道视角摘要");
  });

  it("emits a complete incremental message from the channel_reply tool, not raw model text", async () => {
    runAgentSessionMock.mockClear();
    runAgentPhoneSessionMock.mockClear();
    (runAgentPhoneSessionMock as any).mockImplementationOnce(async (_agentId: any, _rounds: any, options: any) => {
      const replyTool = options.extraCustomTools.find((tool: any) => tool.name === "channel_reply");
      await replyTool.execute("tool-call-1", {
        mood: "我想接一下这个球。",
        content: "工具发出的 OK",
      });
      return "RAW MODEL TEXT SHOULD NOT BE POSTED";
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-router-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    const productDir = path.join(root, "product");
    fs.mkdirSync(path.join(agentsDir, "hanako"), { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "hanako", "config.yaml"), "agent:\n  name: Hanako\n", "utf-8");
    fs.writeFileSync(path.join(channelsDir, "ch_crew.md"), "---\nid: ch_crew\nmembers: [hanako]\n---\n", "utf-8");

    const emit = vi.fn();
    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          userDir,
          productDir,
          isChannelsEnabled: () => true,
        },
        eventBus: { emit },
      },
    });

    const result = await router._executeCheck(
      "hanako",
      "ch_crew",
      [{ sender: "user", timestamp: "2026-05-07 17:00:00", body: "@Hanako ping" }],
      [],
    );

    expect(result.replied).toBe(true);
    expect(result.replyContent).toBe("工具发出的 OK");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "channel_new_message",
      channelName: "ch_crew",
      sender: "hanako",
      message: expect.objectContaining({
        sender: "hanako",
        body: "工具发出的 OK",
      }),
    }), null);
    expect(emit.mock.calls[0][0].message.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(fs.readFileSync(path.join(channelsDir, "ch_crew.md"), "utf-8")).toContain("工具发出的 OK");
    expect(fs.readFileSync(path.join(channelsDir, "ch_crew.md"), "utf-8")).not.toContain("RAW MODEL TEXT SHOULD NOT BE POSTED");
  });

  it("keeps a committed channel_reply decision when the phone session aborts after posting", async () => {
    runAgentSessionMock.mockClear();
    runAgentPhoneSessionMock.mockClear();
    (runAgentPhoneSessionMock as any).mockImplementationOnce(async (_agentId: any, _rounds: any, options: any) => {
      const replyTool = options.extraCustomTools.find((tool: any) => tool.name === "channel_reply");
      await replyTool.execute("tool-call-1", { content: "已经写入频道的回复" });
      const err = new Error("delivery aborted after channel reply");
      err.name = "AbortError";
      throw err;
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-abort-after-reply-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    const productDir = path.join(root, "product");
    fs.mkdirSync(path.join(agentsDir, "hanako"), { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "hanako", "config.yaml"), "agent:\n  name: Hanako\n", "utf-8");
    fs.writeFileSync(path.join(channelsDir, "ch_crew.md"), "---\nid: ch_crew\nmembers: [hanako]\n---\n", "utf-8");

    const activityRecord = vi.fn();
    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          userDir,
          productDir,
          isChannelsEnabled: () => true,
        },
        eventBus: { emit: vi.fn() },
        agentPhoneActivities: { record: activityRecord },
      },
    });

    const result = await router._executeCheck(
      "hanako",
      "ch_crew",
      [{ sender: "user", timestamp: "2026-05-07 17:00:00", body: "@Hanako ping" }],
      [],
    );

    expect(result).toMatchObject({
      replied: true,
      replyContent: "已经写入频道的回复",
    });
    expect(activityRecord.mock.calls.map((call) => call[0].state)).toContain("idle");
    expect(fs.readFileSync(path.join(channelsDir, "ch_crew.md"), "utf-8")).toContain("已经写入频道的回复");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses channel_reply when the running agent has been removed from the channel", async () => {
    runAgentSessionMock.mockClear();
    runAgentPhoneSessionMock.mockClear();
    (runAgentPhoneSessionMock as any).mockImplementationOnce(async (_agentId: any, _rounds: any, options: any) => {
      expect(options.returnDiagnostics).toBe(true);
      const replyTool = options.extraCustomTools.find((tool: any) => tool.name === "channel_reply");
      const result = await replyTool.execute("tool-call-1", {
        content: "这条幽灵消息不应该写入频道",
      });
      expect(result.details).toMatchObject({ action: "reply", error: "not a channel member" });
      return {
        text: "普通文本不应进入频道",
        diagnostics: {
          activeToolNames: ["channel_reply", "channel_pass"],
          toolCallCount: 1,
          toolCallNames: ["channel_reply"],
          ordinaryTextLength: 10,
        },
      };
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-removed-reply-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    const productDir = path.join(root, "product");
    fs.mkdirSync(path.join(agentsDir, "hanako"), { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "hanako", "config.yaml"), "agent:\n  name: Hanako\n", "utf-8");
    fs.writeFileSync(path.join(channelsDir, "ch_crew.md"), "---\nid: ch_crew\nmembers: [yui]\n---\n", "utf-8");

    const activityRecord = vi.fn();
    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          userDir,
          productDir,
          isChannelsEnabled: () => true,
        },
        eventBus: { emit: vi.fn() },
        agentPhoneActivities: { record: activityRecord },
      },
    });

    const result = await router._executeCheck(
      "hanako",
      "ch_crew",
      [{ sender: "user", timestamp: "2026-05-07 17:00:00", body: "@Hanako ping" }],
      [],
    );

    expect(result).toMatchObject({ replied: false, permissionBlocked: true });
    expect(runAgentPhoneSessionMock).toHaveBeenCalledOnce();
    const errorActivity = activityRecord.mock.calls.find((call) => call[0]?.state === "error")?.[0];
    expect(errorActivity).toMatchObject({
      details: {
        reason: "not a channel member",
        diagnostics: {
          toolCallCount: 1,
          toolCallNames: ["channel_reply"],
          ordinaryTextLength: 10,
        },
      },
    });
    expect(fs.readFileSync(path.join(channelsDir, "ch_crew.md"), "utf-8")).not.toContain("这条幽灵消息不应该写入频道");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("treats channel_pass as an explicit viewed-without-reply decision", async () => {
    runAgentSessionMock.mockClear();
    runAgentPhoneSessionMock.mockClear();
    (runAgentPhoneSessionMock as any).mockImplementationOnce(async (_agentId: any, _rounds: any, options: any) => {
      const passTool = options.extraCustomTools.find((tool: any) => tool.name === "channel_pass");
      await passTool.execute("tool-call-1", {
        mood: "这个话题别人已经接住了。",
        reason: "没有新的补充",
      });
      return "RAW MODEL TEXT SHOULD NOT BE POSTED";
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-pass-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    const productDir = path.join(root, "product");
    fs.mkdirSync(path.join(agentsDir, "hanako"), { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "hanako", "config.yaml"), "agent:\n  name: Hanako\n", "utf-8");
    fs.writeFileSync(path.join(channelsDir, "ch_crew.md"), "---\nid: ch_crew\nmembers: [hanako]\n---\n", "utf-8");

    const emit = vi.fn();
    const activityRecord = vi.fn();
    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          userDir,
          productDir,
          isChannelsEnabled: () => true,
        },
        eventBus: { emit },
        agentPhoneActivities: { record: activityRecord },
      },
    });

    const result = await router._executeCheck(
      "hanako",
      "ch_crew",
      [{ sender: "user", timestamp: "2026-05-07 17:00:00", body: "谁想接一下？" }],
      [],
    );

    expect(result).toMatchObject({ replied: false, passed: true });
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "channel_new_message" }), null);
    expect(activityRecord.mock.calls.map((call) => call[0].state)).toContain("no_reply");
    expect(fs.readFileSync(path.join(channelsDir, "ch_crew.md"), "utf-8")).not.toContain("RAW MODEL TEXT SHOULD NOT BE POSTED");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("retries once with repair guidance before treating a missing channel decision as skipped", async () => {
    runAgentSessionMock.mockClear();
    runAgentPhoneSessionMock.mockClear();
    (runAgentPhoneSessionMock as any)
      .mockResolvedValueOnce({
        text: "普通文本不应进入频道",
        diagnostics: {
          activeToolNames: ["channel_reply", "channel_pass"],
          toolCallCount: 0,
          toolCallNames: [],
          ordinaryTextLength: 10,
        },
      })
      .mockResolvedValueOnce({
        text: "仍然没有调用工具",
        diagnostics: {
          activeToolNames: ["channel_reply", "channel_pass"],
          toolCallCount: 0,
          toolCallNames: [],
          ordinaryTextLength: 9,
        },
      });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-missing-decision-repair-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    const productDir = path.join(root, "product");
    fs.mkdirSync(path.join(agentsDir, "hanako"), { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "hanako", "config.yaml"), "agent:\n  name: Hanako\n", "utf-8");
    fs.writeFileSync(path.join(channelsDir, "ch_crew.md"), "---\nid: ch_crew\nmembers: [hanako]\n---\n", "utf-8");

    const activityRecord = vi.fn();
    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          userDir,
          productDir,
          isChannelsEnabled: () => true,
        },
        eventBus: { emit: vi.fn() },
        agentPhoneActivities: { record: activityRecord },
      },
    });

    const result = await router._executeCheck(
      "hanako",
      "ch_crew",
      [{ sender: "user", timestamp: "2026-05-07 17:00:00", body: "需要你决定一下" }],
      [],
    );

    expect(result).toMatchObject({
      replied: false,
      missingDecision: true,
      implicitPass: true,
      repairAttempts: 1,
    });
    expect(runAgentPhoneSessionMock).toHaveBeenCalledTimes(2);
    expect((runAgentPhoneSessionMock.mock.calls as any)[1][1][0].text).toContain("上一轮手机处理没有调用 channel_reply 或 channel_pass");
    const states = activityRecord.mock.calls.map((call) => call[0].state);
    expect(states).toContain("retrying");
    const errorActivity = activityRecord.mock.calls.find((call) => call[0].state === "error")?.[0];
    expect(errorActivity.details).toMatchObject({
      repairAttempts: 1,
      implicitPass: true,
      diagnostics: {
        toolCallCount: 0,
        toolCallNames: [],
        ordinaryTextLength: 9,
      },
    });
    expect(fs.readFileSync(path.join(channelsDir, "ch_crew.md"), "utf-8")).not.toContain("普通文本不应进入频道");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("records per-agent phone activity while processing channel messages", async () => {
    runAgentSessionMock.mockClear();
    runAgentPhoneSessionMock.mockClear();
    (runAgentPhoneSessionMock as any).mockImplementationOnce(async (_agentId: any, _rounds: any, options: any) => {
      const replyTool = options.extraCustomTools.find((tool: any) => tool.name === "channel_reply");
      await replyTool.execute("tool-call-1", { content: "OK" });
      return "";
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-phone-"));
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    const productDir = path.join(root, "product");
    const agentDir = path.join(agentsDir, "hanako");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hanako\n", "utf-8");
    fs.writeFileSync(path.join(channelsDir, "ch_crew.md"), "---\nid: ch_crew\nmembers: [hanako, yui]\n---\n", "utf-8");

    const activityRecord = vi.fn();
    const router = new ChannelRouter({
      hub: {
        engine: {
          channelsDir,
          agentsDir,
          userDir,
          productDir,
          isChannelsEnabled: () => true,
          getAgent: () => ({ agentDir, config: { agent: { name: "Hanako" } }, personality: "I am Hanako" }),
        },
        eventBus: { emit: vi.fn() },
        agentPhoneActivities: { record: activityRecord },
      },
    });

    await router._executeCheck(
      "hanako",
      "ch_crew",
      [{ sender: "user", timestamp: "2026-05-07 17:00:00", body: "@Hanako ping" }],
      [],
    );

    expect(activityRecord.mock.calls.map((call) => call[0].state)).toEqual(
      expect.arrayContaining(["viewed", "replying", "idle"]),
    );

    const projection = readAgentPhoneProjection(getAgentPhoneProjectionPath(agentDir, "ch_crew"));
    expect(projection.meta).toMatchObject({
      agentId: "hanako",
      conversationId: "ch_crew",
      conversationType: "channel",
      state: "idle",
    });
    expect(projection.activities.map((activity) => activity.state)).toEqual(
      expect.arrayContaining(["viewed", "replying", "idle"]),
    );

    fs.rmSync(root, { recursive: true, force: true });
  });
});
