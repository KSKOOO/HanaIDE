import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildImageParams, retryImageTask } from "../plugins/image-gen/lib/image-task-runner.ts";
import registerTaskRoutes from "../plugins/image-gen/routes/tasks.ts";

async function flushBackgroundSubmits() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeFailedTask(overrides = {}) {
  return {
    taskId: "task-img",
    adapterId: "fake-provider",
    batchId: "batch-1",
    type: "image",
    prompt: "same prompt",
    params: {
      type: "image",
      prompt: "same prompt",
      ratio: "16:9",
      resolution: "2k",
      model: "fake-model",
    },
    sessionPath: "/sessions/main.jsonl",
    deliveryTarget: null,
    adapterTaskId: "old-provider-task",
    submitState: "failed",
    status: "failed",
    failReason: "API returned no images",
    files: ["stale.png"],
    sessionFiles: [{ fileId: "old-file" }],
    imageWidth: 1024,
    imageHeight: 1024,
    retryCount: 1,
    createdAt: "2026-05-24T00:00:00.000Z",
    completedAt: "2026-05-24T00:01:00.000Z",
    ...overrides,
  };
}

function makeCtx(task, adapterOverrides = {}) {
  const adapter = {
    id: "fake-provider",
    submit: vi.fn(async () => ({ taskId: "retry-provider-task" })),
    ...adapterOverrides,
  };
  const store = {
    get: vi.fn(() => ({ ...task })),
    update: vi.fn((taskId, patch) => {
      if (taskId !== task.taskId) return null;
      Object.assign(task, patch);
      return { ...task };
    }),
  };
  const registry = {
    get: vi.fn((adapterId) => (adapterId === adapter.id ? adapter : null)),
  };
  const poller = {
    add: vi.fn(),
    checkNow: vi.fn(),
  };
  const bus = {
    request: vi.fn(async () => ({})),
  };
  const ctx = {
    _mediaGen: { registry, store, poller },
    dataDir: "/tmp/image-gen",
    bus,
    config: { get: vi.fn() },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
  return { ctx, adapter, store, registry, poller, bus };
}

describe("image generation retry", () => {
  it("passes suggestedFilename to adapters as the storage filename hint", () => {
    expect(buildImageParams({
      prompt: "a quiet moonlit harbor",
      suggestedFilename: "moonlit-harbor",
    })).toMatchObject({
      type: "image",
      prompt: "a quiet moonlit harbor",
      filename: "moonlit-harbor",
    });
  });

  it("passes multiple reference images to adapters through the existing image parameter", () => {
    expect(buildImageParams({
      prompt: "combine the references",
      image: "/tmp/old.png",
      referenceImages: ["/tmp/a.png", "", "/tmp/b.png"],
    })).toMatchObject({
      type: "image",
      prompt: "combine the references",
      image: ["/tmp/a.png", "/tmp/b.png"],
    });
  });

  it("reopens a failed image task with the same parameters and taskId", async () => {
    const task = makeFailedTask();
    const { ctx, adapter, store, poller, bus } = makeCtx(task);

    const result = await retryImageTask({ taskId: "task-img", ctx });

    expect(result).toMatchObject({
      ok: true,
      taskId: "task-img",
      placeholder: {
        type: "media_generation",
        taskId: "task-img",
        kind: "image",
        status: "pending",
        prompt: "same prompt",
      },
    });
    expect(bus.request).toHaveBeenCalledWith("deferred:retry", expect.objectContaining({
      taskId: "task-img",
      sessionPath: "/sessions/main.jsonl",
      meta: expect.objectContaining({
        type: "image-generation",
        mediaKind: "image",
        deliveryIntent: "ui_only",
        triggerParentTurn: false,
        notifyAgentOnFailure: true,
        prompt: "same prompt",
      }),
    }));
    expect(store.update).toHaveBeenCalledWith("task-img", expect.objectContaining({
      status: "pending",
      failReason: null,
      submitState: "submitting",
      adapterTaskId: null,
      files: [],
      sessionFiles: [],
      imageWidth: null,
      imageHeight: null,
      completedAt: null,
      retryCount: 2,
    }));
    expect(poller.add).toHaveBeenCalledWith("task-img");

    await flushBackgroundSubmits();

    expect(adapter.submit).toHaveBeenCalledWith(task.params, expect.objectContaining({
      generatedDir: path.join("/tmp/image-gen", "generated"),
      bus,
      log: ctx.log,
      config: ctx.config,
    }));
    expect(store.update).toHaveBeenCalledWith("task-img", expect.objectContaining({
      submitState: "submitted",
      adapterTaskId: "retry-provider-task",
    }));
  });

  it("rejects retry when the adapter no longer allows the saved reference image count", async () => {
    const task = makeFailedTask({
      params: {
        type: "image",
        prompt: "same prompt",
        image: ["/tmp/ref-a.png", "/tmp/ref-b.png"],
      },
    });
    const { ctx, adapter, store, poller, bus } = makeCtx(task, {
      maxReferenceImages: 1,
    });

    const result = await retryImageTask({ taskId: "task-img", ctx });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("最多支持 1 张参考图"),
    });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    expect(poller.add).not.toHaveBeenCalled();
    expect(bus.request).not.toHaveBeenCalled();
  });

  it("rejects tasks that are already pending", async () => {
    const task = makeFailedTask({ status: "pending", submitState: "submitted" });
    const { ctx, adapter, store, poller, bus } = makeCtx(task);

    const result = await retryImageTask({ taskId: "task-img", ctx });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: "task is already running",
    });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    expect(poller.add).not.toHaveBeenCalled();
    expect(bus.request).not.toHaveBeenCalled();
  });

  it("exposes retry through the image-gen task route", async () => {
    const task = makeFailedTask();
    const { ctx } = makeCtx(task);
    const app = new Hono();
    registerTaskRoutes(app, ctx);

    const res = await app.request("/tasks/task-img/retry", { method: "POST" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      taskId: "task-img",
      placeholder: {
        type: "media_generation",
        taskId: "task-img",
        status: "pending",
      },
    });
  });
});
