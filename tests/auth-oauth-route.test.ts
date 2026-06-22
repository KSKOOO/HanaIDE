import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createAuthRoute } from "../server/routes/auth.ts";

function makeEngine(loginImpl: any) {
  return {
    providerRegistry: {
      getAuthJsonKey: vi.fn((provider: string) => provider === "openai-codex-oauth" ? "openai-codex" : provider),
    },
    authStorage: {
      getOAuthProviders: vi.fn(() => [
        { id: "openai-codex", name: "OpenAI Codex", usesCallbackServer: true },
      ]),
      login: vi.fn(loginImpl),
      get: vi.fn(() => null),
      logout: vi.fn(),
    },
    onProviderChanged: vi.fn(async () => {}),
    availableModels: [],
    preferences: {
      getOAuthCustomModels: vi.fn(() => ({})),
      setOAuthCustomModels: vi.fn(),
    },
  };
}

describe("auth oauth route", () => {
  it("reuses an in-flight callback-server flow for the same provider", async () => {
    let capturedCallbacks: any;
    const engine = makeEngine((_authKey: string, callbacks: any) => {
      capturedCallbacks = callbacks;
      callbacks.onAuth({ url: "https://auth.example/start" });
      return new Promise(() => {});
    });
    const app = new Hono();
    app.route("/api", createAuthRoute(engine));

    const first = await app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });
    const second = await app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });

    expect(await second.json()).toEqual(await first.clone().json());
    expect(engine.authStorage.login).toHaveBeenCalledTimes(1);
    expect(engine.authStorage.login).toHaveBeenCalledWith("openai-codex", expect.any(Object));
    expect(capturedCallbacks.onManualCodeInput).toEqual(expect.any(Function));
  });

  it("waits for the same provider flow when the auth URL is still starting", async () => {
    let capturedCallbacks: any;
    let resolveLoginStarted: () => void;
    const loginStarted = new Promise<void>((resolve) => {
      resolveLoginStarted = resolve;
    });
    const engine = makeEngine((_authKey: string, callbacks: any) => {
      capturedCallbacks = callbacks;
      resolveLoginStarted();
      return new Promise(() => {});
    });
    const app = new Hono();
    app.route("/api", createAuthRoute(engine));

    const firstPromise = app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });
    await loginStarted;

    const secondPromise = app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });

    capturedCallbacks.onAuth({ url: "https://auth.example/start" });

    const first = await firstPromise;
    const second = await secondPromise;

    expect(await second.json()).toEqual(await first.json());
    expect(engine.authStorage.login).toHaveBeenCalledTimes(1);
  });
});
