import crypto from "crypto";
import fs from "fs";
import path from "path";
import { loadStudioMountRegistry } from "./studio-mounts.ts";
import { getDefaultSshWorkspaceProvider } from "./ssh-workspace-provider.ts";
import { createModuleLogger } from "../lib/debug-log.ts";

const log = createModuleLogger("mount-files");

const SEARCH_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
]);
const SEARCH_LIMIT = 80;

export class MountAwareFileError extends Error {
  declare code: string;
  declare status: number;

  constructor(message, { code = "file_action_failed", status = 400 } = {}) {
    super(message);
    this.name = "MountAwareFileError";
    this.code = code;
    this.status = status;
  }
}

export class MountAwareFileService {
  declare _hanakoHome: string;
  declare _defaultRoot: string;
  declare _studioId: string;
  declare _createCheckpoint: any;
  declare _discloseNativeRoot: boolean;
  declare _sshProvider: any;

  constructor({
    hanakoHome,
    defaultRoot,
    studioId,
    createCheckpoint,
    discloseNativeRoot = false,
    sshProvider = null,
  }: Record<string, any> = {}) {
    if (!hanakoHome) throw new Error("hanakoHome required");
    this._hanakoHome = hanakoHome;
    this._defaultRoot = defaultRoot || null;
    this._studioId = studioId || null;
    this._createCheckpoint = typeof createCheckpoint === "function" ? createCheckpoint : null;
    this._discloseNativeRoot = discloseNativeRoot === true;
    this._sshProvider = sshProvider;
  }

  resolveRoot(rootId = "default") {
    return publicRoot(this._resolveRootInternal(rootId), this._discloseNativeRoot);
  }

  resolveExecutionRoot(rootId = "default") {
    const root = this._resolveRootInternal(rootId);
    if (isSshRoot(root)) return root;
    return {
      ...root,
      nativeRootPath: root.path,
    };
  }

  resolveDirectory(rootId = "default", subdir = "") {
    const root = this._resolveRootInternal(rootId);
    if (isSshRoot(root)) throw fileError("native directory is unavailable for ssh workspaces", "native_path_unavailable", 400);
    const normalized = normalizeSubdirOrThrow(subdir);
    const dir = resolveInsideRoot(root.path, normalized);
    if (!dir) throw fileError("invalid path", "invalid_path", 400);
    return dir;
  }

  async listFiles(rootId = "default", subdir = "") {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "list");
    const normalized = normalizeSubdirOrThrow(subdir);
    if (isSshRoot(root)) {
      return {
        rootId: root.id,
        mountId: root.mountId || root.id,
        mount: publicRoot(root, this._discloseNativeRoot),
        subdir: normalized,
        files: await sshProvider(this).list(root, normalized),
      };
    }
    const dir = resolveInsideRoot(root.path, normalized);
    if (!dir) throw fileError("invalid path", "invalid_path", 400);
    return {
      rootId: root.id,
      mountId: root.mountId || root.id,
      mount: publicRoot(root, this._discloseNativeRoot),
      subdir: normalized,
      files: await listFiles(dir),
    };
  }

  async searchFiles(rootId = "default", query = "") {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "list");
    const q = String(query || "").trim();
    return {
      rootId: root.id,
      mountId: root.mountId || root.id,
      mount: publicRoot(root, this._discloseNativeRoot),
      query: q,
      results: q
        ? (isSshRoot(root) ? await sshProvider(this).search(root, q) : await searchFiles(root.path, q))
        : [],
    };
  }

  async contentTarget(rootId = "default", subdir = "", name) {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "read");
    const normalized = normalizeSubdirOrThrow(subdir);
    const filename = normalizePlainNameOrThrow(name);
    if (isSshRoot(root)) {
      return await sshProvider(this).materializeFile(root, normalized, filename, {
        cacheDir: path.join(this._hanakoHome, "cache", "ssh-workbench"),
      });
    }
    const dir = resolveInsideRoot(root.path, normalized);
    if (!dir) throw fileError("invalid path", "invalid_path", 400);
    const filePath = resolveFileTarget(root.path, dir, filename);
    if (!filePath) throw fileError("invalid path", "invalid_path", 400);
    return { root, filePath, filename };
  }

  async contentResource(rootId = "default", subdir = "", name) {
    const target = await this.contentTarget(rootId, subdir, name);
    return {
      ...target,
      version: statFileVersionOrNull(target.filePath),
    };
  }

  async mkdir(rootId, subdir, body: Record<string, any> = {}) {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "write");
    const normalizedSubdir = normalizeSubdirOrThrow(subdir);
    const name = normalizePlainNameOrThrow(body.name);
    if (isSshRoot(root)) {
      await sshProvider(this).mkdir(root, normalizedSubdir, name);
      return workbenchWriteResult(root, "mkdir", {
        files: await sshProvider(this).list(root, normalizedSubdir),
      }, this._discloseNativeRoot);
    }
    const dir = writeDirForLocalRoot(root, normalizedSubdir);
    const target = resolveFileTarget(root.path, dir, name);
    if (!target) throw fileError("invalid path", "invalid_path", 400);
    fs.mkdirSync(target, { recursive: false });
    return workbenchWriteResult(root, "mkdir", { files: await listFiles(dir) }, this._discloseNativeRoot);
  }

  async writeText(rootId, subdir, body: Record<string, any> = {}) {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "write");
    const normalizedSubdir = normalizeSubdirOrThrow(subdir);
    const name = normalizePlainNameOrThrow(body.name);
    if (isSshRoot(root)) {
      const expectedVersion = normalizeExpectedVersionOrNull(body.expectedVersion);
      if (expectedVersion) {
        const currentVersion = await sshProvider(this).statFileVersion(root, normalizedSubdir, name);
        if (!currentVersion || !fileVersionsMatch(currentVersion, expectedVersion)) {
          return {
            ok: false,
            action: body.action,
            rootId: root.id,
            mountId: root.mountId || root.id,
            mount: publicRoot(root, this._discloseNativeRoot),
            conflict: true,
            version: currentVersion,
            files: await sshProvider(this).list(root, normalizedSubdir),
          };
        }
      }
      await sshProvider(this).writeText(root, normalizedSubdir, name, String(body.content ?? ""));
      return {
        ok: true,
        action: body.action,
        rootId: root.id,
        mountId: root.mountId || root.id,
        mount: publicRoot(root, this._discloseNativeRoot),
        version: await sshProvider(this).statFileVersion(root, normalizedSubdir, name),
        files: await sshProvider(this).list(root, normalizedSubdir),
      };
    }
    const dir = writeDirForLocalRoot(root, normalizedSubdir);
    const target = resolveFileTarget(root.path, dir, name);
    if (!target) throw fileError("invalid path", "invalid_path", 400);
    const expectedVersion = normalizeExpectedVersionOrNull(body.expectedVersion);
    if (expectedVersion) {
      const currentVersion = statFileVersionOrNull(target);
      if (!currentVersion || !fileVersionsMatch(currentVersion, expectedVersion)) {
        return {
          ok: false,
          action: body.action,
          rootId: root.id,
          mountId: root.mountId || root.id,
          mount: publicRoot(root, this._discloseNativeRoot),
          conflict: true,
          version: currentVersion,
          files: await listFiles(dir),
        };
      }
    }
    if (fs.existsSync(target) && this._createCheckpoint) {
      await this._createCheckpoint({ filePath: target, reason: "mobile-workbench-edit" }).catch(() => null);
    }
    fs.writeFileSync(target, String(body.content ?? ""), "utf-8");
    return {
      ok: true,
      action: body.action,
      rootId: root.id,
      mountId: root.mountId || root.id,
      mount: publicRoot(root, this._discloseNativeRoot),
      version: statFileVersionOrNull(target),
      files: await listFiles(dir),
    };
  }

  async rename(rootId, subdir, body: Record<string, any> = {}) {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "write");
    const normalizedSubdir = normalizeSubdirOrThrow(subdir);
    const oldName = normalizePlainNameOrThrow(body.oldName);
    const newName = normalizePlainNameOrThrow(body.newName);
    if (isSshRoot(root)) {
      await sshProvider(this).rename(root, normalizedSubdir, oldName, normalizedSubdir, newName);
      return workbenchWriteResult(root, "rename", {
        files: await sshProvider(this).list(root, normalizedSubdir),
      }, this._discloseNativeRoot);
    }
    const dir = writeDirForLocalRoot(root, normalizedSubdir);
    const source = resolveFileTarget(root.path, dir, oldName);
    const target = resolveFileTarget(root.path, dir, newName);
    if (!source || !target) throw fileError("invalid path", "invalid_path", 400);
    fs.renameSync(source, target);
    return workbenchWriteResult(root, "rename", { files: await listFiles(dir) }, this._discloseNativeRoot);
  }

  async move(rootId, subdir, body: Record<string, any> = {}) {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "write");
    const normalizedSubdir = normalizeSubdirOrThrow(subdir);
    const name = normalizePlainNameOrThrow(body.name);
    const destSubdir = normalizeSubdirOrThrow(body.destSubdir || "");
    if (isSshRoot(root)) {
      await sshProvider(this).rename(root, normalizedSubdir, name, destSubdir, name);
      return workbenchWriteResult(root, "move", {
        files: await sshProvider(this).list(root, normalizedSubdir),
      }, this._discloseNativeRoot);
    }
    const dir = writeDirForLocalRoot(root, normalizedSubdir);
    const source = resolveFileTarget(root.path, dir, name);
    const destDir = resolveInsideRoot(root.path, destSubdir);
    if (!source || !destDir) throw fileError("invalid path", "invalid_path", 400);
    fs.mkdirSync(destDir, { recursive: true });
    fs.renameSync(source, path.join(destDir, name));
    return workbenchWriteResult(root, "move", { files: await listFiles(dir) }, this._discloseNativeRoot);
  }

  async movePaths(rootId, body: Record<string, any> = {}) {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "write");
    const items = Array.isArray(body.items) ? body.items : [];
    const destSubdir = normalizeSubdirOrThrow(body.destSubdir || "");
    const currentSubdir = normalizeSubdirOrThrow(body.currentSubdir || "");
    if (isSshRoot(root)) {
      const touchedSubdirs = new Set([currentSubdir, destSubdir]);
      for (const item of items) {
        const sourceSubdir = normalizeSubdirOrThrow(item?.sourceSubdir || "");
        const name = normalizePlainNameOrThrow(item?.name);
        await sshProvider(this).rename(root, sourceSubdir, name, destSubdir, name);
        touchedSubdirs.add(sourceSubdir);
      }
      const filesByPath = {};
      for (const touched of touchedSubdirs) {
        filesByPath[touched] = await sshProvider(this).list(root, touched);
      }
      return workbenchWriteResult(root, "movePaths", {
        filesByPath,
        files: await sshProvider(this).list(root, currentSubdir),
      }, this._discloseNativeRoot);
    }
    const destDir = resolveInsideRoot(root.path, destSubdir);
    if (!destDir) throw fileError("invalid path", "invalid_path", 400);
    fs.mkdirSync(destDir, { recursive: true });

    const touchedSubdirs = new Set([currentSubdir, destSubdir]);
    for (const item of items) {
      const sourceSubdir = normalizeSubdirOrThrow(item?.sourceSubdir || "");
      const name = normalizePlainNameOrThrow(item?.name);
      const sourceDir = resolveInsideRoot(root.path, sourceSubdir);
      if (!sourceDir) throw fileError("invalid path", "invalid_path", 400);
      const source = resolveFileTarget(root.path, sourceDir, name);
      const target = resolveFileTarget(root.path, destDir, name);
      if (!source || !target) throw fileError("invalid path", "invalid_path", 400);
      fs.renameSync(source, target);
      touchedSubdirs.add(sourceSubdir);
    }

    const filesByPath = {};
    for (const touched of touchedSubdirs) {
      const dir = resolveInsideRoot(root.path, touched);
      if (dir) filesByPath[touched] = await listFiles(dir);
    }
    const currentDir = resolveInsideRoot(root.path, currentSubdir);
    return workbenchWriteResult(root, "movePaths", {
      filesByPath,
      files: currentDir ? await listFiles(currentDir) : [],
    }, this._discloseNativeRoot);
  }

  async safeDelete(rootId, subdir, body: Record<string, any> = {}) {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "write");
    const normalizedSubdir = normalizeSubdirOrThrow(subdir);
    const name = normalizePlainNameOrThrow(body.name);
    const trashId = `trash_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    if (isSshRoot(root)) {
      await sshProvider(this).safeDelete(root, normalizedSubdir, name, trashId);
      return workbenchWriteResult(root, "safeDelete", {
        trashId,
        files: await sshProvider(this).list(root, normalizedSubdir),
      }, this._discloseNativeRoot);
    }
    const dir = writeDirForLocalRoot(root, normalizedSubdir);
    const source = resolveFileTarget(root.path, dir, name);
    if (!source || !fs.existsSync(source)) throw fileError("file not found", "file_not_found", 404);
    const trashDir = path.join(this._hanakoHome, "trash", "mobile-workbench", trashId);
    fs.mkdirSync(trashDir, { recursive: true });
    const payloadPath = path.join(trashDir, "payload");
    fs.renameSync(source, payloadPath);
    fs.writeFileSync(path.join(trashDir, "metadata.json"), JSON.stringify({
      schemaVersion: 1,
      trashId,
      rootId: root.id,
      mountId: root.mountId || root.id,
      originalName: name,
      originalSubdir: normalizedSubdir,
      deletedAt: new Date().toISOString(),
    }, null, 2) + "\n", "utf-8");
    return workbenchWriteResult(root, "safeDelete", { trashId, files: await listFiles(dir) }, this._discloseNativeRoot);
  }

  writeFileTarget(rootId, subdir, name) {
    const { root, dir } = this._writeDir(rootId, subdir);
    const filename = normalizePlainNameOrThrow(name);
    const target = resolveFileTarget(root.path, dir, filename);
    if (!target) throw fileError("invalid path", "invalid_path", 400);
    return { root, dir, filename, target };
  }

  async writeBinary(rootId, subdir, name, buffer) {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "write");
    const normalizedSubdir = normalizeSubdirOrThrow(subdir);
    const filename = normalizePlainNameOrThrow(name);
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
    if (isSshRoot(root)) {
      await sshProvider(this).writeBuffer(root, normalizedSubdir, filename, data);
      return { root, filename, size: data.byteLength };
    }
    const dir = writeDirForLocalRoot(root, normalizedSubdir);
    const target = resolveFileTarget(root.path, dir, filename);
    if (!target) throw fileError("invalid path", "invalid_path", 400);
    fs.writeFileSync(target, data);
    return { root, dir, filename, target, size: data.byteLength };
  }

  async filesForDirectory(rootId, subdir) {
    return (await this.listFiles(rootId, subdir)).files;
  }

  _writeDir(rootId = "default", subdir = "") {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "write");
    if (isSshRoot(root)) throw fileError("native directory is unavailable for ssh workspaces", "native_path_unavailable", 400);
    const normalizedSubdir = normalizeSubdirOrThrow(subdir);
    const dir = writeDirForLocalRoot(root, normalizedSubdir);
    return { root, dir, normalizedSubdir };
  }

  _resolveRootInternal(rootId = "default") {
    const id = typeof rootId === "string" && rootId.trim() ? rootId.trim() : "default";
    if (id === "default") {
      if (!this._defaultRoot) throw fileError("no workspace", "no_workspace", 400);
      fs.mkdirSync(this._defaultRoot, { recursive: true });
      return {
        id: "default",
        mountId: "default",
        workspaceId: "default",
        label: "Default",
        presentation: "folder",
        path: this._defaultRoot,
        capabilities: ["list", "read", "write"],
        sourceKind: "storage",
        provider: "local_fs",
      };
    }
    const mount = findStorageMount(this._hanakoHome, this._studioId, id);
    if (!mount) throw fileError("unknown root", "unknown_root", 404);
    if (mount.provider === "ssh") {
      const locator = normalizeSshRootLocator(mount.rootLocator);
      return {
        id: mount.mountId,
        mountId: mount.mountId,
        workspaceId: mount.mountId,
        label: mount.label,
        presentation: mount.presentation,
        capabilities: mount.capabilities,
        sourceKind: mount.sourceKind,
        provider: mount.provider,
        rootLocator: locator,
        remoteAuthority: `${locator.username}@${locator.host}:${locator.port}`,
      };
    }
    const rootPath = mount.rootLocator?.path;
    if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
      throw fileError("invalid mount root", "invalid_mount_root", 400);
    }
    fs.mkdirSync(rootPath, { recursive: true });
    return {
      id: mount.mountId,
      mountId: mount.mountId,
      workspaceId: mount.mountId,
      label: mount.label,
      presentation: mount.presentation,
      path: rootPath,
      capabilities: mount.capabilities,
      sourceKind: mount.sourceKind,
      provider: mount.provider,
    };
  }
}

function workbenchWriteResult(root, action, extra = {}, discloseNativeRoot = false) {
  return {
    ok: true,
    action,
    rootId: root.id,
    mountId: root.mountId || root.id,
    mount: publicRoot(root, discloseNativeRoot),
    ...extra,
  };
}

function findStorageMount(hanakoHome, studioId, rootId) {
  if (!studioId) return null;
  let registry;
  try {
    registry = loadStudioMountRegistry(hanakoHome);
  } catch {
    return null;
  }
  return registry.mounts.find((mount) => mount.mountId === rootId
    && mount.hostStudioId === studioId
    && mount.status === "active"
    && mount.sourceKind === "storage"
    && (mount.provider === "local_fs" || mount.provider === "ssh")) || null;
}

function publicRoot(root, discloseNativeRoot = false) {
  const {
    path: rootPath,
    rootLocator: _rootLocator,
    remotePath: _remotePath,
    ...safe
  } = root;
  if (discloseNativeRoot && root.sourceKind === "storage" && root.provider === "local_fs"
    && typeof rootPath === "string" && rootPath) {
    return { ...safe, nativeRootPath: rootPath };
  }
  return safe;
}

function requireCapability(root, capability) {
  if (!root.capabilities?.includes(capability)) {
    throw fileError("mount capability denied", "mount_capability_denied", 403);
  }
}

function sshProvider(service) {
  return service._sshProvider || getDefaultSshWorkspaceProvider();
}

function isSshRoot(root) {
  return root?.sourceKind === "storage" && root?.provider === "ssh";
}

function normalizeSshRootLocator(rootLocator) {
  const locator = rootLocator && typeof rootLocator === "object" ? rootLocator : {};
  const host = typeof locator.host === "string" ? locator.host.trim() : "";
  const username = typeof locator.username === "string" ? locator.username.trim() : "";
  const rootPath = typeof locator.rootPath === "string" && locator.rootPath.trim()
    ? locator.rootPath.trim()
    : (typeof locator.path === "string" && locator.path.trim() ? locator.path.trim() : "/");
  const port = Number(locator.port || 22);
  if (!host) throw fileError("ssh host required", "invalid_mount_root", 400);
  if (!username) throw fileError("ssh username required", "invalid_mount_root", 400);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw fileError("ssh port invalid", "invalid_mount_root", 400);
  }
  if (!rootPath.startsWith("/")) throw fileError("ssh rootPath must be absolute", "invalid_mount_root", 400);
  return {
    host,
    username,
    rootPath,
    port,
    password: typeof locator.password === "string" ? locator.password : undefined,
    privateKey: typeof locator.privateKey === "string" ? locator.privateKey : undefined,
    privateKeyPath: typeof locator.privateKeyPath === "string" ? locator.privateKeyPath : undefined,
    passphrase: typeof locator.passphrase === "string" ? locator.passphrase : undefined,
    readyTimeoutMs: Number(locator.readyTimeoutMs || 15000),
  };
}

async function listFiles(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.stat(fullPath);
      items.push({
        name: entry.name,
        isDir: entry.isDirectory(),
        size: entry.isDirectory() ? null : stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch (err) {
      if (err.code !== "ENOENT") log.warn(`stat failed: ${err.message}`);
    }
  }
  return items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh");
  });
}

function statFileVersionOrNull(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      mtimeMs: stat.mtime.getTime(),
      size: stat.size,
    };
  } catch (err) {
    if (err.code !== "ENOENT") log.warn(`stat version failed: ${err.message}`);
    return null;
  }
}

function normalizeExpectedVersionOrNull(value) {
  if (value == null) return null;
  const mtimeMs = Number(value.mtimeMs);
  const size = Number(value.size);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) {
    throw fileError("invalid expected version", "invalid_expected_version", 400);
  }
  return {
    mtimeMs,
    size,
    sha256: typeof value.sha256 === "string" ? value.sha256 : undefined,
  };
}

function fileVersionsMatch(current, expected) {
  if (current.mtimeMs !== expected.mtimeMs) return false;
  if (current.size !== expected.size) return false;
  if (expected.sha256 && current.sha256 !== expected.sha256) return false;
  return true;
}

async function searchFiles(rootPath, query) {
  const needle = query.toLowerCase();
  const results = [];
  async function walk(dir) {
    if (results.length >= SEARCH_LIMIT) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    for (const entry of entries) {
      if (results.length >= SEARCH_LIMIT) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && SEARCH_SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = toPortableRelative(rootPath, fullPath);
      const parentSubdir = toPortableRelative(rootPath, path.dirname(fullPath));
      if (entry.name.toLowerCase().includes(needle)) {
        try {
          const stat = await fs.promises.stat(fullPath);
          results.push({
            name: entry.name,
            relativePath,
            parentSubdir,
            isDir: entry.isDirectory(),
            size: entry.isDirectory() ? null : stat.size,
            mtime: stat.mtime.toISOString(),
          });
        } catch {}
      }
      if (entry.isDirectory()) await walk(fullPath);
    }
  }
  await walk(rootPath);
  return results.slice(0, SEARCH_LIMIT);
}

function writeDirForLocalRoot(root, normalizedSubdir) {
  const dir = resolveInsideRoot(root.path, normalizedSubdir);
  if (!dir) throw fileError("invalid path", "invalid_path", 400);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveInsideRoot(rootPath, subdir) {
  const rootReal = realPath(rootPath);
  if (!rootReal) return null;
  const target = subdir ? path.join(rootPath, subdir) : rootPath;
  const targetReal = realPath(target);
  if (targetReal) {
    return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep) ? targetReal : null;
  }
  const parentReal = realPath(path.dirname(target));
  if (!parentReal) return null;
  const full = path.join(parentReal, path.basename(target));
  return full === rootReal || full.startsWith(rootReal + path.sep) ? full : null;
}

function resolveFileTarget(rootPath, dir, name) {
  const target = path.join(dir, name);
  const rootReal = realPath(rootPath);
  if (!rootReal) return null;
  const resolved = realPath(target);
  if (resolved) return resolved === rootReal || resolved.startsWith(rootReal + path.sep) ? resolved : null;
  const parentReal = realPath(path.dirname(target));
  if (!parentReal) return null;
  const full = path.join(parentReal, path.basename(target));
  return full === rootReal || full.startsWith(rootReal + path.sep) ? full : null;
}

function normalizeSubdirOrThrow(value) {
  const raw = String(value || "").replace(/^\/+|\/+$/g, "");
  if (!raw) return "";
  if (raw.includes("\\") || raw.split("/").some((part) => part === ".." || part === "." || part.startsWith("."))) {
    throw fileError("invalid_subdir", "invalid_subdir", 400);
  }
  return raw;
}

function normalizePlainNameOrThrow(value) {
  const name = String(value || "").trim();
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name.startsWith(".")) {
    throw fileError("invalid name", "invalid_name", 400);
  }
  return name;
}

function toPortableRelative(root, target) {
  return path.relative(root, target).split(path.sep).filter(Boolean).join("/");
}

function fileError(message, code, status) {
  return new MountAwareFileError(message, { code, status });
}

function realPath(p) {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return null;
  }
}
