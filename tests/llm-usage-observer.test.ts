import { describe, expect, it, vi } from "vitest";
import {
  buildUsageDebugRecord,
  logLlmUsage,
  normalizeLlmUsage,
} from "../lib/llm/usage-observer.ts";

describe("LLM usage observer", () => {
  it("normalizes Pi SDK usage and marks cache hits", () => {
    const usage = normalizeLlmUsage({
      input: 1200,
      output: 300,
      cacheRead: 900,
      cacheWrite: 150,
      totalTokens: 2550,
      cost: { total: 0.042 },
    });

    expect(usage).toEqual({
      input: { totalTokens: 1200, uncachedTokens: 300 },
      output: { totalTokens: 300, reasoningTokens: null },
      cache: {
        readTokens: 900,
        writeTokens: 150,
        missTokens: null,
        hit: true,
        created: true,
        hitRatio: 0.75,
        support: "reported",
      },
      totalTokens: 2550,
      costTotal: 0.042,
    });
  });

  it("normalizes Anthropic raw usage fields", () => {
    const usage = normalizeLlmUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 40,
    });

    expect(usage).toMatchObject({
      input: { totalTokens: 100, uncachedTokens: 20 },
      output: { totalTokens: 20, reasoningTokens: null },
      cache: {
        readTokens: 80,
        writeTokens: 40,
        hit: true,
        created: true,
        hitRatio: 0.8,
        support: "reported",
      },
      totalTokens: 240,
    });
  });

  it("normalizes OpenAI-compatible usage with cached prompt token details", () => {
    const usage = normalizeLlmUsage({
      prompt_tokens: 250,
      completion_tokens: 50,
      total_tokens: 300,
      prompt_tokens_details: { cached_tokens: 180 },
    });

    expect(usage).toMatchObject({
      input: { totalTokens: 250, uncachedTokens: 70 },
      output: { totalTokens: 50, reasoningTokens: null },
      cache: {
        readTokens: 180,
        writeTokens: 0,
        hit: true,
        created: false,
        hitRatio: 0.72,
        support: "reported",
      },
      totalTokens: 300,
    });
  });

  it("normalizes DeepSeek cache hit and miss token fields", () => {
    const usage = normalizeLlmUsage({
      prompt_tokens: 1000,
      completion_tokens: 120,
      total_tokens: 1120,
      prompt_cache_hit_tokens: 720,
      prompt_cache_miss_tokens: 280,
    });

    expect(usage).toMatchObject({
      input: { totalTokens: 1000, uncachedTokens: 280 },
      output: { totalTokens: 120, reasoningTokens: null },
      cache: {
        readTokens: 720,
        writeTokens: 0,
        missTokens: 280,
        hit: true,
        created: false,
        hitRatio: 0.72,
        support: "reported",
      },
      totalTokens: 1120,
    });
  });

  it("preserves unknown cache support instead of treating it as zero", () => {
    const usage = normalizeLlmUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
    }, { cacheSupport: "not_reported" });

    expect(usage).toMatchObject({
      input: { totalTokens: 10, uncachedTokens: null },
      output: { totalTokens: 5, reasoningTokens: null },
      cache: {
        readTokens: null,
        writeTokens: null,
        missTokens: null,
        hit: null,
        created: null,
        hitRatio: null,
        support: "not_reported",
      },
      totalTokens: 15,
    });
  });

  it("builds a structured debug record without request content", () => {
    const record = buildUsageDebugRecord({
      source: "utility",
      api: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 0,
      },
    });

    expect(record).toEqual({
      source: "utility",
      api: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      totalTokens: 200,
      costTotal: null,
      cacheHit: true,
      cacheCreated: false,
    });
  });

  it("writes model usage as one structured debug log line", () => {
    const logger = { log: vi.fn() };

    logLlmUsage({
      logger,
      source: "chat",
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      usage: { input: 10, output: 2, cacheRead: 8, cacheWrite: 0 },
    });

    expect(logger.log).toHaveBeenCalledWith(
      "llm-usage",
      "model_usage {\"source\":\"chat\",\"api\":null,\"provider\":\"anthropic\",\"modelId\":\"claude-opus-4-5\",\"inputTokens\":10,\"outputTokens\":2,\"cacheReadTokens\":8,\"cacheWriteTokens\":0,\"totalTokens\":20,\"costTotal\":null,\"cacheHit\":true,\"cacheCreated\":false}"
    );
  });
});
