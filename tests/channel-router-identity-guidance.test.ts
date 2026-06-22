import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ChannelRouter } from "../hub/channel-router.ts";

describe("ChannelRouter 群聊身份/成员表注入（#1670）", () => {
  let root;
  let channelsDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-identity-"));
    channelsDir = path.join(root, "channels");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.writeFileSync(
      path.join(channelsDir, "poets.md"),
      "---\nid: poets\nmembers: [libai, dufu]\n---\n",
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeFakeRouter() {
    const names = { libai: "李白", dufu: "杜甫" };
    return {
      _engine: { channelsDir },
      _resolveChannelMemorySenderName: (id) => names[id] || String(id),
      _formatChannelIdentityGuidance: ChannelRouter.prototype._formatChannelIdentityGuidance,
    };
  }

  it("注入成员表并标注自己，提醒身份边界", () => {
    const router = makeFakeRouter();

    const guidance = router._formatChannelIdentityGuidance("libai", "poets", true);

    expect(guidance).toContain("李白（你）");
    expect(guidance).toContain("杜甫");
    expect(guidance).toContain("发言者");
    expect(guidance).toContain("不要替他们发言");
  });

  it("频道 meta 读不到时仍输出身份边界行，不抛错", () => {
    const router = makeFakeRouter();

    const guidance = router._formatChannelIdentityGuidance("libai", "no-such-channel", true);

    expect(guidance).toContain("李白");
    expect(guidance).toContain("只代表");
    expect(guidance).not.toContain("本频道成员");
  });
});
