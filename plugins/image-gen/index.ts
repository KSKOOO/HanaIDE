// plugins/image-gen/index.js
import path from "node:path";
import fs from "node:fs";
import { AdapterRegistry } from "./lib/adapter-registry.ts";
import { TaskStore } from "./lib/task-store.ts";
import { Poller } from "./lib/poller.ts";
import { builtinImageGenAdapters } from "./builtin-adapters.ts";
import { submitImageGeneration } from "./lib/submit-image.ts";
import { normalizeSessionRef } from "./lib/image-task-runner.ts";

export default class ImageGenPlugin {
  declare ctx: any;
  declare register: any;
  async onload() {
    const { dataDir, bus, log } = this.ctx;

    try {
      if (typeof bus?.hasHandler === "function" && bus.hasHandler("media:runtime")) {
        const result = await bus.request("media:runtime", { consumer: "image-gen" });
        if (result?.runtime?.registry && result?.runtime?.store && result?.runtime?.poller) {
          this.ctx._mediaGen = result.runtime;
          if (result.config) this.ctx.config = result.config;
          log.info("image-gen plugin bound to native media runtime");
          return;
        }
      }
    } catch (err) {
      log.warn(`native media runtime unavailable, falling back to plugin runtime: ${err?.message || err}`);
    }

    const generatedDir = path.join(dataDir, "generated");
    fs.mkdirSync(generatedDir, { recursive: true });

    // Infrastructure
    const registry = new AdapterRegistry();
    const store = new TaskStore(dataDir);
    const poller = new Poller({
      store,
      registry,
      bus,
      dataDir,
      generatedDir,
      log,
      registerSessionFile: this.ctx.registerSessionFile,
    });

    // Built-in adapters
    for (const adapter of builtinImageGenAdapters) {
      registry.register(adapter);
    }

    // Attach to ctx for tools
    this.ctx._mediaGen = { registry, store, poller, generatedDir };

    // Bus handlers — adapter registration (for external plugins like dreamina)
    this.register(bus.handle("media-gen:register-adapter", ({ adapter }) => {
      registry.register(adapter);
      log.info(`adapter registered: ${adapter.id}`);
      return { ok: true };
    }));

    this.register(bus.handle("media-gen:unregister-adapter", ({ adapterId }) => {
      registry.unregister(adapterId);
      log.info(`adapter unregistered: ${adapterId}`);
      return { ok: true };
    }));

    // Listen for fire-and-forget unregister events (plugin teardown is sync)
    this.register(bus.subscribe((event) => {
      if (event.type === "media-gen:adapter-removed" && event.adapterId) {
        registry.unregister(event.adapterId);
        log.info(`adapter removed (event): ${event.adapterId}`);
      }
    }));

    this.register(bus.handle("media-gen:list-adapters", () => {
      return { adapters: registry.list().map((a) => ({ id: a.id, name: a.name, types: a.types })) };
    }));

    this.register(bus.handle("media-gen:submit-image", async ( payload: any = {}) => {
      const input = payload.input && typeof payload.input === "object" ? payload.input : payload;
      const sessionTarget = normalizeSessionRef(payload);
      if (!sessionTarget.sessionId && !sessionTarget.sessionPath) {
        return { ok: false, error: "sessionId or sessionPath is required" };
      }
      try {
        return await submitImageGeneration({
          input,
          ctx: {
            ...this.ctx,
            sessionId: sessionTarget.sessionId,
            sessionPath: sessionTarget.sessionPath,
            sessionRef: sessionTarget.sessionRef,
            _mediaGen: this.ctx._mediaGen,
          },
          metadata: payload.metadata || null,
          deliveryTarget: payload.deliveryTarget === undefined ? null : payload.deliveryTarget,
        } as any);
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }));

    // Bus handlers — task CRUD (for external panels like dreamina)
    this.register(bus.handle("media-gen:get-tasks", ({ adapterId, batchId, status }: any = {}) => {
      let tasks = store.listAll();
      if (adapterId) tasks = tasks.filter((t) => t.adapterId === adapterId);
      if (batchId) tasks = tasks.filter((t) => t.batchId === batchId);
      if (status) tasks = tasks.filter((t) => t.status === status);
      return { tasks };
    }));

    this.register(bus.handle("media-gen:get-task", ({ taskId }) => {
      return { task: store.get(taskId) };
    }));

    this.register(bus.handle("media-gen:update-task", ({ taskId, fields }) => {
      const allowed: any = {};
      if (typeof fields?.favorited === "boolean") allowed.favorited = fields.favorited;
      store.update(taskId, allowed);
      return { ok: true };
    }));

    this.register(bus.handle("media-gen:remove-task", ({ taskId }) => {
      const task = store.get(taskId);
      if (task) {
        for (const f of task.files || []) {
          try { fs.unlinkSync(path.join(generatedDir, f)); } catch { /* ok */ }
        }
        store.remove(taskId);
      }
      return { ok: true };
    }));

    this.register(bus.handle("media-gen:remove-unfavorited", () => {
      const removed = store.removeUnfavorited();
      for (const t of removed) {
        for (const f of t.files || []) {
          try { fs.unlinkSync(path.join(generatedDir, f)); } catch { /* ok */ }
        }
      }
      return { ok: true, removed: removed.length };
    }));

    // Start poller
    poller.start();

    // Register media-generation task handler for TaskRegistry
    bus.request("task:register-handler", {
      type: "media-generation",
      abort: (taskId) => { poller.cancel(taskId); },
    }).catch(() => {});

    // Cleanup
    this.register(() => {
      poller.stop();
      store.destroy();
      bus.request("task:unregister-handler", { type: "media-generation" }).catch(() => {});
      log.info("image-gen plugin unloaded");
    });

    log.info("image-gen plugin loaded (unified media-gen)");
  }
}
