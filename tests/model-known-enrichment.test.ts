import { describe, expect, it } from "vitest";
import { enrichModelFromKnownMetadata } from "../core/model-known-enrichment.ts";

describe("enrichModelFromKnownMetadata", () => {
  it("adds Hana metadata to Pi built-in Kimi models without dropping request headers", () => {
    const model = {
      id: "kimi-for-coding",
      name: "Kimi For Coding",
      api: "anthropic-messages",
      provider: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding",
      headers: { "User-Agent": "KimiCLI/1.5" },
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 32768,
    };

    const enriched = enrichModelFromKnownMetadata(model);

    expect(enriched.headers).toEqual({ "User-Agent": "KimiCLI/1.5" });
    expect(enriched.visionCapabilities).toMatchObject({
      grounding: true,
      outputFormat: "anchor",
    });
    expect(enriched.compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "kimi",
      reasoningProfile: "kimi-openai",
    });
    expect(enriched.api).toBe("openai-completions");
    expect(enriched.baseUrl).toBe("https://api.kimi.com/coding/v1");
  });

  it("normalizes legacy Kimi runtime ids before looking up Pi built-in headers", () => {
    const model = {
      id: "kimi-k2.6",
      name: "Kimi K2.6",
      api: "anthropic-messages",
      provider: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding",
      reasoning: true,
      input: ["text", "image"],
    };

    const enriched = enrichModelFromKnownMetadata(model);

    expect(enriched.id).toBe("kimi-for-coding");
    expect(enriched.headers).toEqual({ "User-Agent": "KimiCLI/1.5" });
    expect(enriched.compat).toMatchObject({
      thinkingFormat: "kimi",
      reasoningProfile: "kimi-openai",
    });
  });
});
