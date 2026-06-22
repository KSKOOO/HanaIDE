import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImageGenPlugin from "../index.ts";

const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-plugin-test-"));
  tmpDirs.push(dir);
  return dir;
}

function createBusHarness() {
  const handlers = new Map();
  return {
    bus: {
      hasHandler: vi.fn(() => false),
      handle: vi.fn((type, handler) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      }),
      request: vi.fn(async (type, payload) => {
        const handler = handlers.get(type);
        if (!handler) return { ok: true };
        return handler(payload);
      }),
      subscribe: vi.fn(() => () => {}),
    },
    async request(type, payload) {
      const handler = handlers.get(type);
      if (!handler) throw new Error(`missing handler ${type}`);
      return handler(payload);
    },
  };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("image-gen plugin session identity", () => {
  it("accepts sessionId-first submit-image payloads at the plugin bus boundary", async () => {
    const { bus, request } = createBusHarness();
    const plugin = new (ImageGenPlugin as any)();
    plugin.ctx = {
      dataDir: makeTmpDir(),
      bus,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerSessionFile: vi.fn(),
    };
    plugin.register = vi.fn();

    await plugin.onload();

    const result = await request("media-gen:submit-image", {
      sessionId: "sess_image_plugin",
      input: { prompt: "lantern" },
    });

    expect(result).toMatchObject({
      ok: true,
      kind: "image",
      prompt: "lantern",
    });
  });
});
