import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const vscodeRoot = "D:/hanaide/vscode-1.125.0";
const hasVscodeFork = fs.existsSync(path.join(vscodeRoot, "product.json"));
const read = (...parts: string[]) => fs.readFileSync(path.join(vscodeRoot, ...parts), "utf8");

describe.skipIf(!hasVscodeFork)("VSCode deep fork coding mode", () => {
  it("brands product.json as the OpenHanako coding shell with VSCode gallery enabled", () => {
    const product = JSON.parse(read("product.json"));

    expect(product.nameShort).toBe("OpenHanako Code");
    expect(product.applicationName).toBe("openhanako-code");
    expect(product.dataFolderName).toBe(".openhanako-code");
    expect(product.extensionsGallery?.serviceUrl).toBe("https://marketplace.visualstudio.com/_apis/public/gallery");
    expect(product.extensionsGallery?.itemUrl).toBe("https://marketplace.visualstudio.com/items");
    expect(product.builtInExtensionsEnabledWithAutoUpdates).toEqual([]);
    expect(product.updateUrl).toBeUndefined();
  });

  it("registers OpenHanako coding defaults with background updates disabled", () => {
    const defaults = read("src", "vs", "workbench", "contrib", "hana", "browser", "hanaDefaults.contribution.ts");

    expect(defaults).toContain("'update.mode': 'none'");
    expect(defaults).toContain("'extensions.autoUpdate': 'off'");
    expect(defaults).toContain("'extensions.autoCheckUpdates': false");
    expect(defaults).toContain("registerDefaultConfigurations");
  });

  it("registers Hana workbench views and imports them in desktop workbench startup", () => {
    const views = read("src", "vs", "workbench", "contrib", "hana", "browser", "hanaViews.contribution.ts");
    const desktopMain = read("src", "vs", "workbench", "workbench.desktop.main.ts");

    expect(views).toContain("openhanako.hana");
    expect(views).toContain("openhanako.hana.chat");
    expect(views).toContain("ViewContainerLocation.Sidebar");
    expect(views).toContain("OPENHANAKO_OPEN_EXTENSIONS_COMMAND_ID");
    expect(views).toContain("OPENHANAKO_INSTALL_VSIX_COMMAND_ID");
    expect(views).toContain("OPENHANAKO_NEW_TERMINAL_COMMAND_ID");
    expect(views).toContain("OPENHANAKO_OPEN_COMMANDS_COMMAND_ID");
    expect(views).toContain("OPENHANAKO_OPEN_CHAT_COMMAND_ID");
    expect(views).toContain("workbench.extensions.search");
    expect(views).toContain("workbench.extensions.action.installVSIX");
    expect(views).toContain("workbench.action.terminal.new");
    expect(views).toContain("workbench.action.showCommands");
    expect(views).toContain("openhanako.hana.openPanel");
    expect(views).toContain("ButtonBar");
    expect(desktopMain).toContain("./contrib/hana/browser/hanaDefaults.contribution.js");
    expect(desktopMain).toContain("./contrib/hana/browser/hanaViews.contribution.js");
  });

  it("uses a distinct command id for the Hana view open action", () => {
    const views = read("src", "vs", "workbench", "contrib", "hana", "browser", "hanaViews.contribution.ts");

    expect(views).toContain("OPENHANAKO_FOCUS_HANA_VIEW_COMMAND_ID");
    expect(views).toContain("openhanako.hana.focus");
    expect(views).not.toMatch(/openCommandActionDescriptor:\s*{\s*id:\s*HANA_VIEW_CONTAINER_ID/);
  });

  it("provides an OpenHanako coding theme adapter for VSCode color tokens", () => {
    const theme = read("src", "vs", "workbench", "contrib", "hana", "browser", "hanaTheme.contribution.ts");
    const desktopMain = read("src", "vs", "workbench", "workbench.desktop.main.ts");

    expect(theme).toContain("OPENHANAKO_THEME_COLOR_CUSTOMIZATIONS");
    expect(theme).toContain("\"editor.background\"");
    expect(theme).toContain("\"sideBar.background\"");
    expect(theme).toContain("\"statusBar.background\"");
    expect(theme).toContain("\"activityBar.activeBorder\"");
    expect(theme).toContain("'workbench.colorCustomizations'");
    expect(desktopMain).toContain("./contrib/hana/browser/hanaTheme.contribution.js");
  });

  it("reuses the bundled OpenHanako Electron runtime instead of downloading on every launch", () => {
    const main = fs.readFileSync(path.join("D:/hanaide/openhanako-0.332.6", "desktop", "main.cjs"), "utf8");
    const preLaunch = read("build", "lib", "preLaunch.ts");
    const electron = read("build", "lib", "electron.ts");

    expect(main).toContain("HANA_ELECTRON_DIST");
    expect(main).toContain("node_modules");
    expect(main).toContain("electron");
    expect(main).toContain("dist");

    expect(preLaunch).toContain("hasElectronRuntime");
    expect(preLaunch).toContain("OpenHanako Code.exe");
    expect(preLaunch).toContain("Skipping Electron download");

    expect(electron).toContain("HANA_ELECTRON_DIST");
    expect(electron).toContain("copyLocalElectronDist");
    expect(electron).toContain("electron.exe");
    expect(electron).toContain("product.nameShort");
  });
});
