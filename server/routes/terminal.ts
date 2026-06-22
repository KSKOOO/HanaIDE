import { Hono } from "hono";
import fs from "fs";
import path from "path";
import { safeJson } from "../hono-helpers.ts";
import { MountAwareFileService } from "../../core/mount-aware-file-service.ts";

const VALID_ACTIONS = new Set(["start", "list", "read", "write", "close"]);
const VALID_TERMINAL_PROFILES = new Set([
  "shell",
  "hana-cli",
  "vscode-cli",
  "windows-terminal",
  "default",
  "powershell",
  "pwsh",
  "cmd",
  "git-bash",
  "bash",
  "posix",
]);

function nonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function optionalNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function terminalProfile(value: unknown): string {
  const profile = nonEmptyString(value).toLowerCase();
  return VALID_TERMINAL_PROFILES.has(profile) ? profile : "shell";
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function productRootFromEngine(engine: any): string {
  const productDir = nonEmptyString(engine?.productDir);
  return productDir ? path.resolve(productDir, "..") : process.cwd();
}

function existingFile(filePath: string): string {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : "";
  } catch {
    return "";
  }
}

function resolveHanaCliEntry(productRoot: string): string {
  return existingFile(path.join(productRoot, "bundle", "cli.js"))
    || existingFile(path.join(productRoot, "cli", "entry.ts"))
    || existingFile(path.join(productRoot, "scripts", "launch.js"))
    || path.join(productRoot, "cli", "entry.ts");
}

function buildHanaCliCommand({
  entry,
  execPath,
  platform,
}: {
  entry: string;
  execPath: string;
  platform: NodeJS.Platform | string;
}): string {
  if (path.basename(entry).toLowerCase() === "launch.js") {
    if (platform === "win32") {
      return `& ${quotePowerShell(execPath)} ${quotePowerShell(entry)} cli`;
    }
    return `${quotePosix(execPath)} ${quotePosix(entry)} cli`;
  }
  if (platform === "win32") {
    return `& ${quotePowerShell(execPath)} ${quotePowerShell(entry)}`;
  }
  return `${quotePosix(execPath)} ${quotePosix(entry)}`;
}

export function resolveTerminalProfileCommand({
  command,
}: {
  command?: unknown;
}): string {
  const explicit = typeof command === "string" ? command : "";
  if (explicit.trim()) return explicit;
  return "";
}

export function resolveTerminalProfileStartupCommand({
  startupCommand,
  profile,
  engine,
  platform = process.platform,
  execPath = process.execPath,
  cwd = "",
}: {
  startupCommand?: unknown;
  profile?: unknown;
  engine?: any;
  platform?: NodeJS.Platform | string;
  execPath?: string;
  cwd?: unknown;
}): string {
  const explicit = typeof startupCommand === "string" ? startupCommand : "";
  if (explicit.trim()) return explicit;
  const normalizedProfile = terminalProfile(profile);
  if (normalizedProfile === "vscode-cli") {
    const target = nonEmptyString(cwd);
    if (!target) return "code .";
    return platform === "win32" ? `code ${quotePowerShell(target)}` : `code ${quotePosix(target)}`;
  }
  if (normalizedProfile !== "hana-cli") return "";
  const entry = resolveHanaCliEntry(productRootFromEngine(engine));
  return buildHanaCliCommand({ entry, execPath, platform });
}

function routeError(message: string, status = 400) {
  const err: any = new Error(message);
  err.status = status;
  return err;
}

function terminalErrorStatus(err: any): number {
  if (Number.isInteger(err?.status)) return err.status;
  if (err?.code === "HANA_EXEC_CWD_MISSING") return 400;
  return 500;
}

export function createTerminalRoute(engine: any) {
  const route = new Hono();

  route.post("/terminal/session", async (c) => {
    try {
      const body = await safeJson(c);
      const action = nonEmptyString(body?.action).toLowerCase();
      if (!VALID_ACTIONS.has(action)) {
        throw routeError("action must be one of: start, list, read, write, close");
      }

      const sessionPath = nonEmptyString(body?.sessionPath);
      if (!sessionPath) throw routeError("sessionPath is required");

      const manager = engine?.terminalSessions;
      if (!manager) throw routeError("terminal manager unavailable", 503);

      if (action === "list") {
        return c.json(manager.list(sessionPath));
      }

      if (action === "start") {
        const workspaceMountId = nonEmptyString(body?.workspaceMountId) || nonEmptyString(body?.mountId);
        const workspace = workspaceMountId ? resolveTerminalWorkspace(engine, workspaceMountId) : null;
        const cwd = workspace?.provider === "ssh"
          ? (nonEmptyString(body?.remoteCwd) || nonEmptyString(workspace?.rootLocator?.rootPath) || "/")
          : (nonEmptyString(body?.cwd) || nonEmptyString(workspace?.path) || nonEmptyString(engine?.cwd));
        if (!cwd) throw routeError("cwd is required");
        const profile = terminalProfile(body?.profile ?? body?.terminalProfile);
        const result = await manager.start({
          sessionPath,
          agentId: nonEmptyString(body?.agentId) || nonEmptyString(engine?.currentAgentId),
          cwd,
          provider: workspace?.provider === "ssh" ? "ssh" : "local",
          workspaceMountId: workspace?.mountId || workspaceMountId || null,
          rootLocator: workspace?.provider === "ssh" ? workspace.rootLocator : null,
          remoteAuthority: workspace?.remoteAuthority || null,
          command: resolveTerminalProfileCommand({ command: body?.command }),
          startupCommand: resolveTerminalProfileStartupCommand({
            startupCommand: body?.startupCommand,
            profile,
            engine,
            cwd,
          }),
          profile,
          label: typeof body?.label === "string" ? body.label : "",
          cols: optionalNumber(body?.cols, 100),
          rows: optionalNumber(body?.rows, 24),
        });
        return c.json(sanitizeTerminalResult(result));
      }

      const terminalId = nonEmptyString(body?.terminalId) || nonEmptyString(body?.terminal_id);
      if (!terminalId) throw routeError("terminalId is required");

      if (action === "read") {
        return c.json(manager.read({
          sessionPath,
          terminalId,
          sinceSeq: optionalNumber(body?.sinceSeq ?? body?.since_seq, 0),
        }));
      }

      if (action === "write") {
        return c.json(manager.write({
          sessionPath,
          terminalId,
          chars: typeof body?.chars === "string" ? body.chars : "",
        }));
      }

      return c.json(manager.close({ sessionPath, terminalId }));
    } catch (err: any) {
      return c.json({ error: err?.message || String(err) }, terminalErrorStatus(err) as any);
    }
  });

  return route;
}

export const __testing = {
  resolveTerminalProfileCommand,
  resolveTerminalProfileStartupCommand,
};

function sanitizeTerminalResult(result: any) {
  if (!result || typeof result !== "object") return result;
  const { rootLocator: _rootLocator, ...safe } = result;
  return safe;
}

function resolveTerminalWorkspace(engine: any, mountId: string) {
  if (typeof engine?.resolveTerminalWorkspace === "function") {
    return engine.resolveTerminalWorkspace(mountId);
  }
  const service = engine?.mountAwareFileService || engine?.workspaceFileService || new MountAwareFileService({
    hanakoHome: engine?.hanakoHome,
    defaultRoot: engine?.defaultDeskCwd || engine?.homeCwd || engine?.deskCwd || engine?.cwd,
    studioId: engine?.getRuntimeContext?.()?.studioId || null,
    createCheckpoint: typeof engine?.createUserEditCheckpoint === "function"
      ? (args) => engine.createUserEditCheckpoint(args)
      : null,
    sshProvider: engine?.sshWorkspaceProvider || engine?.sshProvider || null,
    discloseNativeRoot: true,
  });
  if (typeof service.resolveExecutionRoot === "function") {
    return service.resolveExecutionRoot(mountId);
  }
  const root = service.resolveRoot(mountId);
  return {
    ...root,
    path: root.nativeRootPath || null,
  };
}
