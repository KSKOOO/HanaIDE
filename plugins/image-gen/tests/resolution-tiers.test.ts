import { describe, expect, it } from "vitest";
import {
  CODEX_IMAGE_RESOLUTION_TIERS,
  resolveOpenAiImageSize,
} from "../lib/resolution-tiers.ts";

describe("OpenAI image resolution tiers", () => {
  it("maps generic tiers and ratios to supported flexible OpenAI sizes", () => {
    expect(resolveOpenAiImageSize(
      { resolution: "4K", ratio: "16:9" },
      {},
      { sourceName: "OpenAI image", flexible: true },
    )).toBe("3840x2160");

    expect(resolveOpenAiImageSize(
      { resolution: "4k", ratio: "1:1" },
      {},
      { sourceName: "OpenAI image", flexible: true },
    )).toBe("2880x2880");

    expect(resolveOpenAiImageSize(
      { resolution: "2K", ratio: "3:2" },
      {},
      { sourceName: "OpenAI image", flexible: true },
    )).toBe("2048x1360");
  });

  it("normalizes explicit pixel sizes without accepting impossible OpenAI sizes", () => {
    expect(resolveOpenAiImageSize(
      { size: "2048*2048" },
      {},
      { sourceName: "OpenAI image", flexible: true },
    )).toBe("2048x2048");

    expect(() => resolveOpenAiImageSize(
      { size: "4096x4096" },
      {},
      { sourceName: "OpenAI image", flexible: true },
    )).toThrow(/OpenAI image size/i);
  });

  it("rejects unsupported Codex and fixed-size OpenAI tiers instead of remapping them", () => {
    expect(() => resolveOpenAiImageSize(
      { resolution: "4K", ratio: "16:9" },
      {},
      {
        sourceName: "Codex image",
        flexible: true,
        supportedResolutions: CODEX_IMAGE_RESOLUTION_TIERS,
        constraints: { maxEdge: 2048, maxPixels: 2048 * 2048 },
      },
    )).toThrow(/Codex image resolution "4K" is unsupported/);

    expect(resolveOpenAiImageSize(
      { resolution: "1K", ratio: "3:2" },
      {},
      { sourceName: "OpenAI image", flexible: false },
    )).toBe("1536x1024");

    expect(() => resolveOpenAiImageSize(
      { resolution: "4K", ratio: "3:2" },
      {},
      { sourceName: "OpenAI image", flexible: false },
    )).toThrow(/OpenAI image resolution "4K" is unsupported/);

    expect(() => resolveOpenAiImageSize(
      { resolution: "1K", ratio: "16:9" },
      {},
      { sourceName: "OpenAI image", flexible: false },
    )).toThrow(/OpenAI image ratio/);
  });

  it("keeps ratio-only requests on the nearest standard OpenAI size", () => {
    expect(resolveOpenAiImageSize(
      { ratio: "16:9" },
      {},
      { sourceName: "OpenAI image", flexible: true },
    )).toBe("1536x1024");

    expect(resolveOpenAiImageSize(
      { ratio: "21:9" },
      {},
      { sourceName: "OpenAI image", flexible: true },
    )).toBe("1536x1024");
  });

  it("rejects ratios outside the shared image-generation contract", () => {
    expect(() => resolveOpenAiImageSize(
      { resolution: "2k", ratio: "5:4" },
      {},
      { sourceName: "OpenAI image", flexible: true },
    )).toThrow(/OpenAI image ratio/i);
  });
});
