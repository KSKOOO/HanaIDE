import { describe, expect, it } from "vitest";
import {
  normalizeRequestThinkingLevel,
  normalizeSessionThinkingLevel,
  modelSupportsAnthropicMaxEffort,
  modelSupportsXhigh,
  normalizeThinkingLevelForModel,
  resolveModelDefaultThinkingLevel,
} from "../core/session-thinking-level.ts";

describe("session thinking level capabilities", () => {
  it("maps legacy auto to medium at runtime boundaries", () => {
    expect(normalizeSessionThinkingLevel("auto")).toBe("medium");
    expect(normalizeRequestThinkingLevel("auto")).toBe("medium");
    expect(normalizeSessionThinkingLevel(undefined)).toBe("medium");
  });

  it("accepts Max as the canonical deep thinking level", () => {
    const model = { id: "glm-5.2", provider: "zhipu", reasoning: true };

    expect(normalizeSessionThinkingLevel("max")).toBe("max");
    expect(normalizeRequestThinkingLevel("max")).toBe("max");
    expect(modelSupportsXhigh(model)).toBe(true);
    expect(normalizeThinkingLevelForModel("max", model)).toBe("max");
    expect(normalizeThinkingLevelForModel("max", { id: "plain-model", provider: "test" })).toBe("high");
  });

  it("shows the unified Max level for GPT-5.5", () => {
    const model = { id: "gpt-5.5", provider: "openai", reasoning: true };

    expect(modelSupportsXhigh(model)).toBe(true);
    expect(normalizeThinkingLevelForModel("xhigh", model)).toBe("xhigh");
  });

  it("shows the unified Max level for Claude models with Anthropic max effort", () => {
    const models = [
      { id: "claude-opus-4-7", provider: "anthropic", reasoning: true },
      { id: "claude-opus-4-6", provider: "anthropic", reasoning: true },
      { id: "claude-sonnet-4-6", provider: "anthropic", reasoning: true },
      { id: "claude-fable-5", provider: "anthropic", reasoning: true },
      { id: "claude-mythos-5", provider: "anthropic", reasoning: true },
      { id: "anthropic/claude-opus-4-7", provider: "vercel-ai-gateway", api: "anthropic-messages", reasoning: true },
    ];

    for (const model of models) {
      expect(modelSupportsXhigh(model)).toBe(true);
      expect(modelSupportsAnthropicMaxEffort(model)).toBe(true);
      expect(normalizeThinkingLevelForModel("xhigh", model)).toBe("xhigh");
    }
  });

  it("does not infer Anthropic max effort for non-Anthropic wire formats by model name alone", () => {
    const model = {
      id: "anthropic/claude-opus-4-7",
      provider: "openrouter",
      api: "openai-completions",
      reasoning: true,
    };

    expect(modelSupportsAnthropicMaxEffort(model)).toBe(false);
  });

  it("allows unified Max for OpenRouter Claude Fable without using Anthropic Messages effort control", () => {
    const model = {
      id: "anthropic/claude-fable-5",
      provider: "openrouter",
      api: "openai-completions",
      reasoning: true,
    };

    expect(modelSupportsXhigh(model)).toBe(true);
    expect(modelSupportsAnthropicMaxEffort(model)).toBe(false);
    expect(normalizeThinkingLevelForModel("xhigh", model)).toBe("xhigh");
  });

  it("resolves model-level thinking defaults with per-model xhigh capability", () => {
    expect(resolveModelDefaultThinkingLevel(
      { id: "gpt-5.5", provider: "openai", defaultThinkingLevel: "xhigh" },
      "medium",
    )).toBe("xhigh");

    expect(resolveModelDefaultThinkingLevel(
      { id: "plain-model", provider: "test", defaultThinkingLevel: "xhigh" },
      "low",
    )).toBe("high");

    expect(resolveModelDefaultThinkingLevel(
      { id: "glm-5.2", provider: "zhipu", defaultThinkingLevel: "max" },
      "medium",
    )).toBe("max");

    expect(resolveModelDefaultThinkingLevel(
      { id: "plain-model", provider: "test" },
      "low",
    )).toBe("low");
  });
});
