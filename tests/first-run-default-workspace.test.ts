import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("first run default workspace", () => {
  let tmpDir;
  let homeDir;
  let productDir;
  let hanakoHome;
  let homedirSpy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-first-run-workspace-"));
    homeDir = path.join(tmpDir, "home");
    productDir = path.join(tmpDir, "product");
    hanakoHome = path.join(tmpDir, ".hanako");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(productDir, { recursive: true });
    fs.writeFileSync(
      path.join(productDir, "config.example.yaml"),
      [
        "agent:",
        "  name: HanaIDE",
        "  yuan: hanako",
        "user:",
        '  name: ""',
        "models:",
        '  chat: ""',
      ].join("\n"),
      "utf-8",
    );
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  });

  afterEach(() => {
    homedirSpy?.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("seeds hanako with the desktop OH-WorkSpace, enabled memory, and disabled patrol defaults", async () => {
    const { ensureFirstRun } = await import("../core/first-run.ts");

    ensureFirstRun(hanakoHome, productDir);

    const workspace = path.join(homeDir, "Desktop", "OH-WorkSpace");
    const cfgPath = path.join(hanakoHome, "agents", "hanako", "config.yaml");
    const cfg = YAML.load(fs.readFileSync(cfgPath, "utf-8"));

    expect(fs.statSync(workspace).isDirectory()).toBe(true);
    expect(cfg.desk.home_folder).toBe(workspace);
    expect(cfg.desk.heartbeat_enabled).toBe(false);
    expect(cfg.desk.heartbeat_interval).toBe(31);
    expect(cfg.memory.enabled).toBe(true);
  });

  it("keeps userName as a dynamic identity placeholder for first-run HanaIDE", async () => {
    fs.mkdirSync(path.join(productDir, "identity-templates"), { recursive: true });
    fs.writeFileSync(
      path.join(productDir, "identity-templates", "hanako.md"),
      "# {{agentName}}\n\n{{userName}}的个人助手。\n",
      "utf-8",
    );
    const { ensureFirstRun } = await import("../core/first-run.ts");

    ensureFirstRun(hanakoHome, productDir);

    const identity = fs.readFileSync(
      path.join(hanakoHome, "agents", "hanako", "identity.md"),
      "utf-8",
    );
    expect(identity).toContain("# {{agentName}}");
    expect(identity).toContain("{{userName}}的个人助手");
    expect(identity).not.toContain("\n\n的个人助手");
  });

  it("repairs a half-initialized default hanako agent directory", async () => {
    fs.mkdirSync(path.join(hanakoHome, "agents", "hanako", "memory"), { recursive: true });
    const { ensureFirstRun } = await import("../core/first-run.ts");

    ensureFirstRun(hanakoHome, productDir);

    const cfgPath = path.join(hanakoHome, "agents", "hanako", "config.yaml");
    const cfg = YAML.load(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.agent.name).toBe("HanaIDE");
    expect(fs.statSync(path.join(hanakoHome, "agents", "hanako", "sessions")).isDirectory()).toBe(true);
  });

  it("keeps startup alive and reports non-default agent directories without config.yaml", async () => {
    // 历史脏目录：旧版物理删除残留 / phone projection 复活的目录，只有 phone/，没有 config.yaml
    fs.mkdirSync(path.join(hanakoHome, "agents", "kon", "phone", "conversations"), { recursive: true });
    const { ensureFirstRun } = await import("../core/first-run.ts");

    const report = ensureFirstRun(hanakoHome, productDir);

    expect(report.invalidAgentDirs).toEqual([
      { id: "kon", reason: "config_missing" },
    ]);
    // 默认 agent 正常播种，启动不被脏目录阻断
    const cfgPath = path.join(hanakoHome, "agents", "hanako", "config.yaml");
    expect(fs.existsSync(cfgPath)).toBe(true);
    // 不往脏目录里喂 pinned.md，避免把垃圾目录越喂越像 agent 目录
    expect(fs.existsSync(path.join(hanakoHome, "agents", "kon", "pinned.md"))).toBe(false);
    // 有效 agent 仍然补齐 pinned.md
    expect(fs.existsSync(path.join(hanakoHome, "agents", "hanako", "pinned.md"))).toBe(true);
  });

  it("keeps startup alive and reports non-default agent directories with unreadable config.yaml", async () => {
    const brokenDir = path.join(hanakoHome, "agents", "broken-agent");
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, "config.yaml"), "agent: [unclosed\n", "utf-8");
    const { ensureFirstRun } = await import("../core/first-run.ts");

    const report = ensureFirstRun(hanakoHome, productDir);

    expect(report.invalidAgentDirs).toHaveLength(1);
    expect(report.invalidAgentDirs[0].id).toBe("broken-agent");
    expect(report.invalidAgentDirs[0].reason).toBe("config_unreadable");
    // 坏 config 原样保留，不动用户数据
    expect(fs.readFileSync(path.join(brokenDir, "config.yaml"), "utf-8")).toBe("agent: [unclosed\n");
    expect(fs.existsSync(path.join(hanakoHome, "agents", "hanako", "config.yaml"))).toBe(true);
  });

  it("backs up an unreadable default hanako config before reseeding", async () => {
    const hanakoDir = path.join(hanakoHome, "agents", "hanako");
    fs.mkdirSync(hanakoDir, { recursive: true });
    fs.writeFileSync(path.join(hanakoDir, "config.yaml"), "agent: [unclosed\n", "utf-8");
    const { ensureFirstRun } = await import("../core/first-run.ts");

    const report = ensureFirstRun(hanakoHome, productDir);

    const cfg = YAML.load(fs.readFileSync(path.join(hanakoDir, "config.yaml"), "utf-8"));
    expect(cfg.agent.name).toBe("HanaIDE");
    expect(report.repairedDefaultAgent).toBe(true);
    const backups = fs.readdirSync(hanakoDir).filter((name) => name.startsWith("config.yaml.broken-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(hanakoDir, backups[0]), "utf-8")).toBe("agent: [unclosed\n");
  });

  it("does not report valid or tombstoned agent directories as invalid", async () => {
    const validDir = path.join(hanakoHome, "agents", "custom-agent");
    fs.mkdirSync(validDir, { recursive: true });
    fs.writeFileSync(path.join(validDir, "config.yaml"), "agent:\n  name: Custom\n", "utf-8");
    const tombstoneDir = path.join(hanakoHome, "agents", "deleted-agent");
    fs.mkdirSync(tombstoneDir, { recursive: true });
    fs.writeFileSync(path.join(tombstoneDir, "config.yaml"), "agent:\n  name: Gone\n", "utf-8");
    fs.writeFileSync(path.join(tombstoneDir, ".deleted-agent.json"), JSON.stringify({ version: 1 }), "utf-8");
    const { ensureFirstRun } = await import("../core/first-run.ts");

    const report = ensureFirstRun(hanakoHome, productDir);

    expect(report.invalidAgentDirs).toEqual([]);
  });
});
