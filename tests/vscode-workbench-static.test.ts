import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = process.cwd();
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8");

describe("VSCode workbench host compatibility layer", () => {
  it("defines a shared workbench contract with automatic updates disabled by default", () => {
    const contract = require("../desktop/src/shared/vscode-workbench-contract.cjs");
    expect(contract.VSCODE_WORKBENCH_STATUS.ready).toBe("ready");
    expect(contract.VSCODE_WORKBENCH_DEFAULTS.enabled).toBe(false);
    expect(contract.VSCODE_WORKBENCH_DEFAULTS.galleryEnabled).toBe(true);
    expect(contract.VSCODE_WORKBENCH_DEFAULTS.extensionAutoUpdate).toBe(false);
    expect(contract.VSCODE_WORKBENCH_DEFAULTS.appAutoUpdate).toBe(false);
  });

  it("wires platform API through main, preload, and fallback contracts", () => {
    const platformContract = read("desktop", "src", "shared", "platform-contract.cjs");
    const preload = read("desktop", "preload.cjs");
    const main = read("desktop", "main.cjs");
    const webFallback = read("desktop", "src", "modules", "platform.js");
    const mobileFallback = read("desktop", "src", "react", "mobile", "mobile-platform.ts");

    for (const name of [
      "getVscodeWorkbenchStatus",
      "openVscodeWorkbench",
      "closeVscodeWorkbench",
      "reloadVscodeWorkbench",
      "onVscodeWorkbenchStatus",
    ]) {
      expect(platformContract).toContain(name);
      expect(preload).toContain(name);
    }

    expect(main).toContain("getVscodeWorkbenchDiagnostics");
    expect(main).toContain("disableVscodeWorkbenchLaunch");
    expect(main).not.toContain("wrapIpcBestEffortHandler(HANA_IPC_CHANNELS.openVscodeWorkbench, () => launchVscodeWorkbenchFork())");
    expect(main).not.toContain("wrapIpcBestEffortHandler(HANA_IPC_CHANNELS.reloadVscodeWorkbench, () => launchVscodeWorkbenchFork");
    expect(main).toContain("scripts");
    expect(main).toContain("code.bat");
    expect(main).toContain("const command = launcherPath");
    expect(main).toContain("delete env.VSCODE_SKIP_PRELAUNCH");
    expect(main).not.toContain('env.VSCODE_SKIP_PRELAUNCH = "1"');
    expect(main).not.toContain("Native workbench host will be attached in Phase 2.");
    expect(main).toContain("readVscodeWorkbenchPreferences");
    expect(main).toContain("vscode-workbench-config-changed");
    expect(main).toContain("vscode-workbench-status");
    expect(platformContract).toContain("VSCODE_WORKBENCH_IPC_CHANNELS.getStatus");
    expect(platformContract).toContain("VSCODE_WORKBENCH_IPC_EVENTS.status");
    expect(webFallback).toContain("unavailableVscodeWorkbenchStatus");
    expect(mobileFallback).toContain("getVscodeWorkbenchStatus");
  });

  it("keeps the workbench integration dormant while the renderer uses native Coding Mode", () => {
    const types = read("desktop", "src", "react", "types.ts");
    const appPages = read("desktop", "src", "react", "components", "app", "AppPages.tsx");
    const tabBar = read("desktop", "src", "react", "components", "channels", "ChannelTabBar.tsx");
    const settingsContent = read("desktop", "src", "react", "settings", "SettingsContent.tsx");
    const workbenchPage = read("desktop", "src", "react", "components", "vscode", "VscodeWorkbenchPage.tsx");
    const codingPage = read("desktop", "src", "react", "components", "coding", "CodingModePage.tsx");
    const configSchema = read("shared", "config-schema.ts");
    const preferencesManager = read("core", "preferences-manager.ts");
    const engine = read("core", "engine.ts");

    expect(types).not.toContain("'vscode-workbench' |");
    expect(appPages).toContain("CodingModePage");
    expect(appPages).not.toContain("VscodeWorkbenchPage");
    expect(tabBar).toContain("channel.codingTab");
    expect(tabBar).not.toContain("channel.vscodeWorkbenchTab");
    expect(settingsContent).not.toContain("VscodeWorkbenchTab");
    expect(codingPage).toContain("data-coding-mode-page");
    expect(codingPage).not.toContain("openVscodeWorkbench");
    expect(workbenchPage).toContain("openVscodeWorkbench");
    expect(configSchema).toContain("'vscodeWorkbench.extensionAutoUpdate'");
    expect(configSchema).toContain("setVscodeWorkbenchExtensionAutoUpdate");
    expect(configSchema).toContain("'vscodeWorkbench.appAutoUpdate'");
    expect(configSchema).toContain("defaultValue: false");
    expect(preferencesManager).toContain("getVscodeWorkbenchPreferences");
    expect(preferencesManager).toContain("setVscodeWorkbenchEnabled");
    expect(engine).toContain("getVscodeWorkbenchPreferences()");
  });
});
