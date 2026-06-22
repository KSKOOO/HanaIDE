import { afterEach, describe, expect, it, vi } from "vitest";
import { callText } from "../core/llm-client.ts";

function makeCodexJwt(accountId) {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function makeSseBody(blocks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(block));
      }
      controller.close();
    },
  });
}

describe("callText provider-compat routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies response body read aborts from timeout as LLM_TIMEOUT", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => {
        const err = new Error("body read aborted");
        err.name = "AbortError";
        throw err;
      },
    } as any);

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: "qwen3.5-plus",
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any)).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
  });

  it("裸 model id + opts.quirks 仍走 qwen utility 兼容层", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: "qwen3.5-plus",
      quirks: ["enable_thinking"],
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.enable_thinking).toBe(false);
  });

  it("omits temperature from utility requests unless the caller sets it explicitly", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "kimi-k2.5", provider: "moonshot", input: ["text", "image"] },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("temperature");
  });

  it("keeps explicit utility temperature values in the request body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0);
  });

  it("serializes MiMo audio content to provider-visible input_audio parts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: {
        id: "mimo-v2.5",
        provider: "mimo",
        api: "openai-completions",
        baseUrl: "https://api.xiaomimimo.com/v1",
        input: ["text", "image"],
        compat: { hanaAudioInput: true },
      },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "[attached_audio: /tmp/voice.wav]\n听一下" },
          { type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
        ],
      }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "听一下" },
      { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
    ]);
  });

  it("disables MiMo thinking for custom proxy utility requests inferred from model ID", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://proxy.example.test/v1",
      model: {
        id: "mimo-v2.5-pro",
        provider: "ch",
        api: "openai-completions",
        baseUrl: "https://proxy.example.test/v1",
        reasoning: true,
        compat: { supportsDeveloperRole: false },
      },
      messages: [{ role: "user", content: "remember this" }],
      maxTokens: 80,
      timeoutMs: 5_000,
    } as any);

    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(url).toBe("https://proxy.example.test/v1/chat/completions");
    expect(body.model).toBe("mimo-v2.5-pro");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
  });

  it("lets future OpenAI-compatible audio providers opt in through an explicit transport", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      model: {
        id: "deepseek-v4.1-audio",
        provider: "deepseek",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com/v1",
        input: ["text"],
        compat: {
          hanaAudioInput: true,
          audioTransport: "openai-input-audio",
        },
      },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "listen" },
          { type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
        ],
      }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "listen" },
      { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
    ]);
  });

  it("fails before fetch when OpenAI-compatible audio input uses an unsupported format", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: {
        id: "mimo-v2.5",
        provider: "mimo",
        api: "openai-completions",
        baseUrl: "https://api.xiaomimimo.com/v1",
        compat: { hanaAudioInput: true },
      },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "listen" },
          { type: "audio", data: "T2dnUw==", mimeType: "audio/ogg" },
        ],
      }],
      timeoutMs: 5_000,
    } as any)).rejects.toThrow(/unsupported OpenAI input_audio payload.*audio\/ogg/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not synthesize utility output caps from model capability metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: {
        id: "custom-small-output",
        provider: "openai-compatible",
        api: "openai-completions",
        maxTokens: 512,
      },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("keeps explicit utility output caps as task-owned request budgets", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: {
        id: "custom-small-output",
        provider: "openai-compatible",
        api: "openai-completions",
        maxTokens: 512,
      },
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 80,
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(80);
  });

  it("serializes image content for openai-compatible chat completions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", data: "BASE64", mimeType: "image/png" },
        ],
      }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Describe this image." },
      { type: "image_url", image_url: { url: "data:image/png;base64,BASE64" } },
    ]);
  });

  it("serializes image content for anthropic messages", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    } as any);

    await callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: { id: "claude-sonnet", provider: "anthropic", input: ["text", "image"] },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", data: "BASE64", mimeType: "image/jpeg" },
        ],
      }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Describe this image." },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "BASE64",
        },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("marks auxiliary vision calls as utility intent and disables Kimi Anthropic-compatible thinking", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    } as any);

    await callText({
      api: "anthropic-messages",
      baseUrl: "https://api.kimi.com/coding",
      model: {
        id: "kimi-k2.6",
        provider: "kimi-coding",
        api: "anthropic-messages",
        input: ["text", "image"],
        reasoning: true,
        compat: { thinkingFormat: "anthropic" },
      },
      callPurpose: "auxiliary_vision",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", data: "BASE64", mimeType: "image/jpeg" },
        ],
      }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.messages[0].content[1]).toMatchObject({
      type: "image",
      source: { media_type: "image/jpeg", data: "BASE64" },
    });
  });

  it("adds cache_control to anthropic utility system prompts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    } as any);

    await callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: { id: "claude-opus-4-5", provider: "anthropic" },
      systemPrompt: "Stable writing system prompt",
      messages: [{ role: "user", content: "write" }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.system).toEqual([
      {
        type: "text",
        text: "Stable writing system prompt",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("forwards model request headers on utility requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    } as any);

    await callText({
      api: "anthropic-messages",
      apiKey: "sk-test",
      baseUrl: "https://api.kimi.com/coding",
      model: {
        id: "kimi-for-coding",
        provider: "kimi-coding",
        headers: { "User-Agent": "KimiCLI/1.5" },
      },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({
      "User-Agent": "KimiCLI/1.5",
      "x-api-key": "sk-test",
    });
  });

  it("uses a stable default User-Agent without overriding model headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "custom-model", provider: "custom" },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: {
        id: "custom-model",
        provider: "custom",
        headers: { "User-Agent": "ExistingClient/2.0" },
      },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toBe("HanaIDE/1.0");
    expect(fetchMock.mock.calls[1][1].headers["User-Agent"]).toBe("ExistingClient/2.0");
  });

  it("lets provider request headers override protocol auth headers on utility requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as any);

    await callText({
      api: "openai-completions",
      apiKey: "sk-default",
      baseUrl: "https://gateway.example/v1",
      model: {
        id: "gateway-model",
        provider: "gateway-provider",
        headers: { Authorization: "Gateway gateway-token" },
      },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as any).Authorization).toBe("Gateway gateway-token");
  });

  it("does not append a duplicate v1 segment for Anthropic-compatible base URLs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    } as any);

    await callText({
      api: "anthropic-messages",
      apiKey: "sk-test",
      baseUrl: "https://anthropic-compatible.example/v1",
      model: { id: "claude-compatible", provider: "custom" },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    expect(fetchMock.mock.calls[0][0]).toBe("https://anthropic-compatible.example/v1/messages");
  });

  it("keeps callText string-compatible by default and returns usage only when requested", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 40,
          },
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 40,
          },
        }),
      } as any);

    const defaultResult = await callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: { id: "claude-opus-4-5", provider: "anthropic" },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any);

    const detailedResult = await callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: { id: "claude-opus-4-5", provider: "anthropic" },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
      returnUsage: true,
    } as any);

    expect(defaultResult).toBe("ok");
    expect(detailedResult).toEqual({
      text: "ok",
      usage: expect.objectContaining({
        input: { totalTokens: 100, uncachedTokens: 20 },
        output: { totalTokens: 20, reasoningTokens: null },
        cache: expect.objectContaining({
          readTokens: 80,
          writeTokens: 40,
          hit: true,
          created: true,
        }),
      }),
    });
  });

  it("classifies responses that become empty only after thinking cleanup", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "<think>The user asked for OK.</think>\n\n" } }],
      }),
    } as any);

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "MiniMax-M2.7", provider: "minimax", reasoning: true },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).rejects.toMatchObject({
      code: "LLM_EMPTY_RESPONSE",
      message: "模型未回复正文，请检查思考内容或稍后重试。",
      context: expect.objectContaining({ reason: "empty_after_thinking" }),
    });
  });

  it("returns visible text after stripping a leading thinking block", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "<think>The user asked for OK.</think>\n\nOK" } }],
      }),
    } as any);

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "MiniMax-M2.7", provider: "minimax", reasoning: true },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).resolves.toBe("OK");
  });

  it("classifies anthropic thinking-only content blocks as empty-after-thinking", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "thinking", thinking: "The answer is OK." }],
      }),
    } as any);

    await expect(callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: {
        id: "MiniMax-M2.7",
        provider: "minimax",
        api: "anthropic-messages",
        reasoning: true,
      },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).rejects.toMatchObject({
      code: "LLM_EMPTY_RESPONSE",
      message: "模型未回复正文，请检查思考内容或稍后重试。",
      context: expect.objectContaining({ reason: "empty_after_thinking" }),
    });
  });

  it("includes provider error details when the upstream rejects a request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: "invalid_image",
          message: "Invalid request Error",
        },
      }),
    } as any);

    await expect(callText({
      api: "anthropic-messages",
      baseUrl: "https://api.kimi.com/coding",
      model: {
        id: "kimi-k2.6",
        provider: "kimi-coding",
        api: "anthropic-messages",
      },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    } as any)).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("Invalid request Error"),
      context: expect.objectContaining({
        provider: "kimi-coding",
        model: "kimi-k2.6",
        status: 400,
        errorType: "invalid_request_error",
        errorCode: "invalid_image",
      }),
    });
  });

  it("returns anthropic visible text while ignoring thinking content blocks", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [
          { type: "thinking", thinking: "Need to answer briefly." },
          { type: "text", text: "OK" },
        ],
      }),
    } as any);

    await expect(callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: {
        id: "MiniMax-M2.7",
        provider: "minimax",
        api: "anthropic-messages",
        reasoning: true,
      },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).resolves.toBe("OK");
  });

  it("extracts Responses output_text content from message items without relying on role", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "OK from Responses" }],
        }],
      }),
    } as any);

    await expect(callText({
      api: "openai-codex-responses",
      baseUrl: "https://example.test/v1",
      model: { id: "gpt-5.4-codex", provider: "openai-codex", accountId: "acct_123" },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).resolves.toBe("OK from Responses");
  });

  it("sends Codex Responses utility requests to ChatGPT /codex/responses with account headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: makeSseBody([
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Codex " })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "OK" })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    } as any);

    await expect(callText({
      api: "openai-codex-responses",
      apiKey: "oauth-token",
      baseUrl: "https://chatgpt.com/backend-api",
      model: {
        id: "gpt-5.4-codex",
        provider: "openai-codex-oauth",
        accountId: "acct_123",
      },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).resolves.toBe("Codex OK");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect((init.headers as any).Authorization).toBe("Bearer oauth-token");
    expect((init.headers as any)["chatgpt-account-id"]).toBe("acct_123");
    expect((init.headers as any)["OpenAI-Beta"]).toBe("responses=experimental");
    expect((init.headers as any).originator).toBe("pi");
    expect(JSON.parse(init.body as string)).toMatchObject({
      store: false,
      stream: true,
    });
  });

  it("always sends non-empty instructions for Codex Responses utility calls (#1664)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: "Codex OK" }),
    } as any);

    await callText({
      api: "openai-codex-responses",
      apiKey: "oauth-token",
      baseUrl: "https://chatgpt.com/backend-api",
      model: {
        id: "gpt-5.4-codex",
        provider: "openai-codex-oauth",
        accountId: "acct_123",
      },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.instructions).toEqual(expect.stringContaining("utility model"));
    expect(body.instructions.trim().length).toBeGreaterThan(0);
  });

  it("derives the Codex account id from the OAuth token when the model omits it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: "Codex OK" }),
    } as any);

    await callText({
      api: "openai-codex-responses",
      apiKey: makeCodexJwt("acct_from_token"),
      baseUrl: "https://chatgpt.com/backend-api/codex",
      model: { id: "gpt-5.4-codex", provider: "openai-codex-oauth" },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init.headers["chatgpt-account-id"]).toBe("acct_from_token");
  });

  it("fails closed when Codex Responses credentials do not carry an account id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: "should not be called" }),
    } as any);

    await expect(callText({
      api: "openai-codex-responses",
      apiKey: "opaque-token",
      baseUrl: "https://chatgpt.com/backend-api",
      model: { id: "gpt-5.4-codex", provider: "openai-codex-oauth" },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).rejects.toMatchObject({
      code: "LLM_AUTH_FAILED",
      message: expect.stringContaining("account id"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves Responses top-level output_text extraction", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: "Top-level OK" }),
    } as any);

    await expect(callText({
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      model: { id: "gpt-5", provider: "openai" },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).resolves.toBe("Top-level OK");
  });

  it("preserves Responses assistant role message text extraction", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Assistant role OK" }],
        }],
      }),
    } as any);

    await expect(callText({
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      model: { id: "gpt-5", provider: "openai" },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).resolves.toBe("Assistant role OK");
  });

  it("does not treat Responses non-message output as visible text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output: [{
          type: "reasoning",
          content: [{ type: "output_text", text: "Hidden reasoning is not a reply." }],
        }],
      }),
    } as any);

    await expect(callText({
      api: "openai-codex-responses",
      baseUrl: "https://example.test/v1",
      model: { id: "gpt-5.4-codex", provider: "openai-codex", reasoning: true, accountId: "acct_123" },
      messages: [{ role: "user", content: "Reply OK." }],
      timeoutMs: 5_000,
    } as any)).rejects.toMatchObject({
      code: "LLM_EMPTY_RESPONSE",
      context: expect.objectContaining({ reason: "empty_after_thinking" }),
    });
  });
});
