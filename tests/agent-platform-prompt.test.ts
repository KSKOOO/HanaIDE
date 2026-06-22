import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../core/agent.ts";

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agent-platform-prompt-"));
  tempDirs.push(dir);
  return dir;
}

function makeAgent(locale) {
  const root = makeTempDir();
  const agentsDir = path.join(root, "agents");
  const productDir = path.join(root, "product");
  const userDir = path.join(root, "user");
  fs.mkdirSync(path.join(agentsDir, "hana"), { recursive: true });
  fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, "yuan", "hanako.md"), "Yuan prompt", "utf-8");

  const agent = new Agent({ id: "hana", agentsDir, productDir, userDir } as any);
  agent._config = {
    locale,
    agent: { yuan: "hanako" },
    memory: { enabled: false },
    experience: { enabled: false },
  };
  agent.userName = locale.startsWith("zh") ? "用户" : "User";
  agent.agentName = "HanaIDE";
  return agent;
}

function writeUserProfile(agent, content) {
  fs.writeFileSync(path.join(agent.userDir, "user.md"), content, "utf-8");
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Agent platform prompt identity", () => {
  it("describes the current HanaIDE coding environment without a GitHub project link in Chinese", () => {
    const prompt = makeAgent("zh-CN").buildSystemPrompt({
      forceMemoryEnabled: false,
      forceExperienceEnabled: false,
    });

    expect(prompt).toContain("HanaIDE");
    expect(prompt).toContain("OpenHanako");
    expect(prompt).toContain("编程环境");
    expect(prompt).not.toContain("github.com/liliMozi/openhanako");
  });

  it("describes the current HanaIDE coding environment without a GitHub project link in English", () => {
    const prompt = makeAgent("en").buildSystemPrompt({
      forceMemoryEnabled: false,
      forceExperienceEnabled: false,
    });

    expect(prompt).toContain("You are running in the HanaIDE coding environment (formerly OpenHanako)");
    expect(prompt).not.toContain("github.com/liliMozi/openhanako");
  });

  it("formats prompt times with an unambiguous 24-hour clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T07:53:00.000Z"));

    const agent = makeAgent("en");
    agent._cb = { getTimezone: () => "Asia/Shanghai" };

    const prompt = agent.buildSystemPrompt({
      forceMemoryEnabled: false,
      forceExperienceEnabled: false,
    });

    expect(prompt).toContain("Current date and time:");
    expect(prompt).toContain("15:53");
    expect(prompt).toContain("Your day starts at 04:00.");
    expect(prompt).not.toMatch(/\b(?:AM|PM)\b/);
  });

  it("injects the configured Chinese user name as an explicit profile fact", () => {
    const agent = makeAgent("zh-CN");
    agent._config.user = { name: "黎" };
    agent.userName = "黎";
    writeUserProfile(agent, "喜欢安静、克制的界面。\n");

    const prompt = agent.buildSystemPrompt({
      forceMemoryEnabled: false,
      forceExperienceEnabled: false,
    });

    expect(prompt).toContain("# 用户档案");
    expect(prompt).toContain("用户的名字叫：黎");
    expect(prompt).toContain("喜欢安静、克制的界面。");
    expect(prompt).not.toContain("由用户手动维护");
  });

  it("injects the configured English user name as an explicit profile fact", () => {
    const agent = makeAgent("en");
    agent._config.user = { name: "Li" };
    agent.userName = "Li";
    writeUserProfile(agent, "Prefers quiet interfaces.\n");

    const prompt = agent.buildSystemPrompt({
      forceMemoryEnabled: false,
      forceExperienceEnabled: false,
    });

    expect(prompt).toContain("# User Profile");
    expect(prompt).toContain("The user's name is: Li");
    expect(prompt).toContain("Prefers quiet interfaces.");
    expect(prompt).not.toContain("manually maintained");
  });
});
