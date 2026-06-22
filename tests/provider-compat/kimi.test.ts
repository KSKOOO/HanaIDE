import { describe, expect, it } from "vitest";
import {
  getReasoningProfile,
  getThinkingFormat,
  normalizeProviderPayload,
} from "../../core/provider-compat.ts";

const kimiModel = {
  id: "kimi-for-coding",
  provider: "kimi-coding",
  api: "openai-completions",
  baseUrl: "https://api.kimi.com/coding/v1",
  reasoning: true,
  compat: {
    supportsDeveloperRole: false,
    thinkingFormat: "kimi",
    reasoningProfile: "kimi-openai",
  },
};

describe("provider-compat/kimi", () => {
  it("declares the official Kimi OpenAI-compatible thinking contract", () => {
    expect(getThinkingFormat(kimiModel)).toBe("kimi");
    expect(getReasoningProfile(kimiModel)).toBe("kimi-openai");
  });

  it("enables thinking with Kimi official fields in chat mode", () => {
    const payload = {
      model: "kimi-for-coding",
      max_tokens: 12000,
      messages: [{ role: "user", content: "hi" }],
    };

    const result = normalizeProviderPayload(payload, kimiModel, {
      mode: "chat",
      reasoningLevel: "medium",
    });

    expect(result).not.toBe(payload);
    expect(result).toMatchObject({
      model: "kimi-for-coding",
      max_completion_tokens: 12000,
      reasoning_effort: "medium",
      thinking: { type: "enabled" },
    });
    expect(result).not.toHaveProperty("max_tokens");
  });

  it("maps xhigh to Kimi high effort instead of DeepSeek max", () => {
    const result = normalizeProviderPayload({
      model: "kimi-for-coding",
      messages: [{ role: "user", content: "hi" }],
    }, kimiModel, {
      mode: "chat",
      reasoningLevel: "xhigh",
    });

    expect(result.reasoning_effort).toBe("high");
    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result).not.toHaveProperty("output_config");
  });

  it("disables thinking and strips replayed reasoning_content for utility calls", () => {
    const payload = {
      model: "kimi-for-coding",
      messages: [
        { role: "assistant", content: "answer", reasoning_content: "private" },
        { role: "user", content: "summarize" },
      ],
      reasoning_effort: "medium",
      thinking: { type: "enabled", keep: "all" },
    };

    const result = normalizeProviderPayload(payload, kimiModel, { mode: "utility" });

    expect(result).not.toBe(payload);
    expect(result.reasoning_effort).toBeUndefined();
    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result.messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("recovers reasoning_content for Kimi tool-call replay", () => {
    const payload = {
      model: "kimi-for-coding",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "I need to inspect the file." }],
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "Read", arguments: "{}" },
          }],
        },
      ],
    };

    const result = normalizeProviderPayload(payload, kimiModel, {
      mode: "chat",
      reasoningLevel: "high",
    });

    expect(result.messages[0]).toMatchObject({
      reasoning_content: "I need to inspect the file.",
    });
  });
});
