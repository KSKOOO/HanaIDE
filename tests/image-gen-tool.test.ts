import { describe, it, expect, vi } from "vitest";

function makeCtx(request) {
  return {
    sessionId: "sess_media_tool",
    sessionPath: "/sessions/media-tool.jsonl",
    sessionRef: {
      sessionId: "sess_media_tool",
      sessionPath: "/sessions/media-tool.jsonl",
    },
    bridgeContext: { source: "test" },
    pluginId: "media",
    bus: { request },
  };
}

describe("media generation tools", () => {
  it("exposes image generation under the media plugin namespace", async () => {
    const mod = await import("../plugins/media/tools/generate-image.ts");

    expect(mod.name).toBe("generate-image");
    expect(mod.parameters.required).toContain("prompt");
    expect(mod.parameters.properties.options).toMatchObject({ type: "object" });
    expect(mod.parameters.properties.image).toBeTruthy();
    expect(mod.parameters.properties.referenceImages).toBeTruthy();
  });

  it("delegates image generation to the native media bus", async () => {
    const mod = await import("../plugins/media/tools/generate-image.ts");
    const request = vi.fn(async () => ({
      ok: true,
      kind: "image",
      batchId: "batch-image",
      prompt: "a quiet library",
      delivery: { mode: "session" },
      tasks: [{ taskId: "task-image" }],
    }));

    const result = await mod.execute({
      prompt: "a quiet library",
      count: 2,
      ratio: "3:2",
      resolution: "2k",
      quality: "high",
      provider: "openai",
      model: "gpt-image-2",
      options: { background: "opaque" },
      suggestedFilename: "library.png",
    }, makeCtx(request));

    expect(request).toHaveBeenCalledWith("media:generate-image", {
      sessionId: "sess_media_tool",
      sessionPath: "/sessions/media-tool.jsonl",
      sessionRef: {
        sessionId: "sess_media_tool",
        sessionPath: "/sessions/media-tool.jsonl",
      },
      input: {
        prompt: "a quiet library",
        count: 2,
        ratio: "3:2",
        resolution: "2k",
        quality: "high",
        provider: "openai",
        model: "gpt-image-2",
        options: { background: "opaque" },
        suggestedFilename: "library.png",
      },
      bridgeContext: { source: "test" },
      pluginId: "media",
    });
    expect(request).not.toHaveBeenCalledWith("media-gen:submit-image", expect.anything());
    expect(result.details.mediaGeneration).toMatchObject({
      kind: "image",
      batchId: "batch-image",
      prompt: "a quiet library",
      tasks: [{ taskId: "task-image" }],
    });
  });

  it("delegates video generation to the native media bus", async () => {
    const mod = await import("../plugins/media/tools/generate-video.ts");
    const request = vi.fn(async () => ({
      ok: true,
      kind: "video",
      batchId: "batch-video",
      prompt: "a moonlit room",
      delivery: { mode: "session" },
      tasks: [{ taskId: "task-video" }],
    }));

    const result = await mod.execute({
      prompt: "a moonlit room",
      image: { kind: "session_file", fileId: "sf_ref" },
      duration: 5,
      ratio: "16:9",
      resolution: "1080p",
      mode: "image2video",
      provider: "agnes",
      model: "video-model",
      options: { camera: "slow pan" },
    }, makeCtx(request));

    expect(request).toHaveBeenCalledWith("media:generate-video", {
      sessionId: "sess_media_tool",
      sessionPath: "/sessions/media-tool.jsonl",
      sessionRef: {
        sessionId: "sess_media_tool",
        sessionPath: "/sessions/media-tool.jsonl",
      },
      input: {
        prompt: "a moonlit room",
        image: { kind: "session_file", fileId: "sf_ref" },
        duration: 5,
        ratio: "16:9",
        resolution: "1080p",
        mode: "image2video",
        provider: "agnes",
        model: "video-model",
        options: { camera: "slow pan" },
      },
      bridgeContext: { source: "test" },
      pluginId: "media",
    });
    expect(result.details.mediaGeneration).toMatchObject({
      kind: "video",
      batchId: "batch-video",
      prompt: "a moonlit room",
      tasks: [{ taskId: "task-video" }],
    });
  });

  it("describes media provider options without submitting generation", async () => {
    const mod = await import("../plugins/media/tools/describe-options.ts");
    const request = vi.fn(async () => ({
      providers: {
        "jimeng-cli": {
          providerId: "jimeng-cli",
          displayName: "即梦 CLI",
          models: [{
            id: "seedance2.0_vip",
            displayName: "Seedance 2.0 VIP",
            modes: [{
              id: "text2video",
              parameterSchema: {
                type: "object",
                properties: {
                  video_resolution: { type: "string", enum: ["720p", "1080p"] },
                },
              },
              defaults: { video_resolution: "720p" },
            }],
          }],
        },
      },
    }));

    const result = await mod.execute({
      kind: "video",
      provider: "jimeng-cli",
      model: "seedance2.0_vip",
      mode: "text2video",
    }, makeCtx(request));

    expect(request).toHaveBeenCalledWith("provider:media-providers", { capability: "video_generation" });
    const mediaOptions = result.details.mediaOptions as any;
    expect(mediaOptions.mode.parameterSchema.properties.video_resolution.enum).toEqual(["720p", "1080p"]);
  });
});
