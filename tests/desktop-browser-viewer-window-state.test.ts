import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const MAIN_PATH = path.join(process.cwd(), "desktop", "main.cjs");

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const bodyStart = source.indexOf(") {", start) + 2;
  expect(bodyStart).toBeGreaterThan(1);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(bodyStart + 1, i);
  }
  throw new Error(`unterminated function ${name}`);
}

describe("desktop browser viewer window state", () => {
  it("does not wake secondary windows when showing the primary window", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "showPrimaryWindow");

    expect(body).toContain("focusExistingWindow(win)");
    expect(body).not.toContain("browserViewerWindow.show()");
    expect(body).not.toContain("settingsWindow.show()");
    expect(body).not.toContain("_viewerWindows");
  });

  it("hides the browser viewer when the active browser view is detached", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "_detachActiveBrowserView");

    expect(body).toContain("contentView.removeChildView(view)");
    expect(body).toContain("_browserWebView = null");
    expect(body).toContain("_currentBrowserSession = null");
    expect(body).toContain("webContents.send(HANA_IPC_EVENTS.browserUpdate");
    expect(body).toContain("browserViewerWindow.hide()");
  });

  it("opens the browser viewer at the wider default size", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "createBrowserViewerWindow");

    expect(body).toContain("width: 1440");
    expect(body).toContain("height: 1080");
  });

  it("models browser views as session tab workspaces", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain("sessionPath -> BrowserWorkspace");
    expect(source).toContain("tabId -> WebContentsView");
    expect(source).toContain("function _ensureBrowserTabForSession");
    expect(source).toContain("function _switchActiveBrowserTab");
  });

  it("exposes tab and Cookie browser IPC commands", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain("wrapIpcBestEffortHandler(HANA_IPC_CHANNELS.browserNewTab");
    expect(source).toContain("wrapIpcBestEffortHandler(HANA_IPC_CHANNELS.browserSwitchTab");
    expect(source).toContain("wrapIpcBestEffortHandler(HANA_IPC_CHANNELS.browserCloseTab");
    expect(source).toContain('case "setAcceptCookies"');
    expect(source).toContain('case "clearBrowserCookiesAndSiteData"');
  });

  it("routes new-window requests into a new in-app browser tab", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "_createBrowserWebContentsView");

    expect(body).toContain("_openUrlInNewBrowserTab");
    expect(body).toContain("{ show: view === _browserWebView }");
    expect(body).not.toContain("view.webContents.loadURL(url);");
    expect(body).toContain('return { action: "deny" }');
  });

  it("cleans up tab workspaces and keeps emergency stop on the detach helper", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain('case "close"');
    expect(source).toContain('for (const tab of workspace.tabs.values())');
    expect(source).toContain('_detachActiveBrowserView({ view: active.view');
    expect(source).toContain('_detachActiveBrowserView({ view, sessionPath: sp || _currentBrowserSession, hideIfVisible: true })');
    expect(source).toContain('case "destroyView"');
    expect(source).toContain('_detachActiveBrowserView({ destroy: true, hideIfVisible: true, reason: "emergency-stop" })');
  });
});
