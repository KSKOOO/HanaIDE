import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChannel,
  appendMessage,
  updateChannelMeta,
  removeChannelMember,
  removeBookmarkEntry,
  readBookmarks,
} from "../lib/channels/channel-store.ts";
import { buildChannelUnreadDeliveryWindow, createChannelTicker } from "../lib/channels/channel-ticker.ts";

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-ticker-"));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("channel-ticker membership source", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("builds a rolling unread delivery window capped at the most recent 20 messages for missing bookmarks", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui"],
    } as any);
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    for (let i = 1; i <= 25; i += 1) {
      await appendMessage(channelFile, "user", `message ${i}`);
    }

    const window = buildChannelUnreadDeliveryWindow({
      channelFile,
      bookmark: undefined,
      agentId: "hana",
    });

    expect(window.totalUnreadCount).toBe(25);
    expect(window.droppedUnreadCount).toBe(5);
    expect(window.bookmarkState).toBe("missing");
    expect(window.messages.map((message) => message.body)).toEqual(
      Array.from({ length: 20 }, (_, idx) => `message ${idx + 6}`),
    );
  });

  it("passes the rolling unread delivery window metadata into immediate phone delivery", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    const agentDir = path.join(agentsDir, "hana");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "channels.md"), "# 频道\n\n- ch_crew (last: never)\n", "utf-8");

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui"],
    } as any);
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    for (let i = 1; i <= 23; i += 1) {
      await appendMessage(channelFile, "user", `message ${i}`);
    }

    const executeCheck = vi.fn(async () => ({ replied: false, passed: true }));
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["hana"],
      executeCheck,
      onMemorySummarize: vi.fn(),
    } as any);

    ticker.start();
    try {
      await ticker.triggerImmediate(channelId);
    } finally {
      await ticker.stop();
    }

    expect(executeCheck).toHaveBeenCalledOnce();
    expect((executeCheck.mock.calls as any)[0][2].map((message: any) => message.body)).toEqual(
      Array.from({ length: 20 }, (_, idx) => `message ${idx + 4}`),
    );
    expect((executeCheck.mock.calls as any)[0][4]).toMatchObject({
      deliveryWindow: {
        totalUnreadCount: 23,
        droppedUnreadCount: 3,
        bookmarkState: "never",
      },
    });
  });

  it("exposes the active phone delivery snapshot for channel progress UI", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    const agentDir = path.join(agentsDir, "hana");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "channels.md"), "# 频道\n\n- ch_crew (last: never)\n", "utf-8");

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui"],
    } as any);
    await appendMessage(path.join(channelsDir, `${channelId}.md`), "user", "ping");

    const started = deferred();
    const executeCheck = vi.fn(async (_agentId, _channelName, _messages, _updates, opts) => {
      started.resolve();
      await new Promise((resolve) => opts.signal.addEventListener("abort", resolve, { once: true }));
      return { replied: false };
    });
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["hana"],
      executeCheck,
      onMemorySummarize: vi.fn(),
    } as any);

    ticker.start();
    const delivery = ticker.triggerImmediate(channelId);
    await started.promise;

    expect(ticker.snapshot(channelId)).toMatchObject({
      active: {
        channelName: channelId,
        agentId: "hana",
        delivered: 1,
        agentCount: 1,
        checks: 1,
      },
    });

    await ticker.stop();
    await delivery;
  });

  it("aborts the active immediate delivery synchronously when a newer channel message arrives", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    const agentDir = path.join(agentsDir, "hana");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "channels.md"), "# 频道\n\n- ch_crew (last: never)\n", "utf-8");

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui"],
    } as any);
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    await appendMessage(channelFile, "user", "first");

    const started = deferred();
    let firstSignal = null;
    const executeCheck = vi.fn(async (_agentId, _channelName, _newMessages, _allUpdates, opts) => {
      if (!firstSignal) {
        firstSignal = opts.signal;
        started.resolve();
        await new Promise((resolve) => opts.signal.addEventListener("abort", resolve, { once: true }));
      }
      return { replied: false, missingDecision: true };
    });
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["hana"],
      executeCheck,
      onMemorySummarize: vi.fn(),
    } as any);

    ticker.start();
    const firstDelivery = ticker.triggerImmediate(channelId);
    await started.promise;
    await appendMessage(channelFile, "user", "second");
    const secondDelivery = ticker.triggerImmediate(channelId);

    const abortedPromptly = await Promise.race([
      firstSignal.aborted
        ? Promise.resolve(true)
        : new Promise((resolve) => firstSignal.addEventListener("abort", () => resolve(true), { once: true })),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);

    try {
      expect(abortedPromptly).toBe(true);
    } finally {
      await ticker.stop();
      await firstDelivery.catch(() => {});
      await secondDelivery.catch(() => {});
    }
  });

  it("delivers unread channel messages to an agent listed in channel members even when its cursor projection is missing", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    const agentDir = path.join(agentsDir, "hana");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "channels.md"), "# 频道\n\n", "utf-8");

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui"],
    } as any);
    await appendMessage(path.join(channelsDir, `${channelId}.md`), "user", "@Hana hello");

    const executeCheck = vi.fn(async () => ({ replied: false, passed: true }));
    const onMemorySummarize = vi.fn();
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["hana"],
      executeCheck,
      onMemorySummarize,
    } as any);

    ticker.start();
    try {
      await ticker.triggerImmediate(channelId);
    } finally {
      await ticker.stop();
    }

    expect(executeCheck).toHaveBeenCalledOnce();
    expect((executeCheck.mock.calls as any)[0][0]).toBe("hana");
    expect((executeCheck.mock.calls as any)[0][1]).toBe(channelId);
    expect(onMemorySummarize).toHaveBeenCalledWith(
      "hana",
      channelId,
      expect.objectContaining({
        messages: [expect.objectContaining({ sender: "user", body: "@Hana hello" })],
      }),
    );
  });

  it("skips a member removed while delivery is in progress and does not recreate its bookmark", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    for (const agentId of ["hana", "yui"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "channels.md"), "# 频道\n\n- ch_crew (last: never)\n", "utf-8");
    }

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui"],
    } as any);
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    await appendMessage(channelFile, "user", "这条消息不该再投给被移出的成员");

    const seen = [];
    const executeCheck = vi.fn(async (agentId) => {
      seen.push(agentId);
      if (agentId === "hana") {
        await removeChannelMember(channelFile, "yui");
        await removeBookmarkEntry(path.join(agentsDir, "yui", "channels.md"), channelId);
      }
      return { replied: false, passed: true };
    });
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["hana", "yui"],
      executeCheck,
      onMemorySummarize: vi.fn(),
    } as any);

    ticker.start();
    try {
      await ticker.triggerImmediate(channelId);
    } finally {
      await ticker.stop();
    }

    expect(seen).toEqual(["hana"]);
    expect(readBookmarks(path.join(agentsDir, "yui", "channels.md")).has(channelId)).toBe(false);
  });

  it("delivers only each agent's unread group messages and loops until everyone is caught up", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    for (const agentId of ["hana", "yui", "ming"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "channels.md"), "# 频道\n\n", "utf-8");
    }

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui", "ming"],
    } as any);
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    await appendMessage(channelFile, "user", "谁想接一下这个话题？");

    const seen = [];
    const decisions = [
      { replied: true, replyContent: "我先接一下。" },
      { replied: false, passed: true },
      { replied: false, passed: true },
    ];
    let decisionIndex = 0;
    const executeCheck = vi.fn(async (agentId, _channelName, newMessages) => {
      seen.push({ agentId, bodies: newMessages.map((message) => message.body) });
      const result = decisions[decisionIndex++] || { replied: false };
      if (result.replied) {
        await appendMessage(channelFile, agentId, result.replyContent);
      }
      return result;
    });
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["hana", "yui", "ming"],
      executeCheck,
      onMemorySummarize: vi.fn(),
    } as any);

    ticker.start();
    try {
      await ticker.triggerImmediate(channelId);
    } finally {
      await ticker.stop();
    }

    expect(seen).toEqual([
      { agentId: "hana", bodies: ["谁想接一下这个话题？"] },
      { agentId: "yui", bodies: ["谁想接一下这个话题？", "我先接一下。"] },
      { agentId: "ming", bodies: ["谁想接一下这个话题？", "我先接一下。"] },
    ]);
  });

  it("advances the bookmark after an implicit skipped channel decision without summarizing memory", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    const agentDir = path.join(agentsDir, "hana");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "channels.md"), "# 频道\n\n- ch_crew (last: never)\n", "utf-8");

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui"],
    } as any);
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    await appendMessage(channelFile, "user", "这条消息不应该无限重投");

    const executeCheck = vi.fn(async () => ({ replied: false, missingDecision: true, implicitPass: true }));
    const onMemorySummarize = vi.fn();
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["hana"],
      executeCheck,
      onMemorySummarize,
    } as any);

    ticker.start();
    try {
      await ticker.triggerImmediate(channelId);
      await ticker.triggerImmediate(channelId);
    } finally {
      await ticker.stop();
    }

    expect(executeCheck).toHaveBeenCalledOnce();
    expect(readBookmarks(path.join(agentDir, "channels.md")).get(channelId)).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
    expect(onMemorySummarize).not.toHaveBeenCalled();
  });

  it("advances the bookmark only through the delivered unread window", async () => {
    vi.useFakeTimers();
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    const agentDir = path.join(agentsDir, "hana");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "channels.md"), "# 频道\n\n- ch_crew (last: never)\n", "utf-8");

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui"],
    } as any);
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    vi.setSystemTime(new Date("2026-05-30T00:00:00Z"));
    const first = await appendMessage(channelFile, "user", "投递窗口里的消息");

    const executeCheck = vi.fn(async () => {
      vi.setSystemTime(new Date("2026-05-30T00:00:05Z"));
      await appendMessage(channelFile, "user", "检查期间新到的消息");
      return { replied: false, passed: true };
    });
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["hana"],
      executeCheck,
      onMemorySummarize: vi.fn(),
    } as any);

    ticker.start();
    try {
      await ticker.triggerImmediate(channelId);
    } finally {
      await ticker.stop();
      vi.useRealTimers();
    }

    expect(readBookmarks(path.join(agentDir, "channels.md")).get(channelId)).toBe(first.timestamp);
  });

  it("prioritizes mentioned agents while still delivering mention context to other members", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    for (const agentId of ["hana", "yui", "ming"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "channels.md"), "# 频道\n\n", "utf-8");
    }

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui", "ming"],
    } as any);
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    await appendMessage(channelFile, "user", "@Yui 可以先看一下吗？");

    const seen = [];
    const executeCheck = vi.fn(async (agentId, _channelName, _newMessages, _allUpdates, opts) => {
      seen.push({
        agentId,
        mentionedAgents: opts?.mentionedAgents,
        mentionTargeted: opts?.mentionTargeted,
      });
      return { replied: false, passed: true };
    });
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["hana", "yui", "ming"],
      executeCheck,
      onMemorySummarize: vi.fn(),
    } as any);

    ticker.start();
    try {
      await ticker.triggerImmediate(channelId, { mentionedAgents: ["yui"] });
    } finally {
      await ticker.stop();
    }

    expect(seen).toEqual([
      { agentId: "yui", mentionedAgents: ["yui"], mentionTargeted: true },
      { agentId: "hana", mentionedAgents: ["yui"], mentionTargeted: false },
      { agentId: "ming", mentionedAgents: ["yui"], mentionTargeted: false },
    ]);
  });

  it("proactively reminds one random channel member with recent channel truth", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    for (const agentId of ["hana", "yui", "ming"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "channels.md"), "# 频道\n\n", "utf-8");
    }

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui", "ming"],
    } as any);
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    await appendMessage(channelFile, "user", "频道最近的事实");

    const executeCheck = vi.fn(async () => ({ replied: false, passed: true }));
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["hana", "yui", "ming"],
      executeCheck,
      onMemorySummarize: vi.fn(),
      random: () => 0.6,
    } as any);

    ticker.start();
    try {
      await ticker.triggerReminder(channelId);
    } finally {
      await ticker.stop();
    }

    expect(executeCheck).toHaveBeenCalledOnce();
    expect((executeCheck.mock.calls as any)[0][0]).toBe("yui");
    expect((executeCheck.mock.calls as any)[0][1]).toBe(channelId);
    expect((executeCheck.mock.calls as any)[0][2].map((message: any) => message.body)).toEqual(["频道最近的事实"]);
    expect((executeCheck.mock.calls as any)[0][4]).toMatchObject({ proactive: true });
  });

  it("does not proactively remind channel members when proactive initiation is disabled", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    for (const agentId of ["hana", "yui", "ming"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "channels.md"), "# 频道\n\n", "utf-8");
    }

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui", "ming"],
    } as any);
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    await updateChannelMeta(channelFile, { agentPhoneProactiveEnabled: "false" });
    await appendMessage(channelFile, "user", "频道最近的事实");

    const executeCheck = vi.fn(async () => ({ replied: false, passed: true }));
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["hana", "yui", "ming"],
      executeCheck,
      onMemorySummarize: vi.fn(),
      random: () => 0.6,
    } as any);

    ticker.start();
    try {
      await ticker.triggerReminder(channelId);
    } finally {
      await ticker.stop();
    }

    expect(executeCheck).not.toHaveBeenCalled();
  });

  it("does not deliver immediate or proactive phone checks while the ticker is globally disabled", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    for (const agentId of ["hana", "yui"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "channels.md"), "# 频道\n\n- ch_crew (last: never)\n", "utf-8");
    }

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui"],
    } as any);
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    await appendMessage(channelFile, "user", "ping");

    const executeCheck = vi.fn(async () => ({ replied: false, passed: true }));
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["hana", "yui"],
      executeCheck,
      onMemorySummarize: vi.fn(),
      isEnabled: () => false,
    } as any);

    ticker.start();
    try {
      await ticker.triggerImmediate(channelId);
      await ticker.triggerReminder(channelId);
    } finally {
      await ticker.stop();
    }

    expect(executeCheck).not.toHaveBeenCalled();
  });

  it("expands proactive reminder into normal delivery when the starter posts", async () => {
    tmpDir = mktemp();
    const channelsDir = path.join(tmpDir, "channels");
    const agentsDir = path.join(tmpDir, "agents");
    for (const agentId of ["hana", "yui", "ming"]) {
      const agentDir = path.join(agentsDir, agentId);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "channels.md"), "# 频道\n\n", "utf-8");
    }

    const { id: channelId } = await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["hana", "yui", "ming"],
    } as any);
    const channelFile = path.join(channelsDir, `${channelId}.md`);
    await appendMessage(channelFile, "user", "频道最近的事实");

    const seen = [];
    const executeCheck = vi.fn(async (agentId, _channelName, newMessages, _allUpdates, opts) => {
      seen.push({
        agentId,
        proactive: opts?.proactive === true,
        bodies: newMessages.map((message) => message.body),
      });
      if (agentId === "yui" && opts?.proactive) {
        await appendMessage(channelFile, agentId, "我来开个头。");
        return { replied: true, replyContent: "我来开个头。" };
      }
      return { replied: false, passed: true };
    });
    const ticker = createChannelTicker({
      channelsDir,
      agentsDir,
      getAgentOrder: () => ["hana", "yui", "ming"],
      executeCheck,
      onMemorySummarize: vi.fn(),
      random: () => 0.6,
    } as any);

    ticker.start();
    try {
      await ticker.triggerReminder(channelId);
    } finally {
      await ticker.stop();
    }

    expect(seen).toEqual([
      { agentId: "yui", proactive: true, bodies: ["频道最近的事实"] },
      { agentId: "hana", proactive: false, bodies: ["频道最近的事实", "我来开个头。"] },
      { agentId: "ming", proactive: false, bodies: ["频道最近的事实", "我来开个头。"] },
    ]);
  });
});
