import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDmRoute } from "../server/routes/dm.ts";
import { appendMessage } from "../lib/channels/channel-store.ts";
import { getAgentPhoneRuntimePath, updateAgentPhoneRuntime } from "../lib/conversations/agent-phone-runtime.ts";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-dm-route-test-"));
}

function makeAgent(root, id, name = id) {
  const agentDir = path.join(root, "agents", id);
  fs.mkdirSync(path.join(agentDir, "dm"), { recursive: true });
  return { id, name, agentName: name, agentDir };
}

async function writeDm(agent, peerId, sender, body) {
  const filePath = path.join(agent.agentDir, "dm", `${peerId}.md`);
  await appendMessage(filePath, sender, body);
}

describe("dm route owner resolution", () => {
  let tmpDir;
  let app;
  let agents;
  let channelsEnabled;
  let abortAgentPhoneSessions;

  beforeEach(async () => {
    tmpDir = mktemp();
    channelsEnabled = true;
    agents = new Map([
      ["alice", makeAgent(tmpDir, "alice", "Alice")],
      ["bob", makeAgent(tmpDir, "bob", "Bob")],
      ["carol", makeAgent(tmpDir, "carol", "Carol")],
      ["dana", makeAgent(tmpDir, "dana", "Dana")],
    ]);

    await writeDm(agents.get("alice"), "bob", "bob", "primary-owned thread");
    await writeDm(agents.get("dana"), "bob", "bob", "focus-owned thread");
    await writeDm(agents.get("dana"), "alice", "alice", "stale self-looking thread");

    const engine = {
      agentsDir: path.join(tmpDir, "agents"),
      currentAgentId: "dana",
      getPrimaryAgentId: () => "alice",
      getAgent: (id) => agents.get(id) || null,
      listAgents: () => Array.from(agents.values()),
      isChannelsEnabled: () => channelsEnabled,
    };
    abortAgentPhoneSessions = vi.fn();

    app = new Hono();
    app.route("/api", createDmRoute(engine, { abortAgentPhoneSessions }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists primary agent DMs even when the focused agent is different", async () => {
    const res = await app.request("/api/dm");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ownerAgentId).toBe("alice");
    expect(data.dms.map((dm) => dm.peerId).sort()).toEqual(["bob", "carol", "dana"]);
    expect(data.dms.find((dm) => dm.peerId === "alice")).toBeUndefined();
    expect(data.dms.find((dm) => dm.peerId === "bob")).toMatchObject({
      ownerAgentId: "alice",
      peerId: "bob",
      lastMessage: "primary-owned thread",
      messageCount: 1,
    });
  });

  it("freezes DM routes when channels are disabled", async () => {
    channelsEnabled = false;

    const listRes = await app.request("/api/dm");
    expect(listRes.status).toBe(503);
    expect((await listRes.json()).error).toMatch(/disabled/i);

    const detailRes = await app.request("/api/dm/bob");
    expect(detailRes.status).toBe(503);
    expect((await detailRes.json()).error).toMatch(/disabled/i);

    const resetRes = await app.request("/api/dm/bob/reset", { method: "POST" });
    expect(resetRes.status).toBe(503);
    expect((await resetRes.json()).error).toMatch(/disabled/i);
  });

  it("opens the primary agent DM by default and keeps explicit owner override available", async () => {
    const primaryRes = await app.request("/api/dm/bob");

    expect(primaryRes.status).toBe(200);
    const primaryData = await primaryRes.json();
    expect(primaryData).toMatchObject({
      ownerAgentId: "alice",
      peerId: "bob",
      peerName: "Bob",
    });
    expect(primaryData.messages.map((msg) => msg.body)).toEqual(["primary-owned thread"]);

    const explicitRes = await app.request("/api/dm/bob?agentId=dana");
    expect(explicitRes.status).toBe(200);
    const explicitData = await explicitRes.json();
    expect(explicitData.ownerAgentId).toBe("dana");
    expect(explicitData.messages.map((msg) => msg.body)).toEqual(["focus-owned thread"]);
  });

  it("resets one owner projection without deleting the shared DM truth", async () => {
    const alice = agents.get("alice");
    await updateAgentPhoneRuntime({
      agentDir: alice.agentDir,
      agentId: "alice",
      conversationId: "dm:bob",
      conversationType: "dm",
      patch: {
        phoneSessionFile: "phone/sessions/dm_bob/old.jsonl",
        lastPhoneSessionUsedAt: "2026-05-25T12:00:00.000Z",
      },
    });
    const runtimePath = getAgentPhoneRuntimePath(alice.agentDir, "dm:bob");
    expect(fs.existsSync(runtimePath)).toBe(true);

    const resetRes = await app.request("/api/dm/bob/reset?agentId=alice", {
      method: "POST",
    });
    expect(resetRes.status).toBe(200);
    const resetData = await resetRes.json();
    expect(resetData).toMatchObject({
      ok: true,
      ownerAgentId: "alice",
      peerId: "bob",
      visibleAfterTimestamp: expect.any(String),
    });

    const hiddenRes = await app.request("/api/dm/bob?agentId=alice");
    expect(hiddenRes.status).toBe(200);
    expect((await hiddenRes.json()).messages).toEqual([]);

    const listRes = await app.request("/api/dm?agentId=alice");
    const listData = await listRes.json();
    expect(listData.dms.find((dm) => dm.peerId === "bob")).toMatchObject({
      messageCount: 0,
      lastMessage: "",
    });

    const truthFile = path.join(agents.get("alice").agentDir, "dm", "bob.md");
    expect(fs.readFileSync(truthFile, "utf-8")).toContain("primary-owned thread");
    expect(abortAgentPhoneSessions).toHaveBeenCalledWith("dm-reset", {
      agentId: "alice",
      conversationId: "dm:bob",
      conversationType: "dm",
    });
    expect(fs.existsSync(runtimePath)).toBe(false);

    const otherOwnerRes = await app.request("/api/dm/bob?agentId=dana");
    expect((await otherOwnerRes.json()).messages.map((msg) => msg.body)).toEqual(["focus-owned thread"]);
  });
});
