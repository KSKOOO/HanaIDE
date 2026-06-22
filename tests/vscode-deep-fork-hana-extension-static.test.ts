import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const openHanakoRoot = process.cwd();
const vscodeRoot = path.resolve(openHanakoRoot, "..", "vscode-1.125.0");

const readOpenHanako = (...parts: string[]) => fs.readFileSync(path.join(openHanakoRoot, ...parts), "utf8");
const readVscode = (...parts: string[]) => fs.readFileSync(path.join(vscodeRoot, ...parts), "utf8");

describe("OpenHanako Code deep-fork Hana integration", () => {
  it("serves the full desktop renderer through an authenticated web app route", () => {
    const staticRoute = readOpenHanako("server", "routes", "mobile-static.ts");
    const routeSecurity = readOpenHanako("server", "http", "route-security.ts");

    expect(staticRoute).toContain('registerWebClientRoute(route, "/app", distDir, "index.html")');
    expect(staticRoute).toContain('parts[0] !== "modules"');
    expect(routeSecurity).toContain('isWebClientStaticRoute(routePath, "/app")');
  });

  it("ships a VSCode built-in extension that owns the Hana webview panel", () => {
    const packageJsonPath = path.join(vscodeRoot, "extensions", "openhanako-hana", "package.json");
    const extensionPath = path.join(vscodeRoot, "extensions", "openhanako-hana", "extension.js");

    expect(fs.existsSync(packageJsonPath)).toBe(true);
    expect(fs.existsSync(extensionPath)).toBe(true);

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const extension = fs.readFileSync(extensionPath, "utf8");

    expect(packageJson.name).toBe("openhanako-hana");
    expect(packageJson.main).toBe("./extension.js");
    expect(packageJson.activationEvents).toContain("onStartupFinished");
    expect(packageJson.activationEvents).toContain("onCommand:openhanako.hana.openPanel");
    expect(packageJson.extensionKind).toContain("workspace");
    expect(JSON.stringify(packageJson.contributes.commands)).toContain("openhanako.hana.openPanel");

    expect(extension).toContain("HANA_OPENHANAKO_ROOT");
    expect(extension).toContain("server-info.json");
    expect(extension).toContain("server/bootstrap.ts");
    expect(extension).toContain("createWebviewPanel");
    expect(extension).toContain("retainContextWhenHidden: true");
    expect(extension).toContain("/app?token=");
  });

  it("routes the native Hana workbench action to the built-in Hana panel", () => {
    const contribution = readVscode("src", "vs", "workbench", "contrib", "hana", "browser", "hanaViews.contribution.ts");

    expect(contribution).toContain("openhanako.hana.openPanel");
    expect(contribution).not.toContain("workbench.action.chat.open");
  });

  it("does not fail startup when optional policy-watcher native bindings are missing", () => {
    const nativePolicyService = readVscode("src", "vs", "platform", "policy", "node", "nativePolicyService.ts");
    const copilotManagedSettingsService = readVscode("src", "vs", "platform", "policy", "node", "copilotManagedSettingsService.ts");

    expect(nativePolicyService).toContain("policy-watcher unavailable");
    expect(nativePolicyService).toContain("this.watcher.clear()");
    expect(copilotManagedSettingsService).toContain("policy-watcher unavailable");
    expect(copilotManagedSettingsService).toContain("this.managedSettingsValues.clear()");
  });

  it("does not fail startup when optional Windows native identity and logging bindings are missing", () => {
    const id = readVscode("src", "vs", "base", "node", "id.ts");
    const spdlog = readVscode("src", "vs", "platform", "log", "node", "spdlogLog.ts");
    const nativeHost = readVscode("src", "vs", "platform", "native", "electron-main", "nativeHostMainService.ts");
    const storageMain = readVscode("src", "vs", "platform", "storage", "electron-main", "storageMain.ts");

    expect(id).toContain("windows-registry unavailable");
    expect(id).toContain("return ''");
    expect(id).toContain("deviceid unavailable");
    expect(id).toContain("uuid.generateUuid()");

    expect(spdlog).toContain("spdlog unavailable");
    expect(spdlog).toContain("return null");

    expect(nativeHost).toContain("windows-registry unavailable");
    expect(nativeHost).toContain("return undefined");

    expect(storageMain).toContain("sqlite3 unavailable");
    expect(storageMain).toContain("canUseSQLiteStorage");
    expect(storageMain).toContain("createInMemoryStorage");
  });

  it("keeps chat pane imports from loading the voice contribution twice", () => {
    const chatViewPane = readVscode("src", "vs", "workbench", "contrib", "chat", "browser", "widgetHosts", "viewPane", "chatViewPane.ts");
    const agentsVoiceContribution = readVscode("src", "vs", "workbench", "contrib", "agentsVoice", "browser", "agentsVoice.contribution.ts");
    const agentsVoiceContextKeys = readVscode("src", "vs", "workbench", "contrib", "agentsVoice", "browser", "agentsVoiceContextKeys.ts");

    expect(chatViewPane).not.toContain("agentsVoice.contribution.js");
    expect(chatViewPane).toContain("agentsVoiceContextKeys.js");
    expect(agentsVoiceContribution).toContain("agentsVoiceContextKeys.js");
    expect(agentsVoiceContextKeys).toContain("AGENTS_VOICE_WIDGET_FOCUSED");
  });
});
