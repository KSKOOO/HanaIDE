import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiImageAdapter } from "../adapters/openai.ts";

const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-adapter-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeCtx(overrides = {}) {
  return {
    dataDir: makeTmpDir(),
    bus: {
      request: vi.fn(async () => ({ apiKey: "test-key", baseUrl: "https://api.openai.test/v1" })),
    },
    config: {
      get: vi.fn(() => null),
    },
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("openaiImageAdapter", () => {
  it("logs revised_prompt through object-style ctx.log without blocking image save", async () => {
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{
          b64_json: Buffer.from("image-bytes").toString("base64"),
          revised_prompt: "a clearer generated prompt",
        }],
      }),
    })));

    const result = await openaiImageAdapter.submit({
      prompt: "draw a lantern",
      model: "gpt-image-1.5",
      filename: "lantern",
    }, ctx);

    expect(ctx.log.info).toHaveBeenCalledWith("[openai-image] revised_prompt: a clearer generated prompt");
    expect(result.files).toHaveLength(1);
    expect(fs.existsSync(path.join(ctx.dataDir, "generated", result.files[0]))).toBe(true);
  });

  it("keeps custom provider model ids verbatim instead of resolving them against the OpenAI catalog", async () => {
    const ctx = makeCtx({
      bus: {
        request: vi.fn(async () => ({ apiKey: "proxy-key", baseUrl: "https://proxy.example.test/v1" })),
      },
      config: {
        get: vi.fn((key) => key === "providerDefaults" ? { "my-proxy": { quality: "high" } } : null),
      },
    });
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      json: async () => ({ data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await openaiImageAdapter.submit({
      prompt: "draw a lantern",
      providerId: "my-proxy",
      credentialProviderId: "my-proxy",
      modelId: "flux-1.1-pro",
    }, ctx);

    expect(ctx.bus.request).toHaveBeenCalledWith("provider:credentials", { providerId: "my-proxy" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("https://proxy.example.test/v1/images/generations");
    const body = JSON.parse(init.body);
    // 自定义模型 id 不允许被改写成 OpenAI catalog 的默认模型
    expect(body.model).toBe("flux-1.1-pro");
    // provider 级默认按实际 providerId 取，不再硬编码 "openai"
    expect(body.quality).toBe("high");
  });

  it("still resolves OpenAI catalog aliases for the built-in openai provider", async () => {
    const ctx = makeCtx();
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      json: async () => ({ data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await openaiImageAdapter.submit({
      prompt: "draw a lantern",
      providerId: "openai",
      modelId: "1.5",
    }, ctx);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.model).toBe("gpt-image-1.5");
  });
});
