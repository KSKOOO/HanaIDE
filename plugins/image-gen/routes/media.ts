// plugins/image-gen/routes/media.js
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { createSubmitContext, validateImageModelRef } from "../lib/image-task-runner.ts";

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime" };

export default function (app, ctx) {
  // Serve generated media — streaming + Range support
  app.get("/media/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      return c.json({ error: "invalid filename" }, 400);
    }
    const filePath = path.join(ctx.dataDir, "generated", filename);

    let stat;
    try { stat = fs.statSync(filePath); } catch { return c.json({ error: "not found" }, 404); }

    const ext = path.extname(filename).slice(1);
    const mime = MIME[ext] || "application/octet-stream";
    const total = stat.size;
    const range = c.req.header("range");

    if (range) {
      // Range request — partial content (video seeking, progressive load)
      const match = range.match(/bytes=(\d*)-(\d*)/);
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      const chunkSize = end - start + 1;

      const stream = fs.createReadStream(filePath, { start, end });
      const { readable, writable } = new TransformStream();
      streamPipe(stream, writable);

      return new Response(readable, {
        status: 206,
        headers: {
          "Content-Type": mime,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(chunkSize),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // Full request — stream the entire file (no readFileSync)
    const stream = fs.createReadStream(filePath);
    const { readable, writable } = new TransformStream();
    streamPipe(stream, writable);

    return new Response(readable, {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=86400",
      },
    });
  });

  // Open generated media in system default application (cross-platform)
  app.post("/media/open/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      return c.json({ error: "invalid filename" }, 400);
    }
    const filePath = path.join(ctx.dataDir, "generated", filename);

    try { fs.statSync(filePath); } catch { return c.json({ error: "not found" }, 404); }

    try {
      await openWithSystem(filePath);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message || "failed to open file" }, 500);
    }
  });

  // Provider summary for Media settings tab
  app.get("/providers", async (c) => {
    try {
      const { providers } = await ctx.bus.request("provider:media-providers", { capability: "image_generation" });
      return c.json({ providers: annotateAdapterAvailability(providers || {}, ctx), config: ctx.config.get() || {} });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Save plugin config (default model, provider defaults)
  app.put("/config", async (c) => {
    try {
      const body = await c.req.json();
      const values = body?.values && typeof body.values === "object" && !Array.isArray(body.values)
        ? body.values
        : body;
      const defaultValidationError = await validateDefaultImageModelConfig(values, ctx);
      if (defaultValidationError) return c.json({ error: defaultValidationError }, 400);
      for (const [key, value] of Object.entries(values || {})) {
        ctx.config.set(key, value === null ? undefined : value);
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.post("/providers/:providerId/models", async (c) => {
    const providerId = c.req.param("providerId");
    try {
      const body = await c.req.json();
      const model = body?.model || body;
      const result = await ctx.bus.request("provider:add-media-model", {
        providerId,
        capability: "image_generation",
        model,
      });
      if (result?.error) return c.json({ error: result.error }, 400);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.delete("/providers/:providerId/models/:modelId", async (c) => {
    const providerId = c.req.param("providerId");
    const modelId = c.req.param("modelId");
    try {
      const result = await ctx.bus.request("provider:remove-media-model", {
        providerId,
        capability: "image_generation",
        modelId,
      });
      if (result?.error) return c.json({ error: result.error }, 400);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });
}

function adapterAvailableForModel(providerId, model, ctx) {
  const registry = ctx?._mediaGen?.registry;
  if (!registry) return true;
  if (!model?.protocolId) return false;
  return Boolean(registry.getProtocol?.(model.protocolId) || registry.get?.(providerId));
}

function annotateAdapterAvailability(providers, ctx) {
  const next: any = {};
  for (const [providerId, provider] of Object.entries(providers || {}) as [string, any][]) {
    const models = (provider?.models || [])
      .map((model) => ({
        ...model,
        adapterAvailable: adapterAvailableForModel(providerId, model, ctx),
      }))
      .filter((model) => {
        if (model.adapterAvailable) return true;
        // 不允许静默丢弃：被过滤的模型必须留下可观测的诊断（#1627）
        ctx.log?.warn?.(
          `[image-gen] settings hide media model "${providerId}/${model.id}": `
          + (model.protocolId
            ? `no adapter registered for protocol "${model.protocolId}"`
            : "protocol unrecognized (model has no protocolId)"),
        );
        return false;
      });
    if (models.length === 0) continue;
    const modelIds = new Set(models.map((model) => model.id));
    next[providerId] = {
      ...provider,
      models,
      availableModels: Array.isArray(provider?.availableModels)
        ? provider.availableModels.filter((model) => modelIds.has(model.id))
        : provider?.availableModels,
    };
  }
  return next;
}

async function validateDefaultImageModelConfig(values, ctx) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  if (!Object.prototype.hasOwnProperty.call(values, "defaultImageModel")) return null;
  const value = values.defaultImageModel;
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "defaultImageModel must be an object with provider and id";
  }
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!provider || !id) return "defaultImageModel requires provider and id";
  const registry = ctx?._mediaGen?.registry;
  if (!registry) return null;
  try {
    await validateImageModelRef({ providerId: provider, modelId: id }, registry, createSubmitContext(ctx));
    return null;
  } catch (err) {
    return err?.message || String(err);
  }
}

/** Open a file with the system default application (cross-platform). */
function openWithSystem(filePath) {
  return new Promise<void>((resolve, reject) => {
    const p = process.platform;
    let cmd, args;
    if (p === "darwin") {
      cmd = "open"; args = [filePath];
    } else if (p === "win32") {
      cmd = "cmd"; args = ["/c", "start", "", filePath];
    } else {
      cmd = "xdg-open"; args = [filePath];
    }
    execFile(cmd, args, (err) => err ? reject(err) : resolve());
  });
}

/** Pipe a Node.js Readable into a Web WritableStream */
function streamPipe(nodeStream, writable) {
  const writer = writable.getWriter();
  nodeStream.on("data", (chunk) => writer.write(chunk));
  nodeStream.on("end", () => writer.close());
  nodeStream.on("error", () => writer.close());
}
