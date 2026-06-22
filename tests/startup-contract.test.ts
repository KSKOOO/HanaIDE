import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import viteServerConfig from "../vite.config.server.js";
import { applyDevEnvironment } from "../scripts/dev-env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

describe("local startup contract", () => {
  it("start scripts build theme bundle before launching Electron", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts.start).toContain("build:theme");
    expect(pkg.scripts["start:dev"]).toContain("build:theme");
  });

  it("dev Electron launcher passes a dedicated Node runtime to main process", () => {
    const launchJs = fs.readFileSync(path.join(ROOT, "scripts", "launch.js"), "utf-8");
    const devEnvJs = fs.readFileSync(path.join(ROOT, "scripts", "dev-env.js"), "utf-8");
    const mainCjs = fs.readFileSync(path.join(ROOT, "desktop", "main.cjs"), "utf-8");

    expect(launchJs).toContain('from "./dev-env.js"');
    expect(launchJs).toContain("applyDevEnvironment(process.env)");
    expect(devEnvJs).toContain("HANA_DEV_NODE_BIN");
    expect(mainCjs).toContain("HANA_DEV_NODE_BIN");

    const env = applyDevEnvironment({}, { nodeBin: "/tmp/hana-node" });
    expect(env.HANA_DEV_NODE_BIN).toBe("/tmp/hana-node");
  });

  it("server configures Pi SDK from HANA_HOME and CLI stays server-first", () => {
    const cliSource = fs.readFileSync(path.join(ROOT, "index.js"), "utf-8");
    const cliEntrySource = fs.readFileSync(path.join(ROOT, "cli", "entry.ts"), "utf-8");
    const launchSource = fs.readFileSync(path.join(ROOT, "scripts", "launch.js"), "utf-8");
    const serverSource = fs.readFileSync(path.join(ROOT, "server", "index.ts"), "utf-8");

    expect(cliSource).toContain("./cli/entry.ts");
    expect(cliSource).not.toContain("HanaEngine");
    expect(cliEntrySource).not.toContain("HanaEngine");
    expect(launchSource).toContain('"cli", "entry.ts"');
    expect(serverSource).toContain("ensureHanaPiSdkDirs(hanakoHome)");
    expect(serverSource).toContain("configureProcessPiSdkEnv(hanakoHome)");
  });

  it("desktop main propagates Hana-owned Pi SDK env to the spawned server", () => {
    const mainCjs = fs.readFileSync(path.join(ROOT, "desktop", "main.cjs"), "utf-8");

    expect(mainCjs).toContain("ensureHanaPiSdkDirs(hanakoHome)");
    expect(mainCjs).toContain("configureProcessPiSdkEnv(hanakoHome)");
    expect(mainCjs).toContain("withHanaPiSdkEnv(process.env, hanakoHome)");
  });

  it("desktop main installs the client single-instance lock before app readiness", () => {
    const mainCjs = fs.readFileSync(path.join(ROOT, "desktop", "main.cjs"), "utf-8");

    expect(mainCjs).toContain("configureClientSingleInstance(app");
    expect(mainCjs).toContain("onSecondInstance: () => showPrimaryWindow()");
    expect(mainCjs.indexOf("configureClientSingleInstance(app")).toBeLessThan(
      mainCjs.indexOf("app.whenReady()"),
    );
  });

  it("keeps jsdom external in the server bundle for packaged runtime", () => {
    const external = viteServerConfig.build?.rollupOptions?.external || [];

    expect(external).toContain("jsdom");
  });

  it("keeps the native jieba tokenizer external in the server bundle", () => {
    const external = viteServerConfig.build?.rollupOptions?.external || [];

    expect(external).toContain("@node-rs/jieba");
  });

  it("keeps workspace output helper statically bundleable in packaged server", () => {
    const source = fs.readFileSync(path.join(ROOT, "shared", "workspace-output.ts"), "utf-8");

    expect(source).toContain('from "./workspace-output.cjs"');
    expect(source).not.toContain("createRequire");
    expect(source).not.toContain('require("./workspace-output.cjs")');
  });

  it("server-only packaging emits a bundled CLI and wrapper", () => {
    const buildServer = fs.readFileSync(path.join(ROOT, "scripts", "build-server.mjs"), "utf-8");

    expect(buildServer).toContain("bundle/cli.js");
    expect(buildServer).toContain('path.join(ROOT, "cli", "entry.ts")');
    expect(buildServer).toContain('path.join(outDir, "hana")');
    expect(buildServer).toContain('path.join(outDir, "hana.cmd")');
  });

  it("server dependency install explicitly enables native package scripts", () => {
    const buildServer = fs.readFileSync(path.join(ROOT, "scripts", "build-server.mjs"), "utf-8");

    expect(buildServer).toContain("--ignore-scripts=false");
    expect(buildServer).toContain("runBetterSqliteRuntimeSmokeIfNeeded()");
  });
});
