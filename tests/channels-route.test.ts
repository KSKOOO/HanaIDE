import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import fs from "fs";
import os from "os";
import path from "path";
import { createChannelsRoute } from "../server/routes/channels.ts";
import { ChannelManager } from "../core/channel-manager.ts";
import { createChannel, getChannelMeta, readBookmarks } from "../lib/channels/channel-store.ts";
import {
  getAgentPhoneProjectionPath,
  readAgentPhoneProjection,
  updateAgentPhoneProjectionMeta,
} from "../lib/conversations/agent-phone-projection.ts";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-channels-route-test-"));
}

describe("channels route membership contract", () => {
  let tmpDir;
  let app;
  let engine;
  let refreshChannelProactiveSchedule;
  let triggerChannelDelivery;
  let abortAgentPhoneSessions;
  let agentList;
  let channelsEnabled;

  beforeEach(() => {
    tmpDir = mktemp();
    agentList = [];
    channelsEnabled = true;
    engine = {
      channelsDir: path.join(tmpDir, "channels"),
      agentsDir: path.join(tmpDir, "agents"),
      userDir: path.join(tmpDir, "user"),
      userName: "user",
      currentAgentId: "alice",
      getPrimaryAgentId: () => "alice",
      isChannelsEnabled: () => channelsEnabled,
      setChannelsEnabled: vi.fn(async (enabled) => {
        channelsEnabled = !!enabled;
      }),
      availableModels: [
        { id: "deepseek-v4-flash", provider: "deepseek", name: "DeepSeek V4 Flash" },
      ],
      listAgents: () => agentList,
      getAgent: (id) => ["alice", "bob", "carol"].includes(id)
        ? { id, agentDir: path.join(tmpDir, "agents", id) }
        : null,
    };
    fs.mkdirSync(engine.channelsDir, { recursive: true });
    fs.mkdirSync(engine.agentsDir, { recursive: true });
    fs.mkdirSync(engine.userDir, { recursive: true });
    for (const id of ["alice", "bob", "carol"]) {
      fs.mkdirSync(path.join(engine.agentsDir, id), { recursive: true });
    }
    const channelManager = new ChannelManager({
      channelsDir: engine.channelsDir,
      agentsDir: engine.agentsDir,
      userDir: engine.userDir,
      getHub: () => ({ eventBus: { emit: vi.fn() } }),
    });
    engine.createChannelEntry = (input) => channelManager.createChannelEntry(input);

    refreshChannelProactiveSchedule = vi.fn();
    triggerChannelDelivery = vi.fn(() => Promise.resolve());
    abortAgentPhoneSessions = vi.fn();
    app = new Hono();
    app.route("/api", createChannelsRoute(engine, {
      triggerChannelDelivery,
      refreshChannelProactiveSchedule,
      abortAgentPhoneSessions,
      agentPhoneActivities: {
        snapshot: (conversationId) => conversationId === "ch_crew"
          ? [{ conversationId, agentId: "hana", state: "idle", summary: "已回复" }]
          : [],
      },
      channelRouter: {
        tickerSnapshot: (conversationId) => conversationId === "ch_crew"
          ? { active: { channelName: conversationId, agentId: "hana", delivered: 1, agentCount: 2 } }
          : null,
      },
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects creating a group channel with fewer than two unique agent members", async () => {
    const res = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Solo",
        members: ["alice"],
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/at least 2/i);
  });

  it("rejects creating a channel with a missing agent member before writing the channel file", async () => {
    const res = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Mixed Crew",
        members: ["alice", "ghost"],
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      code: "CHANNEL_AGENT_NOT_FOUND",
      error: "Agent not found: ghost",
    });
    expect(fs.readdirSync(engine.channelsDir)).toEqual([]);
    expect(fs.existsSync(path.join(engine.userDir, "channels.md"))).toBe(false);
  });

  it("freezes channel and phone settings routes when channels are disabled", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob"],
    } as any);
    channelsEnabled = false;

    const requests = [
      () => app.request("/api/conversations/ch_crew/agent-activities"),
      () => app.request("/api/conversations/ch_crew/agent-phone-settings"),
      () => app.request("/api/conversations/ch_crew/agent-phone-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "write" }),
      }),
      () => app.request("/api/conversations/ch_crew/agent-phone-tool-mode"),
      () => app.request("/api/conversations/ch_crew/agent-phone-tool-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "write" }),
      }),
      () => app.request("/api/conversations/dm%3Abob/agent-phone-settings"),
      () => app.request("/api/conversations/dm%3Abob/agent-phone-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "write" }),
      }),
      () => app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode"),
      () => app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "write" }),
      }),
      () => app.request("/api/channels"),
      () => app.request("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Crew", members: ["alice", "bob"] }),
      }),
      () => app.request("/api/channels/ch_crew"),
      () => app.request("/api/channels/ch_crew/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: "carol" }),
      }),
      () => app.request("/api/channels/ch_crew/members/bob", { method: "DELETE" }),
      () => app.request("/api/channels/ch_crew/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "hello" }),
      }),
      () => app.request("/api/channels/ch_crew/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timestamp: new Date().toISOString() }),
      }),
      () => app.request("/api/channels/ch_crew", { method: "DELETE" }),
    ];

    for (const request of requests) {
      const res = await request();
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/disabled/i);
    }

    const toggleRes = await app.request("/api/channels/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(toggleRes.status).toBe(200);
    expect(await toggleRes.json()).toMatchObject({ ok: true, enabled: true });
    expect(engine.setChannelsEnabled).toHaveBeenCalledWith(true);
  });

  it("returns agent phone activities for a conversation", async () => {
    const res = await app.request("/api/conversations/ch_crew/agent-activities");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activities).toEqual([
      expect.objectContaining({
        conversationId: "ch_crew",
        agentId: "hana",
        state: "idle",
      }),
    ]);
    expect(data.ticker).toEqual({
      active: { channelName: "ch_crew", agentId: "hana", delivered: 1, agentCount: 2 },
    });
  });

  it("persists channel agent phone tool mode in channel metadata", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob"],
    } as any);

    const setRes = await app.request("/api/conversations/ch_crew/agent-phone-tool-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "write" }),
    });

    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toMatchObject({ mode: "write" });
    expect(getChannelMeta(path.join(channelsDir, "ch_crew.md")).agentPhoneToolMode).toBe("write");

    const getRes = await app.request("/api/conversations/ch_crew/agent-phone-tool-mode");
    expect(await getRes.json()).toMatchObject({ mode: "write" });
  });

  it("persists DM agent phone tool mode in the owner agent's conversation projection (#1614 切换入口持久化)", async () => {
    // 默认 read_only（未配置过）
    const before = await app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode?agentId=alice");
    expect(await before.json()).toMatchObject({ mode: "read_only" });

    const setRes = await app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode?agentId=alice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "write" }),
    });
    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toMatchObject({ ok: true, mode: "write" });

    // 状态归属：写进 conversation 自己的 projection meta（dm-router 回信时从这里读）
    const aliceDir = path.join(tmpDir, "agents", "alice");
    const projection = readAgentPhoneProjection(getAgentPhoneProjectionPath(aliceDir, "dm:bob"));
    expect((projection.meta as any).toolMode).toBe("write");

    const getRes = await app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode?agentId=alice");
    expect(await getRes.json()).toMatchObject({ mode: "write" });

    // 切回 read_only 同样持久化（双向切换）
    await app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode?agentId=alice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "read_only" }),
    });
    const reverted = readAgentPhoneProjection(getAgentPhoneProjectionPath(aliceDir, "dm:bob"));
    expect((reverted.meta as any).toolMode).toBe("read_only");
  });

  it("aborts the removed member's running phone session when removing a channel member", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob", "carol"],
    } as any);

    const res = await app.request("/api/channels/ch_crew/members/bob", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, members: ["alice", "carol"] });
    expect(abortAgentPhoneSessions).toHaveBeenCalledWith("channel-member-removed", {
      agentId: "bob",
      conversationId: "ch_crew",
      conversationType: "channel",
    });
  });

  it("reads DM phone settings from the primary agent when focus is different", async () => {
    engine.currentAgentId = "carol";
    await updateAgentPhoneProjectionMeta({
      agentDir: path.join(tmpDir, "agents", "alice"),
      agentId: "alice",
      conversationId: "dm:bob",
      conversationType: "dm",
      patch: {
        toolMode: "write",
        replyMinChars: "20",
        replyMaxChars: "80",
        proactiveEnabled: "false",
        reminderIntervalMinutes: "45",
        guardLimit: "7",
        modelOverrideEnabled: "true",
        modelOverrideId: "deepseek-v4-flash",
        modelOverrideProvider: "deepseek",
      },
    });

    const res = await app.request("/api/conversations/dm%3Abob/agent-phone-settings");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      mode: "write",
      replyMinChars: 20,
      replyMaxChars: 80,
      proactiveEnabled: false,
      reminderIntervalMinutes: 45,
      guardLimit: 7,
      modelOverrideEnabled: true,
      modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
    });
  });

  it("persists DM phone settings with the same setting surface as two-agent conversations", async () => {
    engine.currentAgentId = "carol";

    const setRes = await app.request("/api/conversations/dm%3Abob/agent-phone-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "write",
        replyMinChars: 12,
        replyMaxChars: 34,
        proactiveEnabled: false,
        reminderIntervalMinutes: 45,
        guardLimit: 5,
        modelOverrideEnabled: true,
        modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
      }),
    });

    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toMatchObject({
      mode: "write",
      replyMinChars: 12,
      replyMaxChars: 34,
      proactiveEnabled: false,
      reminderIntervalMinutes: 45,
      guardLimit: 5,
      modelOverrideEnabled: true,
      modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
    });

    const getRes = await app.request("/api/conversations/dm%3Abob/agent-phone-settings");
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({
      mode: "write",
      replyMinChars: 12,
      replyMaxChars: 34,
      proactiveEnabled: false,
      reminderIntervalMinutes: 45,
      guardLimit: 5,
      modelOverrideEnabled: true,
      modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
    });
  });

  it("persists channel phone settings without the removed reply-scope field", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob"],
    } as any);

    const setRes = await app.request("/api/conversations/ch_crew/agent-phone-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "write",
        replyMinChars: 20,
        replyMaxChars: 80,
        proactiveEnabled: false,
        reminderIntervalMinutes: 45,
        guardLimit: 9,
        modelOverrideEnabled: true,
        modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
      }),
    });

    expect(setRes.status).toBe(200);
    const setJson = await setRes.json();
    expect(setJson).toMatchObject({
      mode: "write",
      replyMinChars: 20,
      replyMaxChars: 80,
      proactiveEnabled: false,
      reminderIntervalMinutes: 45,
      guardLimit: 9,
      modelOverrideEnabled: true,
      modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
    });
    expect(setJson).not.toHaveProperty("replyInstructions");
    const meta = getChannelMeta(path.join(channelsDir, "ch_crew.md"));
    expect(meta.agentPhoneReplyInstructions).toBeUndefined();
    expect(meta.agentPhoneReplyMinChars).toBe("20");
    expect(meta.agentPhoneReplyMaxChars).toBe("80");
    expect(meta.agentPhoneProactiveEnabled).toBe("false");
    expect(meta.agentPhoneReminderIntervalMinutes).toBe("45");
    expect(meta.agentPhoneGuardLimit).toBe("9");
    expect(meta.agentPhoneModelOverrideEnabled).toBe("true");
    expect(meta.agentPhoneModelOverrideId).toBe("deepseek-v4-flash");
    expect(meta.agentPhoneModelOverrideProvider).toBe("deepseek");
    expect(refreshChannelProactiveSchedule).toHaveBeenCalledOnce();

    const getRes = await app.request("/api/conversations/ch_crew/agent-phone-settings");
    const getJson = await getRes.json();
    expect(getJson).toMatchObject({
      mode: "write",
      replyMinChars: 20,
      replyMaxChars: 80,
      proactiveEnabled: false,
      reminderIntervalMinutes: 45,
      guardLimit: 9,
      modelOverrideEnabled: true,
      modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
    });
    expect(getJson).not.toHaveProperty("replyInstructions");
  });

  it("returns default reminder and model override settings for legacy channel metadata", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_legacy",
      name: "Legacy",
      members: ["alice", "bob"],
    } as any);

    const res = await app.request("/api/conversations/ch_legacy/agent-phone-settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      proactiveEnabled: true,
      reminderIntervalMinutes: 31,
      guardLimit: 24,
      modelOverrideEnabled: false,
      modelOverrideModel: null,
    });
  });

  it("adds an agent member and creates its channel bookmark", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob"],
    } as any);

    const res = await app.request("/api/channels/ch_crew/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: "carol" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ members: ["alice", "bob", "carol"] });
    expect(getChannelMeta(path.join(channelsDir, "ch_crew.md")).members).toEqual(["alice", "bob", "carol"]);
    expect(readBookmarks(path.join(tmpDir, "agents", "carol", "channels.md")).get("ch_crew")).toBe("never");
  });

  it("removes an agent member but refuses to go below the group minimum", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob", "carol"],
    } as any);

    const removeCarol = await app.request("/api/channels/ch_crew/members/carol", {
      method: "DELETE",
    });
    expect(removeCarol.status).toBe(200);
    expect(await removeCarol.json()).toMatchObject({ members: ["alice", "bob"] });
    expect(readBookmarks(path.join(tmpDir, "agents", "carol", "channels.md")).has("ch_crew")).toBe(false);

    const removeBob = await app.request("/api/channels/ch_crew/members/bob", {
      method: "DELETE",
    });
    expect(removeBob.status).toBe(400);
    expect((await removeBob.json()).error).toMatch(/at least 2/i);
    expect(getChannelMeta(path.join(channelsDir, "ch_crew.md")).members).toEqual(["alice", "bob"]);
  });

  it("passes resolved @mentions as scheduling hints when the user posts a channel message", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    agentList = [
      { id: "alice", name: "Alice" },
      { id: "bob", name: "Bob Ray" },
      { id: "carol", name: "Carol" },
    ];
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob", "carol"],
    } as any);

    const res = await app.request("/api/channels/ch_crew/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "@Bob Ray 可以看一下吗？" }),
    });

    expect(res.status).toBe(200);
    expect(triggerChannelDelivery).toHaveBeenCalledWith("ch_crew", { mentionedAgents: ["bob"] });
  });

  it("persists DM agent phone tool mode in the primary agent projection by default", async () => {
    const setRes = await app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "write" }),
    });

    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toMatchObject({ mode: "write" });

    const getRes = await app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode");
    expect(await getRes.json()).toMatchObject({ mode: "write" });
  });
});
