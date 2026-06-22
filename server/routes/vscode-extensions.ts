import { Hono } from "hono";
import { createVscodeExtensionService } from "../../core/vscode-extension-service.ts";
import { safeJson } from "../hono-helpers.ts";

function nonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function routeError(message: string, status = 400) {
  const err: any = new Error(message);
  err.status = status;
  return err;
}

function errorStatus(err: any): number {
  if (Number.isInteger(err?.status)) return err.status;
  if (err?.code === "ENOENT") return 404;
  return 500;
}

function resolveService(engine: any) {
  if (!engine.vscodeExtensionService) {
    engine.vscodeExtensionService = createVscodeExtensionService({
      hanakoHome: engine?.hanakoHome,
      fetchImpl: globalThis.fetch?.bind(globalThis),
    });
  }
  return engine.vscodeExtensionService;
}

export function createVscodeExtensionsRoute(engine: any) {
  const route = new Hono();
  const service = resolveService(engine || {});

  route.get("/vscode-extensions", async (c) => {
    try {
      return c.json(await service.listExtensions());
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  route.get("/vscode-extensions/gallery/search", async (c) => {
    try {
      return c.json(await service.searchGallery(c.req.query("q") || ""));
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  route.post("/vscode-extensions/gallery/install", async (c) => {
    try {
      const body = await safeJson(c);
      const id = nonEmptyString(body?.id);
      if (!id) throw routeError("id is required");
      return c.json(await service.installFromGallery(id));
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  route.post("/vscode-extensions/install", async (c) => {
    try {
      const body = await safeJson(c);
      const sourcePath = nonEmptyString(body?.path) || nonEmptyString(body?.sourcePath);
      if (!sourcePath) throw routeError("path is required");
      return c.json(await service.installFromPath(sourcePath));
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  route.put("/vscode-extensions/:id/enabled", async (c) => {
    try {
      const body = await safeJson(c);
      const id = nonEmptyString(c.req.param("id"));
      if (!id) throw routeError("id is required");
      return c.json(await service.setEnabled(id, body?.enabled !== false));
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  route.delete("/vscode-extensions/:id", async (c) => {
    try {
      const id = nonEmptyString(c.req.param("id"));
      if (!id) throw routeError("id is required");
      return c.json(await service.uninstallExtension(id));
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  route.post("/vscode-extensions/runtime/start", async (c) => {
    try {
      const body = await safeJson(c);
      return c.json(await service.activateInstalledExtensions({
        workspacePath: nonEmptyString(body?.workspacePath),
      }));
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  route.get("/vscode-extensions/runtime/commands", async (c) => {
    try {
      return c.json({ commands: service.listRuntimeCommands() });
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  route.get("/vscode-extensions/runtime/views", async (c) => {
    try {
      return c.json({ views: service.listRuntimeViews() });
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  route.get("/vscode-extensions/runtime/resources/:extensionId", async (c) => {
    try {
      const extensionId = nonEmptyString(c.req.param("extensionId"));
      const resourcePath = nonEmptyString(c.req.query("path"));
      const resource = await service.readRuntimeResource(extensionId, resourcePath);
      return c.body(resource.bytes, 200, {
        "Content-Type": resource.mimeType,
        "Cache-Control": "no-store",
      });
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  route.get("/vscode-extensions/runtime/views/:viewId/messages", async (c) => {
    try {
      const viewId = nonEmptyString(c.req.param("viewId"));
      if (!viewId) throw routeError("viewId is required");
      const result = await service.readRuntimeViewMessages(viewId, Number(c.req.query("after") || 0));
      return c.json(result, result.ok ? 200 : 404);
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  route.post("/vscode-extensions/runtime/views/:viewId/messages", async (c) => {
    try {
      const viewId = nonEmptyString(c.req.param("viewId"));
      if (!viewId) throw routeError("viewId is required");
      const body = await safeJson(c);
      const result = await service.postRuntimeViewMessage(viewId, body?.message);
      return c.json(result, result.ok ? 200 : 404);
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  route.post("/vscode-extensions/runtime/views/:viewId", async (c) => {
    try {
      const viewId = nonEmptyString(c.req.param("viewId"));
      if (!viewId) throw routeError("viewId is required");
      const result = await service.resolveRuntimeView(viewId);
      return c.json(result, result.ok ? 200 : 404);
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  route.post("/vscode-extensions/runtime/commands/:command", async (c) => {
    try {
      const body = await safeJson(c);
      const command = nonEmptyString(c.req.param("command"));
      if (!command) throw routeError("command is required");
      const result = await service.executeCommand(command, Array.isArray(body?.args) ? body.args : []);
      return c.json(result, result.ok ? 200 : 404);
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, errorStatus(err) as any);
    }
  });

  return route;
}
