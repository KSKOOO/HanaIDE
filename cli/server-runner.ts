import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { readLocalServerInfo, resolveCliHanaHome } from "./local-server.ts";

export function resolveServerSpawnSpec({
  projectRoot,
  env = process.env,
  extraArgs = [],
}: { projectRoot?: string; env?: NodeJS.ProcessEnv; extraArgs?: string[] } = {}) {
  const root = projectRoot || path.resolve(import.meta.dirname, "..");
  const explicitRoot = env.HANA_ROOT && fs.existsSync(path.join(env.HANA_ROOT, "bootstrap.js"))
    ? env.HANA_ROOT
    : null;
  const packagedRoot = explicitRoot || (
    fs.existsSync(path.join(root, "bootstrap.js"))
    && fs.existsSync(path.join(root, "bundle", "index.js"))
      ? root
      : null
  );

  if (packagedRoot) {
    return {
      mode: "packaged",
      command: process.execPath,
      args: [path.join(packagedRoot, "bootstrap.js"), ...extraArgs],
      env: {
        ...env,
        HANA_ROOT: packagedRoot,
        HANA_SERVER_ENTRY: path.join(packagedRoot, "bundle", "index.js"),
      },
    };
  }

  return {
    mode: "source",
    command: process.execPath,
    args: [path.join(root, "server", "index.ts"), ...extraArgs],
    env,
  };
}

export function spawnServerForeground({ projectRoot, extraArgs = [], env = process.env }: { projectRoot?: string; extraArgs?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const spec = resolveServerSpawnSpec({ projectRoot, env, extraArgs });
  const child = spawn(spec.command, spec.args, {
    stdio: "inherit",
    env: spec.env,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  return child;
}

export async function startLocalServerAndWait({
  projectRoot,
  env = process.env,
  timeoutMs = 30000,
  intervalMs = 250,
}: { projectRoot?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; intervalMs?: number } = {}) {
  const hanaHome = resolveCliHanaHome(env);
  const existing = readLocalServerInfo({ hanaHome });
  if (existing.ok) return existing;

  const spec = resolveServerSpawnSpec({ projectRoot, env, extraArgs: [] });
  const child = spawn(spec.command, spec.args, {
    stdio: "ignore",
    detached: true,
    env: spec.env,
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const info = readLocalServerInfo({ hanaHome });
    if (info.ok) return { ...info, started: true, serverMode: spec.mode };
    await delay(intervalMs);
  }

  throw new Error(`HanaAgent Server did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
