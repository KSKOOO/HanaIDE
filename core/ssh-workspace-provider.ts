import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Client } from "ssh2";

const SSH_READY_TIMEOUT_MS = 15000;
const REMOTE_SEARCH_LIMIT = 80;
const REMOTE_SEARCH_SKIP_DIRS = new Set([
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

let defaultProvider: SshWorkspaceProvider | null = null;

export function getDefaultSshWorkspaceProvider() {
  if (!defaultProvider) defaultProvider = new SshWorkspaceProvider();
  return defaultProvider;
}

export class SshWorkspaceProvider {
  async list(root, subdir = "") {
    return this.withSftp(root, async (sftp) => {
      const dir = remotePath(root, subdir);
      const entries = await sftpCall(sftp, "readdir", dir).catch((err) => {
        if (err?.code === 2 || err?.message?.includes("No such file")) return [];
        throw err;
      }) as any[];
      const items = [];
      for (const entry of entries || []) {
        const name = entry?.filename || "";
        if (!name || name === "." || name === ".." || name.startsWith(".")) continue;
        const attrs = entry.attrs || {};
        items.push({
          name,
          isDir: isDirectoryAttrs(attrs),
          size: isDirectoryAttrs(attrs) ? null : Number(attrs.size || 0),
          mtime: attrsToIso(attrs),
        });
      }
      return sortRemoteItems(items);
    });
  }

  async search(root, query = "") {
    const needle = String(query || "").toLowerCase();
    if (!needle) return [];
    return this.withSftp(root, async (sftp) => {
      const rootPath = remoteRoot(root);
      const results = [];
      const walk = async (dir, relativeDir = "") => {
        if (results.length >= REMOTE_SEARCH_LIMIT) return;
        let entries;
        try {
          entries = await sftpCall(sftp, "readdir", dir) as any[];
        } catch {
          return;
        }
        for (const entry of entries || []) {
          if (results.length >= REMOTE_SEARCH_LIMIT) break;
          const name = entry?.filename || "";
          if (!name || name === "." || name === ".." || name.startsWith(".")) continue;
          const attrs = entry.attrs || {};
          const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
          const isDir = isDirectoryAttrs(attrs);
          if (name.toLowerCase().includes(needle)) {
            results.push({
              name,
              relativePath,
              parentSubdir: relativeDir,
              isDir,
              size: isDir ? null : Number(attrs.size || 0),
              mtime: attrsToIso(attrs),
            });
          }
          if (isDir && !REMOTE_SEARCH_SKIP_DIRS.has(name)) {
            await walk(posixJoin(rootPath, relativePath), relativePath);
          }
        }
      };
      await walk(rootPath, "");
      return results.slice(0, REMOTE_SEARCH_LIMIT);
    });
  }

  async materializeFile(root, subdir, name, { cacheDir }) {
    return this.withSftp(root, async (sftp) => {
      const target = remotePath(root, subdir, name);
      const raw = await sftpCall(sftp, "readFile", target);
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any);
      const safeName = safeCacheName(root, subdir, name);
      const localDir = path.join(cacheDir, root.mountId || root.id || "ssh");
      fs.mkdirSync(localDir, { recursive: true });
      const filePath = path.join(localDir, safeName);
      fs.writeFileSync(filePath, buffer);
      return { root, filePath, filename: name };
    });
  }

  async statFileVersion(root, subdir, name) {
    return this.withSftp(root, async (sftp) => {
      const target = remotePath(root, subdir, name);
      try {
        const attrs = await sftpCall(sftp, "stat", target);
        if (!isFileAttrs(attrs)) return null;
        return attrsToVersion(attrs);
      } catch (err) {
        if (err?.code === 2 || err?.message?.includes("No such file")) return null;
        throw err;
      }
    });
  }

  async mkdir(root, subdir, name) {
    return this.withSftp(root, async (sftp) => {
      await sftpCall(sftp, "mkdir", remotePath(root, subdir, name));
    });
  }

  async writeText(root, subdir, name, content) {
    return this.writeBuffer(root, subdir, name, Buffer.from(String(content ?? ""), "utf-8"));
  }

  async writeBuffer(root, subdir, name, buffer) {
    return this.withSftp(root, async (sftp) => {
      await ensureRemoteDir(sftp, remotePath(root, subdir));
      await sftpCall(sftp, "writeFile", remotePath(root, subdir, name), buffer);
    });
  }

  async rename(root, sourceSubdir, oldName, destSubdir, newName = oldName) {
    return this.withSftp(root, async (sftp) => {
      await ensureRemoteDir(sftp, remotePath(root, destSubdir));
      await sftpCall(sftp, "rename", remotePath(root, sourceSubdir, oldName), remotePath(root, destSubdir, newName));
    });
  }

  async safeDelete(root, subdir, name, trashId) {
    return this.withSftp(root, async (sftp) => {
      const trashDir = remotePath(root, ".hanaide-trash/mobile-workbench", trashId);
      await ensureRemoteDir(sftp, trashDir);
      await sftpCall(sftp, "rename", remotePath(root, subdir, name), posixJoin(trashDir, "payload"));
      const metadata = JSON.stringify({
        schemaVersion: 1,
        trashId,
        rootId: root.id,
        mountId: root.mountId || root.id,
        originalName: name,
        originalSubdir: subdir,
        deletedAt: new Date().toISOString(),
      }, null, 2) + "\n";
      await sftpCall(sftp, "writeFile", posixJoin(trashDir, "metadata.json"), Buffer.from(metadata, "utf-8"));
    });
  }

  async withSftp(root, operation) {
    const config = sshConfig(root);
    return await new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      const finish = (err, value = undefined) => {
        if (settled) return;
        settled = true;
        try {
          conn.end();
        } catch {}
        if (err) reject(sshError(err));
        else resolve(value);
      };
      conn.once("ready", () => {
        conn.sftp(async (err, sftp) => {
          if (err) {
            finish(err);
            return;
          }
          try {
            finish(null, await operation(sftp));
          } catch (opErr) {
            finish(opErr);
          }
        });
      });
      conn.once("error", (err) => finish(err));
      conn.once("timeout", () => finish(new Error("SSH connection timed out")));
      try {
        conn.connect(config);
      } catch (err) {
        finish(err);
      }
    });
  }
}

async function ensureRemoteDir(sftp, dir) {
  const normalized = normalizeRemotePath(dir);
  const parts = normalized.split("/").filter(Boolean);
  let current = normalized.startsWith("/") ? "/" : "";
  for (const part of parts) {
    current = current === "/" ? `/${part}` : (current ? `${current}/${part}` : part);
    try {
      await sftpCall(sftp, "stat", current);
    } catch {
      await sftpCall(sftp, "mkdir", current).catch((err) => {
        if (err?.code !== 4) throw err;
      });
    }
  }
}

function sshConfig(root) {
  const locator = root.rootLocator || {};
  const host = String(locator.host || "").trim();
  const username = String(locator.username || "").trim();
  if (!host) throw sshError(new Error("SSH host required"));
  if (!username) throw sshError(new Error("SSH username required"));

  const config: Record<string, any> = {
    host,
    username,
    port: normalizePort(locator.port),
    readyTimeout: normalizeTimeout(locator.readyTimeoutMs),
  };
  if (typeof locator.password === "string" && locator.password) config.password = locator.password;
  if (typeof locator.passphrase === "string" && locator.passphrase) config.passphrase = locator.passphrase;
  if (typeof locator.privateKey === "string" && locator.privateKey) config.privateKey = locator.privateKey;
  if (!config.privateKey && typeof locator.privateKeyPath === "string" && locator.privateKeyPath.trim()) {
    config.privateKey = fs.readFileSync(path.resolve(locator.privateKeyPath.trim()), "utf-8");
  }
  if (!config.password && !config.privateKey && process.env.SSH_AUTH_SOCK) {
    config.agent = process.env.SSH_AUTH_SOCK;
  }
  return config;
}

function normalizePort(value) {
  const port = Number(value || 22);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22;
}

function normalizeTimeout(value) {
  const timeout = Number(value || SSH_READY_TIMEOUT_MS);
  return Number.isFinite(timeout) && timeout >= 1000 ? timeout : SSH_READY_TIMEOUT_MS;
}

function remotePath(root, subdir = "", name = "") {
  const base = remoteRoot(root);
  const parts = [base, subdir, name].filter((part) => typeof part === "string" && part);
  return normalizeRemotePath(posixJoin(...parts));
}

function remoteRoot(root) {
  const locator = root.rootLocator || {};
  const raw = String(locator.rootPath || locator.path || "/").trim() || "/";
  const normalized = normalizeRemotePath(raw);
  if (!normalized.startsWith("/")) throw sshError(new Error("SSH rootPath must be absolute"));
  return normalized;
}

function normalizeRemotePath(value) {
  const raw = String(value || "/").replace(/\\/g, "/");
  const normalized = path.posix.normalize(raw);
  return normalized === "." ? "/" : normalized;
}

function posixJoin(...parts) {
  return path.posix.join(...parts.map((part) => String(part || "")));
}

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function attrsToIso(attrs) {
  const mtimeMs = attrsToMtimeMs(attrs);
  return new Date(mtimeMs || Date.now()).toISOString();
}

function attrsToVersion(attrs) {
  return {
    mtimeMs: attrsToMtimeMs(attrs),
    size: Number(attrs?.size || 0),
  };
}

function attrsToMtimeMs(attrs) {
  if (Number.isFinite(attrs?.mtimeMs)) return Number(attrs.mtimeMs);
  if (Number.isFinite(attrs?.mtime)) return Number(attrs.mtime) * 1000;
  if (Number.isFinite(attrs?.atimeMs)) return Number(attrs.atimeMs);
  return Date.now();
}

function isDirectoryAttrs(attrs) {
  if (typeof attrs?.isDirectory === "function") return attrs.isDirectory();
  const mode = Number(attrs?.mode || 0);
  return (mode & 0o170000) === 0o040000;
}

function isFileAttrs(attrs) {
  if (typeof attrs?.isFile === "function") return attrs.isFile();
  const mode = Number(attrs?.mode || 0);
  return !mode || (mode & 0o170000) === 0o100000;
}

function sortRemoteItems(items) {
  return items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh");
  });
}

function safeCacheName(root, subdir, name) {
  const digest = crypto.createHash("sha256")
    .update(`${root.mountId || root.id}\0${subdir}\0${name}`)
    .digest("hex")
    .slice(0, 16);
  const ext = path.extname(name).slice(0, 16);
  const stem = path.basename(name, ext).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "remote";
  return `${stem}-${digest}${ext}`;
}

function sshError(err) {
  const message = err?.message || String(err || "SSH workspace failed");
  const wrapped: any = new Error(`SSH workspace failed: ${message}`);
  wrapped.code = "ssh_workspace_failed";
  wrapped.status = 502;
  return wrapped;
}
