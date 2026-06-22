import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { ModelManager } from "../core/model-manager.ts";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-model-manager-auth-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAddedModels(providers) {
  fs.writeFileSync(
    path.join(tmpDir, "added-models.yaml"),
    YAML.dump({ providers }),
    "utf-8",
  );
}

function writeAuth(data) {
  fs.writeFileSync(
    path.join(tmpDir, "auth.json"),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

function writeModelsJson(data) {
  fs.writeFileSync(
    path.join(tmpDir, "models.json"),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

function readPersistedProviders() {
  const catalogPath = path.join(tmpDir, "provider-catalog.json");
  if (fs.existsSync(catalogPath)) {
    return JSON.parse(fs.readFileSync(catalogPath, "utf-8")).providers || {};
  }
  return YAML.load(fs.readFileSync(path.join(tmpDir, "added-models.yaml"), "utf-8")).providers;
}

function deepseekProvider(apiKey) {
  const provider = {
    base_url: "https://api.deepseek.com/v1",
    api: "openai-completions",
    models: ["deepseek-v4-pro"],
  };
  if (apiKey !== undefined) (provider as any).api_key = apiKey;
  return provider;
}

async function getDeepseekApiKey(manager) {
  const model = manager.modelRegistry.find("deepseek", "deepseek-v4-pro");
  expect(model).toBeTruthy();
  const auth = await manager.modelRegistry.getApiKeyAndHeaders(model);
  expect(auth.ok).toBe(true);
  return auth.apiKey;
}

describe("ModelManager AuthStorage ownership", () => {
  it("injects added-models API keys as runtime overrides before Pi SDK env resolution", async () => {
    const originalPublic = process.env.PUBLIC;
    process.env.PUBLIC = "C:\\Users\\Public";
    try {
      writeAuth({});
      writeAddedModels({
        deepseek: deepseekProvider("public"),
      });

      const manager = new ModelManager({ hanakoHome: tmpDir });
      manager.init();
      await manager.syncAndRefresh();

      await expect(getDeepseekApiKey(manager)).resolves.toBe("public");
      const projected = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf-8"));
      expect(projected.providers.deepseek.apiKey).toBe("hana-runtime-api-key:deepseek");
    } finally {
      if (originalPublic === undefined) delete process.env.PUBLIC;
      else process.env.PUBLIC = originalPublic;
    }
  });

  it("migrates legacy API-key auth into added-models before clearing auth.json", async () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-legacy-4d2a" },
    });
    writeAddedModels({
      deepseek: deepseekProvider(undefined),
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.syncAndRefresh();

    await expect(getDeepseekApiKey(manager)).resolves.toBe("sk-legacy-4d2a");
    const persistedProviders = readPersistedProviders();
    expect(persistedProviders.deepseek.api_key).toBe("sk-legacy-4d2a");
    const persistedAuth = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf-8"));
    expect(persistedAuth.deepseek).toBeUndefined();
  });

  it("recovers a legacy API key from models.json when auth.json was already cleaned", async () => {
    writeAuth({});
    writeAddedModels({
      deepseek: deepseekProvider(undefined),
    });
    writeModelsJson({
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com/v1",
          api: "openai-completions",
          apiKey: "sk-projected-6ad1",
          models: [{ id: "deepseek-v4-pro" }],
        },
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.syncAndRefresh();

    await expect(getDeepseekApiKey(manager)).resolves.toBe("sk-projected-6ad1");
    const persistedProviders = readPersistedProviders();
    expect(persistedProviders.deepseek.api_key).toBe("sk-projected-6ad1");
  });

  it("API-key provider runtime lookup uses added-models credentials over stale auth.json", async () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-old-3ffa" },
    });
    writeAddedModels({
      deepseek: deepseekProvider("sk-new-999c"),
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.syncAndRefresh();

    await expect(getDeepseekApiKey(manager)).resolves.toBe("sk-new-999c");
    const persistedAuth = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf-8"));
    expect(persistedAuth.deepseek).toBeUndefined();
  });

  it("does not resurrect an explicitly cleared added-models API key", async () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-old-3ffa" },
    });
    writeAddedModels({
      deepseek: deepseekProvider(""),
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.syncAndRefresh();

    const persistedProviders = readPersistedProviders();
    expect(persistedProviders.deepseek.api_key).toBe("");
    const persistedAuth = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf-8"));
    expect(persistedAuth.deepseek).toBeUndefined();
    expect(manager.availableModels.filter((m) => m.provider === "deepseek")).toHaveLength(0);
  });

  it("re-applies Hana provider model metadata after Pi SDK availability filtering", async () => {
    writeAuth({});
    writeAddedModels({
      "local-max": {
        base_url: "https://api.example.com/v1",
        api: "openai-completions",
        api_key: "sk-local-max",
        models: [{
          id: "internal-max-model",
          name: "Internal Max Model",
          reasoning: true,
          xhigh: true,
          defaultThinkingLevel: "max",
          thinkingLevels: ["off", "medium", "high", "max"],
        }],
        model_defaults: {
          "internal-max-model": { thinking_level: "max" },
        },
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.syncAndRefresh();

    const model = manager.availableModels.find((m) => m.provider === "local-max" && m.id === "internal-max-model");
    expect(model).toBeTruthy();
    expect(model?.reasoning).toBe(true);
    expect(model?.xhigh).toBe(true);
    expect(model?.defaultThinkingLevel).toBe("max");
    expect(model?.thinkingLevels).toEqual(["off", "medium", "high", "max"]);
  });

  it("does not resurrect a deleted custom provider from legacy auth or models projection", async () => {
    writeAuth({
      "my-provider": { type: "api_key", key: "sk-legacy-custom" },
    });
    fs.writeFileSync(
      path.join(tmpDir, "added-models.yaml"),
      YAML.dump({
        _deleted_providers: ["my-provider"],
        providers: {},
      }),
      "utf-8",
    );
    writeModelsJson({
      providers: {
        "my-provider": {
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-projected-custom",
          models: [{ id: "custom-model" }],
        },
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    await manager.syncAndRefresh();

    const persistedProviders = readPersistedProviders();
    const projected = JSON.parse(fs.readFileSync(path.join(tmpDir, "models.json"), "utf-8"));
    expect(persistedProviders["my-provider"]).toBeUndefined();
    expect(projected.providers["my-provider"]).toBeUndefined();
  });

  it("reloadAndSync clears stale in-memory API-key auth before refreshing models", async () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-old-3ffa" },
    });
    writeAddedModels({
      deepseek: deepseekProvider("sk-new-999c"),
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.init();
    writeAuth({});

    await manager.reloadAndSync();

    await expect(getDeepseekApiKey(manager)).resolves.toBe("sk-new-999c");
  });

  it("refreshes OAuth credentials before resolving provider credentials for media adapters", async () => {
    writeAddedModels({
      "openai-codex-oauth": {
        models: ["gpt-5.5"],
      },
    });
    writeAuth({
      "openai-codex": {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-token",
        expires: Date.now() - 10_000,
        resourceUrl: "https://chatgpt.com/backend-api",
        accountId: "acct_123",
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.providerRegistry.reload();
    manager._authStorage = {
      getApiKey: vi.fn(async () => {
        writeAuth({
          "openai-codex": {
            type: "oauth",
            access: "fresh-token",
            refresh: "refresh-token",
            expires: Date.now() + 3600_000,
            resourceUrl: "https://chatgpt.com/backend-api",
            accountId: "acct_123",
          },
        });
        return "fresh-token";
      }),
      reload: vi.fn(),
    };

    const creds = await manager.resolveProviderCredentialsFresh("openai-codex-oauth");

    expect(manager._authStorage.getApiKey).toHaveBeenCalledWith("openai-codex");
    expect(creds).toEqual({
      api_key: "fresh-token",
      base_url: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
      headers: {},
      accountId: "acct_123",
    });
  });

  it("does not return a stale OAuth token when refresh fails", async () => {
    writeAddedModels({
      "openai-codex-oauth": {
        models: ["gpt-5.5"],
      },
    });
    writeAuth({
      "openai-codex": {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-token",
        expires: Date.now() - 10_000,
      },
    });

    const manager = new ModelManager({ hanakoHome: tmpDir });
    manager.providerRegistry.reload();
    manager._authStorage = {
      getApiKey: vi.fn(async () => undefined),
      reload: vi.fn(),
    };

    const creds = await manager.resolveProviderCredentialsFresh("openai-codex-oauth");

    expect(creds.api_key).toBe("");
  });
});
