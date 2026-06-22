import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { MountAwareFileError, MountAwareFileService } from "../../core/mount-aware-file-service.ts";
import {
  disableStudioMount,
  listStudioMountsForStudio,
  upsertStudioMount,
} from "../../core/studio-mounts.ts";
import { safeJson } from "../hono-helpers.ts";
import { createRequestContext } from "../http/boundary.ts";
import { recordSecurityAuditEvent } from "../http/security-audit.ts";
import { isLocalOwnerPrincipal } from "../http/route-security.ts";

export function createStudioWorkspacesRoute(engine) {
  const route = new Hono();

  route.get("/studio/workspaces", async (c) => {
    try {
      const auth = authorizeStudioWorkspace(c, engine, "files.read");
      if (auth.response) return auth.response;
      return c.json(await listStudioWorkspaces(engine, auth.requestContext));
    } catch (err) {
      return workspaceError(c, err);
    }
  });

  route.get("/studio/workspaces/:mountId/files", async (c) => {
    try {
      const auth = authorizeStudioWorkspace(c, engine, "files.read");
      if (auth.response) return auth.response;
      const mountId = c.req.param("mountId") || "default";
      return c.json(await fileService(engine, auth.requestContext)
        .listFiles(mountId, c.req.query("subdir") || ""));
    } catch (err) {
      return workspaceError(c, err);
    }
  });

  route.post("/studio/workspaces", async (c) => {
    const auth = authorizeStudioWorkspace(c, engine, "files.write");
    if (auth.response) return auth.response;
    if (!isLocalOwnerPrincipal(auth.requestContext?.authPrincipal)) {
      return c.json({
        error: "local_owner_required",
        capability: "studio.workspace.create_local_path",
      }, 403);
    }

    try {
      const body = await safeJson(c);
      const workspace = isSshWorkspaceBody(body)
        ? await createSshWorkspace(engine, auth.requestContext, body)
        : await createLocalPathWorkspace(engine, auth.requestContext, body);
      recordSecurityAuditEvent(c, engine, {
        action: workspace.provider === "ssh" ? "studio_workspace.create_ssh" : "studio_workspace.create_local_path",
        target: {
          kind: "studio",
          studioId: auth.requestContext?.studioId || null,
          mountId: workspace.mountId,
        },
        result: "success",
        decision: auth.decision || null,
      } as any);
      return c.json({
        ok: true,
        workspace,
      });
    } catch (err) {
      return workspaceError(c, err);
    }
  });

  route.delete("/studio/workspaces/:mountId", async (c) => {
    const auth = authorizeStudioWorkspace(c, engine, "files.write");
    if (auth.response) return auth.response;
    if (!isLocalOwnerPrincipal(auth.requestContext?.authPrincipal)) {
      return c.json({
        error: "local_owner_required",
        capability: "studio.workspace.remove_local_path",
      }, 403);
    }
    try {
      const mountId = c.req.param("mountId") || "";
      if (mountId === "default") {
        throw routeError("default workspace cannot be removed", "default_workspace", 400);
      }
      const mount = disableStorageWorkspace(engine, auth.requestContext, mountId);
      recordSecurityAuditEvent(c, engine, {
        action: "studio_workspace.remove_local_path",
        target: {
          kind: "studio",
          studioId: auth.requestContext?.studioId || null,
          mountId: mount.mountId,
        },
        result: "success",
        decision: auth.decision || null,
      } as any);
      return c.json({ ok: true, mountId: mount.mountId });
    } catch (err) {
      return workspaceError(c, err);
    }
  });

  return route;
}

async function listStudioWorkspaces(engine, requestContext) {
  const studioId = requireStudioId(requestContext);
  const discloseNativeRoot = isLocalOwnerPrincipal(requestContext?.authPrincipal);
  const workspaces = [];
  const files = fileService(engine, requestContext);
  try {
    workspaces.push(workspaceFromRoot(files.resolveRoot("default"), { isDefault: true }));
  } catch (err) {
    if (!(err instanceof MountAwareFileError && err.code === "no_workspace")) throw err;
  }
  for (const mount of listStudioMountsForStudio(engine.hanakoHome, studioId)) {
    if (mount.status !== "active") continue;
    workspaces.push(workspaceFromMount(mount, { discloseNativeRoot }));
  }
  return {
    studioId,
    workspaces,
  };
}

async function createLocalPathWorkspace(engine, requestContext, body) {
  const studioId = requireStudioId(requestContext);
  const rawPath = typeof body?.path === "string" ? body.path.trim() : "";
  if (!rawPath) throw routeError("path must be a non-empty string", "invalid_path", 400);
  if (!path.isAbsolute(rawPath)) throw routeError("path must be absolute on the server", "invalid_path", 400);
  const rootPath = path.resolve(rawPath);
  const stat = await fs.promises.stat(rootPath).catch((err) => {
    if (err?.code === "ENOENT") return null;
    throw err;
  });
  if (!stat?.isDirectory()) {
    throw routeError("path must be an existing directory", "invalid_path", 400);
  }

  const mount = upsertStudioMount(engine.hanakoHome, {
    mountId: localFsMountId(studioId, rootPath),
    hostStudioId: studioId,
    sourceKind: "storage",
    provider: "local_fs",
    rootLocator: { path: rootPath },
    label: normalizeWorkspaceLabel(body?.label, rootPath),
    presentation: "folder",
    capabilities: ["list", "read", "write", "execute"],
    status: "active",
  });
  // 创建入口已由路由层强制 local owner；此处对称校验保证函数签名自包含。
  return workspaceFromMount(mount, { discloseNativeRoot: isLocalOwnerPrincipal(requestContext?.authPrincipal) });
}

async function createSshWorkspace(engine, requestContext, body) {
  const studioId = requireStudioId(requestContext);
  const locator = normalizeSshWorkspaceLocator(body);
  const mount = upsertStudioMount(engine.hanakoHome, {
    mountId: sshMountId(studioId, locator),
    hostStudioId: studioId,
    sourceKind: "storage",
    provider: "ssh",
    rootLocator: locator,
    label: normalizeWorkspaceLabel(body?.label, `${locator.username}@${locator.host}:${locator.rootPath}`),
    presentation: "folder",
    capabilities: ["list", "read", "write", "execute"],
    status: "active",
  });
  return workspaceFromMount(mount, { discloseNativeRoot: false });
}

function disableStorageWorkspace(engine, requestContext, mountId) {
  const studioId = requireStudioId(requestContext);
  const activeMount = listStudioMountsForStudio(engine.hanakoHome, studioId)
    .find((mount) => mount.mountId === mountId && mount.status === "active");
  if (!activeMount) throw routeError("workspace mount not found", "workspace_not_found", 404);
  if (activeMount.sourceKind !== "storage" || !["local_fs", "ssh"].includes(activeMount.provider)) {
    throw routeError("only storage workspace mounts can be removed here", "unsupported_workspace_mount", 400);
  }
  return disableStudioMount(engine.hanakoHome, mountId, { hostStudioId: studioId });
}

function authorizeStudioWorkspace(c, engine, capability) {
  const requestContext = createRequestContext(c, engine);
  if (requestContext.authPrincipal?.kind === "unknown") return { requestContext, decision: null };
  const decision = requestContext.authorize(capability, {
    kind: "studio",
    studioId: requestContext.studioId,
  });
  if (decision.allowed) return { requestContext, decision };
  recordSecurityAuditEvent(c, engine, {
    action: `studio_workspace.${capability}`,
    target: { kind: "studio", studioId: requestContext.studioId },
    result: "denied",
    decision,
    errorCode: decision.reason,
  } as any);
  return {
    requestContext,
    decision,
    response: c.json({
      error: "insufficient_scope",
      reason: decision.reason,
      capability,
    }, 403),
  };
}

function fileService(engine, requestContext) {
  return new MountAwareFileService({
    hanakoHome: engine.hanakoHome,
    defaultRoot: engine.defaultDeskCwd || engine.homeCwd || engine.deskCwd,
    studioId: requestContext?.studioId || engine.getRuntimeContext?.()?.studioId || null,
    createCheckpoint: typeof engine.createUserEditCheckpoint === "function"
      ? (args) => engine.createUserEditCheckpoint(args)
      : null,
    sshProvider: engine.sshWorkspaceProvider || engine.sshProvider || null,
    discloseNativeRoot: isLocalOwnerPrincipal(requestContext?.authPrincipal),
    // 只对桌面端 local owner 披露 local_fs 根的 native 路径；远端/配对设备不披露。
  });
}

function workspaceFromRoot(root, { isDefault = false } = {}) {
  return {
    workspaceId: root.workspaceId || root.mountId || root.id,
    mountId: root.mountId || root.id,
    label: root.label,
    sourceKind: root.sourceKind,
    provider: root.provider || null,
    presentation: root.presentation || "folder",
    capabilities: Array.isArray(root.capabilities) ? root.capabilities : [],
    isDefault,
    // resolveRoot 已按 principal 决定是否携带 nativeRootPath，这里原样透传。
    ...(typeof root.nativeRootPath === "string" && root.nativeRootPath
      ? { nativeRootPath: root.nativeRootPath }
      : {}),
  };
}

function workspaceFromMount(mount, { discloseNativeRoot = false } = {}) {
  const nativeRootPath = discloseNativeRoot
    && mount.sourceKind === "storage"
    && mount.provider === "local_fs"
    && typeof mount.rootLocator?.path === "string"
    && mount.rootLocator.path
    ? mount.rootLocator.path
    : null;
  return {
    workspaceId: mount.mountId,
    mountId: mount.mountId,
    label: mount.label,
    sourceKind: mount.sourceKind,
    provider: mount.provider || null,
    presentation: mount.presentation,
    capabilities: Array.isArray(mount.capabilities) ? mount.capabilities : [],
    isDefault: false,
    ...(nativeRootPath ? { nativeRootPath } : {}),
    ...(mount.sourceKind === "storage" && mount.provider === "ssh" ? {
      remoteHost: mount.rootLocator?.host || null,
      remotePort: mount.rootLocator?.port || 22,
      remoteUser: mount.rootLocator?.username || null,
      remotePath: mount.rootLocator?.rootPath || mount.rootLocator?.path || null,
    } : {}),
    ...(mount.sourceKind === "studio" ? {
      sourceStudioId: mount.sourceStudioId,
      sourceResourceId: mount.sourceResourceId,
    } : {}),
  };
}

function requireStudioId(requestContext) {
  const studioId = requestContext?.studioId;
  if (typeof studioId !== "string" || !studioId.trim()) {
    throw routeError("studioId required", "studio_required", 400);
  }
  return studioId;
}

function normalizeWorkspaceLabel(label, rootPath) {
  const normalized = typeof label === "string" ? label.trim() : "";
  if (normalized) return normalized;
  return path.basename(rootPath) || "Workspace";
}

function localFsMountId(studioId, rootPath) {
  const digest = crypto.createHash("sha256")
    .update(`${studioId}\0${rootPath}`)
    .digest("hex")
    .slice(0, 16);
  return `local_fs_${digest}`;
}

function sshMountId(studioId, locator) {
  const digest = crypto.createHash("sha256")
    .update(`${studioId}\0ssh\0${locator.username}@${locator.host}:${locator.port}\0${locator.rootPath}`)
    .digest("hex")
    .slice(0, 16);
  return `ssh_${digest}`;
}

function isSshWorkspaceBody(body) {
  return body?.provider === "ssh" || body?.type === "ssh" || !!body?.ssh;
}

function normalizeSshWorkspaceLocator(body) {
  const source = body?.ssh && typeof body.ssh === "object" ? body.ssh : body;
  const host = normalizedString(source?.host);
  const username = normalizedString(source?.username || source?.user);
  const remotePath = normalizeSshPath(source?.path || source?.remotePath);
  const port = Number(source?.port || 22);
  if (!host) throw routeError("ssh host required", "invalid_ssh_workspace", 400);
  if (!username) throw routeError("ssh username required", "invalid_ssh_workspace", 400);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw routeError("ssh port must be between 1 and 65535", "invalid_ssh_workspace", 400);
  }
  const locator: Record<string, any> = {
    host,
    port,
    username,
    rootPath: remotePath,
  };
  for (const key of ["password", "privateKey", "privateKeyPath", "passphrase", "agent"]) {
    const value = source?.[key];
    if (typeof value === "string" && value.length > 0) locator[key] = value;
  }
  return locator;
}

function normalizedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeSshPath(value) {
  const raw = normalizedString(value) || "/";
  if (!raw.startsWith("/") || raw.includes("\\")) {
    throw routeError("ssh path must be an absolute POSIX path", "invalid_ssh_workspace", 400);
  }
  const normalized = path.posix.normalize(raw);
  if (!normalized.startsWith("/")) throw routeError("invalid ssh path", "invalid_ssh_workspace", 400);
  return normalized;
}

function routeError(message, code, status) {
  const err: any = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function workspaceError(c, err) {
  if (err instanceof MountAwareFileError) {
    return c.json({ error: err.code, detail: err.message }, err.status);
  }
  return c.json({ error: err.code || "studio_workspace_failed", detail: err.message }, err.status || 400);
}
