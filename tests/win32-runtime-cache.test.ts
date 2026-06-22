import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareSandboxRuntime,
  sandboxRuntimeCacheRoot,
} from "../lib/sandbox/win32-runtime-cache.ts";

const tempRoots = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-runtime-cache-test-"));
  tempRoots.push(root);
  return root;
}

function touch(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("win32 sandbox runtime cache", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("mirrors bundled Git under HANA_HOME and rewrites all runtime paths", () => {
    const tempRoot = makeTempRoot();
    const hanakoHome = path.join(tempRoot, "home");
    const sourceRoot = path.join(tempRoot, "Program Files", "Hanako", "resources", "git");
    const sourceGit = path.join(sourceRoot, "cmd", "git.exe");
    touch(sourceGit, "git");
    touch(path.join(sourceRoot, "bin", "bash.exe"), "bash");

    const prepared = prepareSandboxRuntime({
      bundledRoot: sourceRoot,
      git: sourceGit,
    }, {
      hanakoHome,
      kind: "git",
    });

    const cacheRoot = sandboxRuntimeCacheRoot(hanakoHome);
    expect(prepared.bundledRoot.startsWith(cacheRoot)).toBe(true);
    expect(prepared.git).toBe(path.join(prepared.bundledRoot, "cmd", "git.exe"));
    expect(prepared.git).not.toBe(sourceGit);
    expect(fs.existsSync(prepared.git)).toBe(true);
    expect(path.relative(hanakoHome, prepared.git).startsWith("..")).toBe(false);
  });

  it("mirrors the Node executable directory under HANA_HOME", () => {
    const tempRoot = makeTempRoot();
    const hanakoHome = path.join(tempRoot, "home");
    const sourceRoot = path.join(tempRoot, "Program Files", "Hanako", "resources", "server");
    const sourceNode = path.join(sourceRoot, "hana-server.exe");
    touch(sourceNode, "node");
    touch(path.join(sourceRoot, "node.dll"), "dll");

    const prepared = prepareSandboxRuntime({
      executable: sourceNode,
    }, {
      hanakoHome,
      kind: "node",
    });

    const cacheRoot = sandboxRuntimeCacheRoot(hanakoHome);
    expect(prepared.executable.startsWith(cacheRoot)).toBe(true);
    expect(prepared.executable).not.toBe(sourceNode);
    expect(fs.existsSync(prepared.executable)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(prepared.executable), "node.dll"))).toBe(true);
    expect(path.relative(hanakoHome, prepared.executable).startsWith("..")).toBe(false);
  });

  it("reuses a valid cached runtime instead of copying on every command", () => {
    const tempRoot = makeTempRoot();
    const hanakoHome = path.join(tempRoot, "home");
    const sourceRoot = path.join(tempRoot, "Program Files", "Hanako", "resources", "git");
    const sourceGit = path.join(sourceRoot, "cmd", "git.exe");
    touch(sourceGit, "git");

    const first = prepareSandboxRuntime({
      bundledRoot: sourceRoot,
      git: sourceGit,
    }, {
      hanakoHome,
      kind: "git",
    });
    const marker = path.join(first.bundledRoot, ".hana-sandbox-runtime.json");
    const markerBefore = fs.statSync(marker).mtimeMs;

    const second = prepareSandboxRuntime({
      bundledRoot: sourceRoot,
      git: sourceGit,
    }, {
      hanakoHome,
      kind: "git",
    });

    expect(second).toEqual(first);
    expect(fs.statSync(marker).mtimeMs).toBe(markerBefore);
  });
});
