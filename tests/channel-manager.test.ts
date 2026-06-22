/**
 * ChannelManager 单元测试
 *
 * 测试频道 CRUD、成员管理、新 agent 频道初始化。
 * 使用临时目录模拟文件系统操作。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Mock debug-log to prevent file I/O
import { vi } from "vitest";
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({
    log: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { ChannelManager } from "../core/channel-manager.ts";
import { readBookmarks } from "../lib/channels/channel-store.ts";

// ── Helpers ──

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-test-"));
}

function writeChannelMd(channelsDir, name, members, intro = "") {
  const lines = ["---"];
  lines.push(`members: [${members.join(", ")}]`);
  if (intro) lines.push(`intro: "${intro}"`);
  lines.push("---", "");
  fs.writeFileSync(path.join(channelsDir, `${name}.md`), lines.join("\n"), "utf-8");
}

function readMembers(channelsDir, name) {
  const content = fs.readFileSync(path.join(channelsDir, `${name}.md`), "utf-8");
  const match = content.match(/members:\s*\[([^\]]*)\]/);
  if (!match) return [];
  return match[1].split(",").map(s => s.trim()).filter(Boolean);
}

// ── Tests ──

describe("ChannelManager", () => {
  let tmpDir, channelsDir, agentsDir, userDir, manager;

  beforeEach(() => {
    tmpDir = mktemp();
    channelsDir = path.join(tmpDir, "channels");
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    manager = new ChannelManager({
      channelsDir,
      agentsDir,
      userDir,
      getHub: () => null,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createChannelEntry", () => {
    it("creates member and user bookmarks, then emits a channel_created event", async () => {
      for (const agentId of ["alice", "bob"]) {
        fs.mkdirSync(path.join(agentsDir, agentId), { recursive: true });
      }
      const emit = vi.fn();
      const eventingManager = new ChannelManager({
        channelsDir,
        agentsDir,
        userDir,
        getHub: () => ({ eventBus: { emit } }),
      });

      const result = await eventingManager.createChannelEntry({
        name: "Project",
        members: ["alice", "bob"],
        intro: "hello",
      });

      expect(result.id).toMatch(/^ch_/);
      expect(readBookmarks(path.join(agentsDir, "alice", "channels.md")).get(result.id)).toBe("never");
      expect(readBookmarks(path.join(agentsDir, "bob", "channels.md")).get(result.id)).toBe("never");
      expect(readBookmarks(path.join(userDir, "channel-bookmarks.md")).get(result.id)).toBe("never");
      expect(emit).toHaveBeenCalledWith({
        type: "channel_created",
        channelName: result.id,
        channel: expect.objectContaining({
          id: result.id,
          name: "Project",
          members: ["alice", "bob"],
        }),
      }, null);
    });
  });

  describe("deleteChannelByName", () => {
    it("deletes channel file", async () => {
      writeChannelMd(channelsDir, "test-ch", ["a", "b"]);
      expect(fs.existsSync(path.join(channelsDir, "test-ch.md"))).toBe(true);

      await manager.deleteChannelByName("test-ch");
      expect(fs.existsSync(path.join(channelsDir, "test-ch.md"))).toBe(false);
    });

    it("throws on non-existent channel", async () => {
      await expect(manager.deleteChannelByName("nope")).rejects.toThrow(/nope/);
    });

    it("cleans up agent bookmark references", async () => {
      writeChannelMd(channelsDir, "general", ["agent-a"]);

      // Create agent dir (deleteChannelByName scans agentsDir for bookmark cleanup)
      const agentDir = path.join(agentsDir, "agent-a");
      fs.mkdirSync(agentDir, { recursive: true });

      await manager.deleteChannelByName("general");

      // Channel file should be gone
      expect(fs.existsSync(path.join(channelsDir, "general.md"))).toBe(false);
    });
  });

  describe("setupChannelsForNewAgent", () => {
    it("never auto-creates ch_crew, even when multiple agents already exist", async () => {
      const existingDir = path.join(agentsDir, "existing-agent");
      fs.mkdirSync(existingDir, { recursive: true });
      fs.writeFileSync(path.join(existingDir, "config.yaml"), "agent:\n  name: Existing\n", "utf-8");

      const agentDir = path.join(agentsDir, "new-agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: New\n", "utf-8");

      await manager.setupChannelsForNewAgent("new-agent");

      // No all-hands channel is created and the new agent is not subscribed to one.
      expect(fs.existsSync(path.join(channelsDir, "ch_crew.md"))).toBe(false);
      expect(readBookmarks(path.join(agentDir, "channels.md")).has("ch_crew")).toBe(false);
      expect(readBookmarks(path.join(existingDir, "channels.md")).has("ch_crew")).toBe(false);
    });

    it("does NOT auto-join the new agent into an existing crew-style channel", async () => {
      // A user-created channel that happens to exist; the new agent is NOT a member.
      writeChannelMd(channelsDir, "ch_crew", ["existing-agent"]);

      const agentDir = path.join(agentsDir, "new-agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: New\n", "utf-8");

      await manager.setupChannelsForNewAgent("new-agent");

      // Membership of the existing channel is untouched: the new agent is not pulled in.
      const members = readMembers(channelsDir, "ch_crew");
      expect(members).toEqual(["existing-agent"]);
      expect(readBookmarks(path.join(agentDir, "channels.md")).has("ch_crew")).toBe(false);
    });

    it("does NOT create DM channels (DM is separate system now)", async () => {
      const existingDir = path.join(agentsDir, "alice");
      fs.mkdirSync(existingDir, { recursive: true });
      fs.writeFileSync(path.join(existingDir, "config.yaml"), "agent:\n  name: Alice\n", "utf-8");
      fs.writeFileSync(path.join(existingDir, "channels.md"), "", "utf-8");

      const newDir = path.join(agentsDir, "bob");
      fs.mkdirSync(newDir, { recursive: true });
      fs.writeFileSync(path.join(newDir, "config.yaml"), "agent:\n  name: Bob\n", "utf-8");

      await manager.setupChannelsForNewAgent("bob");

      // No DM channel files should exist
      const files = fs.readdirSync(channelsDir);
      const dmFiles = files.filter(f => !f.startsWith("ch_"));
      expect(dmFiles).toHaveLength(0);
    });

    it("projects a cursor for channels the new agent is already a member of", async () => {
      // User manually placed the agent into a channel (e.g. via POST /channels).
      // setupChannelsForNewAgent must still write the read-cursor projection so the
      // agent receives messages from channels it already belongs to.
      writeChannelMd(channelsDir, "ch_project", ["existing-agent", "new-agent"]);
      writeChannelMd(channelsDir, "ch_other", ["existing-agent"]);

      const agentDir = path.join(agentsDir, "new-agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: New\n", "utf-8");

      await manager.setupChannelsForNewAgent("new-agent");

      const bookmarks = readBookmarks(path.join(agentDir, "channels.md"));
      // Member channel is projected as an unread cursor.
      expect(bookmarks.get("ch_project")).toBe("never");
      // Non-member channel is not projected.
      expect(bookmarks.has("ch_other")).toBe(false);
    });
  });

  describe("repairChannelCursorProjection", () => {
    it("adds missing agent cursor entries from channel membership without changing channel data", async () => {
      writeChannelMd(channelsDir, "ch_team", ["hana", "yui", "ghost"]);
      fs.mkdirSync(path.join(agentsDir, "hana"), { recursive: true });
      fs.writeFileSync(path.join(agentsDir, "hana", "config.yaml"), "agent:\n  name: Hana\n", "utf-8");
      fs.writeFileSync(path.join(agentsDir, "hana", "channels.md"), "# 频道\n\n", "utf-8");
      fs.mkdirSync(path.join(agentsDir, "yui"), { recursive: true });
      fs.writeFileSync(path.join(agentsDir, "yui", "config.yaml"), "agent:\n  name: Yui\n", "utf-8");

      await manager.repairChannelCursorProjection();

      expect(readBookmarks(path.join(agentsDir, "hana", "channels.md")).get("ch_team")).toBe("never");
      expect(readBookmarks(path.join(agentsDir, "yui", "channels.md")).get("ch_team")).toBe("never");
      expect(fs.existsSync(path.join(agentsDir, "ghost", "channels.md"))).toBe(false);
      expect(readMembers(channelsDir, "ch_team")).toEqual(["hana", "yui", "ghost"]);
    });
  });

  describe("cleanupAgentFromChannels", () => {
    it("removes agent from channel members", async () => {
      writeChannelMd(channelsDir, "crew", ["alice", "bob", "charlie"]);

      await manager.cleanupAgentFromChannels("bob");

      const members = readMembers(channelsDir, "crew");
      expect(members).toContain("alice");
      expect(members).toContain("charlie");
      expect(members).not.toContain("bob");
    });

    it("aborts running phone sessions for an agent removed from a channel", async () => {
      writeChannelMd(channelsDir, "crew", ["alice", "bob", "charlie"]);
      const abortAgentPhoneSessions = vi.fn();
      const abortingManager = new ChannelManager({
        channelsDir,
        agentsDir,
        userDir,
        getHub: () => ({ abortAgentPhoneSessions }),
      });

      await abortingManager.cleanupAgentFromChannels("bob");

      expect(abortAgentPhoneSessions).toHaveBeenCalledWith("channel-member-removed", {
        agentId: "bob",
        conversationId: "crew",
        conversationType: "channel",
      });
    });

    it("deletes channel when members drop to 1 or fewer", async () => {
      writeChannelMd(channelsDir, "alice-bob", ["alice", "bob"]);

      await manager.cleanupAgentFromChannels("bob");

      // DM channel should be deleted (only alice left)
      expect(fs.existsSync(path.join(channelsDir, "alice-bob.md"))).toBe(false);
    });

    it("no-ops when channelsDir does not exist", async () => {
      const badManager = new ChannelManager({
        channelsDir: "/nonexistent",
        agentsDir,
        userDir,
        getHub: () => null,
      });

      await expect(badManager.cleanupAgentFromChannels("x")).resolves.toBeUndefined();
    });
  });
});
