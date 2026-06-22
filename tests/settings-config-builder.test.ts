import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSettingsConfigResponse } from "../server/routes/settings-config-builder.ts";

let tempRoot: string | null = null;

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

async function makeEngine() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hana-settings-builder-"));
  const agentsDir = path.join(tempRoot, "agents");
  const agentId = "agent-a";
  await writeFile(path.join(agentsDir, agentId, "config.yaml"), [
    "agent:",
    "  name: Agent A",
    "api:",
    "  provider: custom",
    "  base_url: https://explicit.example",
    "experience:",
    "  enabled: false",
    "",
  ].join("\n"));

  return {
    agentsDir,
    getLocale: vi.fn(() => "ja"),
    getKeepAwake: vi.fn(() => false),
    getComputerUseSettings: vi.fn(() => ({ enabled: false })),
    getAgent: vi.fn(() => ({
      id: agentId,
      tools: [{ name: "read" }, { name: "browser" }, { name: "computer" }],
    })),
    providerRegistry: {
      getAllProvidersRaw: vi.fn(() => ({
        custom: {
          base_url: "https://stored.example",
          api: "openai",
          api_key: "sk-secret",
          headers: { Authorization: "Bearer hidden" },
          models: ["gpt-5"],
        },
      })),
      get: vi.fn(() => ({ baseUrl: "https://entry.example", api: "entry-api" })),
    },
    pluginManager: {
      getAllTools: vi.fn(() => [{ name: "beautify_create-cover", _pluginId: "beautify" }]),
    },
  };
}

describe("settings config response builder", () => {
  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("builds agent config responses with shared raw/provider/global/tool fields", async () => {
    const engine = await makeEngine();

    const config: any = await buildSettingsConfigResponse(engine, {
      kind: "agent",
      agentId: "agent-a",
    });

    expect(config.agent.name).toBe("Agent A");
    expect(config.experience.enabled).toBe(false);
    expect(config._raw.api).toEqual({ provider: "custom", base_url: "https://explicit.example" });
    expect(config.locale).toBe("ja");
    expect(config.keep_awake).toBe(false);
    expect(config.providers.custom).toMatchObject({
      base_url: "https://stored.example",
      api: "openai",
      api_key: "********",
      models: ["gpt-5"],
      model_count: 1,
    });
    expect(JSON.stringify(config)).not.toContain("sk-secret");
    expect(config.availableTools).toEqual(expect.arrayContaining(["read", "browser", "beautify"]));
    expect(config.availableTools).not.toContain("computer");
  });

  it("builds current config responses without requiring runtime tool state", async () => {
    const engine: any = await makeEngine();
    engine.config = {
      api: { provider: "global", base_url: "https://global.example" },
      experience: { enabled: true },
    };
    engine.getAgent = vi.fn(() => {
      throw new Error("current config should not inspect runtime agent tools");
    });

    const config: any = await buildSettingsConfigResponse(engine, {
      kind: "current",
      rawConfig: engine.config,
    });

    expect(config._raw.api).toEqual({ provider: "global", base_url: "https://global.example" });
    expect(config.availableTools).toBeUndefined();
    expect(engine.getAgent).not.toHaveBeenCalled();
  });
});
