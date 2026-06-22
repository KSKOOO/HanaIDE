import fs from "fs";
import os from "os";
import path from "path";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  DEFAULT_WORKSPACE_DIRNAME,
} from "./default-workspace-constants.ts";

export {
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  DEFAULT_WORKSPACE_DIRNAME,
};

export function resolveDefaultWorkspacePath(homeDir = os.homedir()) {
  return path.join(homeDir, "Desktop", DEFAULT_WORKSPACE_DIRNAME);
}

export function ensureDefaultWorkspace(homeDir = os.homedir()) {
  const workspacePath = resolveDefaultWorkspacePath(homeDir);
  fs.mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

export function restoreDefaultWorkspaceIfMissing(cwd, homeDir = os.homedir()) {
  if (typeof cwd !== "string" || !cwd.trim()) return false;
  const defaultPath = resolveDefaultWorkspacePath(homeDir);
  const normalize = (p) =>
    process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
  if (normalize(cwd) !== normalize(defaultPath)) return false;
  if (fs.existsSync(defaultPath)) return false;
  fs.mkdirSync(defaultPath, { recursive: true });
  return true;
}
