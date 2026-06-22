import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVscodeExtensionService } from "../core/vscode-extension-service.ts";

async function createVsixBuffer(manifest: Record<string, any>, mainSource = "") {
  const zip = new JSZip();
  zip.file("extension/package.json", JSON.stringify(manifest, null, 2));
  if (mainSource) {
    const mainPath = String(manifest.main || "./extension.js").replace(/^\.\//, "");
    zip.file(`extension/${mainPath}`, mainSource);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(out).set(buffer);
  return out;
}

async function writeVsix(targetPath: string, manifest: Record<string, any>, mainSource = "") {
  const buffer = await createVsixBuffer(manifest, mainSource);
  fs.writeFileSync(targetPath, buffer);
}

describe("VSCode extension compatibility service", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-vscode-ext-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("installs a VSIX, scans its manifest, and persists enablement", async () => {
    const vsixPath = path.join(tempRoot, "hana-tools.vsix");
    await writeVsix(vsixPath, {
      publisher: "hana-test",
      name: "sample-tools",
      displayName: "Hana Sample Tools",
      version: "1.2.3",
      engines: { vscode: "^1.90.0" },
      main: "./dist/extension.js",
      extensionKind: ["workspace"],
      activationEvents: ["onCommand:hana.sample"],
      contributes: {
        commands: [
          { command: "hana.sample", title: "Sample Command", category: "Hana" },
        ],
        viewsContainers: {
          activitybar: [
            { id: "hana-sample", title: "Hana Sample", icon: "$(beaker)" },
          ],
        },
        views: {
          "hana-sample": [
            { id: "hana.sampleView", name: "Sample View" },
          ],
        },
        languages: [
          { id: "hana-md", extensions: [".hana.md"] },
        ],
      },
    }, "exports.activate = () => undefined;\n");

    const service = createVscodeExtensionService({ hanakoHome: tempRoot });
    const installed = await service.installFromPath(vsixPath);

    expect(installed).toMatchObject({
      id: "hana-test.sample-tools",
      publisher: "hana-test",
      name: "sample-tools",
      version: "1.2.3",
      enabled: true,
      runtime: { hostKind: "node-workspace", supported: true },
    });
    expect(installed.contributions.commands).toEqual([
      { command: "hana.sample", title: "Sample Command", category: "Hana" },
    ]);
    expect(installed.contributions.viewsContainers).toEqual({
      activitybar: [
        { id: "hana-sample", title: "Hana Sample", icon: "$(beaker)" },
      ],
    });
    expect(installed.contributions.views).toEqual({
      "hana-sample": [
        { id: "hana.sampleView", name: "Sample View" },
      ],
    });

    await service.setEnabled("hana-test.sample-tools", false);
    expect((await service.listExtensions()).extensions[0]).toMatchObject({
      id: "hana-test.sample-tools",
      enabled: false,
    });
  });

  it("uninstalls installed extensions and clears enablement state", async () => {
    const vsixPath = path.join(tempRoot, "hana-tools.vsix");
    await writeVsix(vsixPath, {
      publisher: "hana-test",
      name: "sample-tools",
      displayName: "Hana Sample Tools",
      version: "1.2.3",
      engines: { vscode: "^1.90.0" },
      main: "./extension.js",
      extensionKind: ["workspace"],
    }, "exports.activate = () => undefined;\n");

    const service = createVscodeExtensionService({ hanakoHome: tempRoot });
    const installed = await service.installFromPath(vsixPath);
    await service.setEnabled(installed.id, false);

    const result = await (service as any).uninstallExtension(installed.id);

    expect(result).toEqual({ ok: true, id: "hana-test.sample-tools", uninstalled: true });
    expect((await service.listExtensions()).extensions).toEqual([]);
    expect(fs.existsSync(installed.installedPath)).toBe(false);
    const disabledPath = path.join(tempRoot, "vscode-extensions", "disabled.json");
    expect(JSON.parse(fs.readFileSync(disabledPath, "utf8"))).toEqual({ disabled: [] });
  });

  it("activates simple Node/workspace command extensions through a VSCode API shim", async () => {
    const vsixPath = path.join(tempRoot, "command-tools.vsix");
    await writeVsix(vsixPath, {
      publisher: "hana-test",
      name: "command-tools",
      displayName: "Command Tools",
      version: "0.1.0",
      engines: { vscode: "^1.90.0" },
      main: "./extension.js",
      extensionKind: ["workspace"],
      activationEvents: ["onCommand:hana.echoWorkspace"],
      contributes: {
        commands: [
          { command: "hana.echoWorkspace", title: "Echo Workspace" },
        ],
      },
    }, `
      const vscode = require('vscode');
      exports.activate = (context) => {
        context.subscriptions.push(vscode.commands.registerCommand('hana.echoWorkspace', () => {
          return vscode.workspace.workspaceFolders[0].uri.fsPath;
        }));
      };
    `);

    const service = createVscodeExtensionService({ hanakoHome: tempRoot });
    await service.installFromPath(vsixPath);
    const activation = await service.activateInstalledExtensions({ workspacePath: "D:/hana/workspace" });
    const result = await service.executeCommand("hana.echoWorkspace");

    expect(activation).toMatchObject({ activated: ["hana-test.command-tools"], failed: [] });
    expect(service.listRuntimeCommands()).toEqual([
      { command: "hana.echoWorkspace", extensionId: "hana-test.command-tools", title: "Echo Workspace" },
    ]);
    expect(result).toEqual({ ok: true, command: "hana.echoWorkspace", result: "D:/hana/workspace" });
  });

  it("resolves contributed webview views registered by workspace extensions", async () => {
    const vsixPath = path.join(tempRoot, "webview-tools.vsix");
    await writeVsix(vsixPath, {
      publisher: "hana-test",
      name: "webview-tools",
      displayName: "Webview Tools",
      version: "0.1.0",
      engines: { vscode: "^1.90.0" },
      main: "./extension.js",
      extensionKind: ["workspace"],
      activationEvents: ["onView:hana.webview"],
      contributes: {
        viewsContainers: {
          activitybar: [{ id: "hana-webview", title: "Hana Webview" }],
        },
        views: {
          "hana-webview": [{ id: "hana.webview", name: "Hana Webview" }],
        },
      },
    }, `
      const vscode = require('vscode');
      exports.activate = (context) => {
        context.subscriptions.push(vscode.window.registerWebviewViewProvider('hana.webview', {
          resolveWebviewView(view) {
            view.title = 'Resolved Hana Webview';
            view.webview.options = { enableScripts: true };
            const scriptUri = view.webview.asWebviewUri(vscode.Uri.file(__filename));
            view.webview.html = '<main><h1>Resolved from extension host</h1><script src="' + scriptUri + '"></script></main>';
          }
        }));
      };
    `);

    const service = createVscodeExtensionService({ hanakoHome: tempRoot });
    await service.installFromPath(vsixPath);
    await service.activateInstalledExtensions({ workspacePath: "D:/hana/workspace" });

    const resolved = await service.resolveRuntimeView("hana.webview");

    expect(resolved).toMatchObject({
      ok: true,
      type: "webview",
      viewId: "hana.webview",
      title: "Resolved Hana Webview",
      html: expect.stringContaining("/api/vscode-extensions/runtime/resources/hana-test.webview-tools?path="),
      options: { enableScripts: true },
    });
  });

  it("bridges webview messages between the UI frame and extension host", async () => {
    const vsixPath = path.join(tempRoot, "webview-messages.vsix");
    await writeVsix(vsixPath, {
      publisher: "hana-test",
      name: "webview-messages",
      displayName: "Webview Messages",
      version: "0.1.0",
      engines: { vscode: "^1.90.0" },
      main: "./extension.js",
      extensionKind: ["workspace"],
      activationEvents: ["onView:hana.messages"],
      contributes: {
        viewsContainers: {
          activitybar: [{ id: "hana-message-container", title: "Messages" }],
        },
        views: {
          "hana-message-container": [{ id: "hana.messages", name: "Messages" }],
        },
      },
    }, `
      const vscode = require('vscode');
      exports.activate = (context) => {
        context.subscriptions.push(vscode.window.registerWebviewViewProvider('hana.messages', {
          resolveWebviewView(view) {
            view.webview.html = '<main>messages</main>';
            view.webview.onDidReceiveMessage((message) => {
              view.webview.postMessage({ kind: 'reply', value: message.value });
            });
          }
        }));
      };
    `);

    const service = createVscodeExtensionService({ hanakoHome: tempRoot });
    await service.installFromPath(vsixPath);
    await service.activateInstalledExtensions({ workspacePath: "D:/hana/workspace" });
    await service.resolveRuntimeView("hana.messages");

    const sent = await (service as any).postRuntimeViewMessage("hana.messages", { value: "ping" });
    const messages = await (service as any).readRuntimeViewMessages("hana.messages", 0);

    expect(sent).toEqual({ ok: true, viewId: "hana.messages" });
    expect(messages).toEqual({
      ok: true,
      viewId: "hana.messages",
      messages: [
        { id: 1, message: { kind: "reply", value: "ping" } },
      ],
    });
  });

  it("activates Codex-style extensions that depend on core VSCode workbench shims", async () => {
    const vsixPath = path.join(tempRoot, "codex-style.vsix");
    await writeVsix(vsixPath, {
      publisher: "hana-test",
      name: "codex-style",
      displayName: "Codex Style",
      version: "0.1.0",
      engines: { vscode: "^1.96.0" },
      main: "./extension.js",
      extensionKind: ["workspace"],
      activationEvents: ["onStartupFinished", "onUri"],
      contributes: {
        commands: [
          { command: "hana.codexStyle", title: "Codex Style" },
        ],
        viewsContainers: {
          activitybar: [{ id: "hana-codex-style", title: "Codex Style" }],
        },
        views: {
          "hana-codex-style": [{ id: "hana.codexStyleView", type: "webview", name: "Codex Style" }],
        },
      },
    }, `
      const vscode = require('vscode');
      exports.activate = (context) => {
        context.subscriptions.push(vscode.window.registerUriHandler({ handleUri() {} }));
        context.subscriptions.push(vscode.window.onDidChangeWindowState(() => {}));
        context.subscriptions.push(vscode.window.registerCustomEditorProvider('hana.codexEditor', {}));
        context.subscriptions.push(vscode.languages.registerCodeLensProvider([{ scheme: 'file' }], { provideCodeLenses: () => [] }));
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(() => {}));
        context.subscriptions.push(vscode.commands.registerCommand('hana.codexStyle', async () => {
          await vscode.commands.executeCommand('setContext', 'hana.codexStyle.ready', true);
          await vscode.env.clipboard.writeText('ready');
          return vscode.workspace.asRelativePath(vscode.workspace.workspaceFolders[0].uri.fsPath + '/README.md');
        }));
        context.subscriptions.push(vscode.window.registerWebviewViewProvider('hana.codexStyleView', {
          resolveWebviewView(view) {
            view.webview.html = '<main>codex style</main>';
          }
        }));
      };
    `);

    const service = createVscodeExtensionService({ hanakoHome: tempRoot });
    await service.installFromPath(vsixPath);
    const activation = await service.activateInstalledExtensions({ workspacePath: "D:/hana/workspace" });
    const command = await service.executeCommand("hana.codexStyle");
    const resolved = await service.resolveRuntimeView("hana.codexStyleView");

    expect(activation).toMatchObject({ activated: ["hana-test.codex-style"], failed: [] });
    expect(command).toMatchObject({ ok: true, result: "README.md" });
    expect(resolved).toMatchObject({ ok: true, type: "webview", html: "<main>codex style</main>" });
  });

  it("searches the VSCode Marketplace extensionquery endpoint and maps VSIX results", async () => {
    let requested: { url: string; init?: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requested = { url: String(url), init };
      return new Response(JSON.stringify({
        results: [
          {
            extensions: [
              {
                publisher: { publisherName: "ms-python" },
                extensionName: "python",
                displayName: "Python",
                shortDescription: "Python language support",
                versions: [
                  {
                    version: "2026.1.0",
                    files: [
                      {
                        assetType: "Microsoft.VisualStudio.Services.VSIXPackage",
                        source: "https://example.invalid/ms-python.python.vsix",
                      },
                    ],
                  },
                ],
                statistics: [
                  { statisticName: "install", value: 1000 },
                  { statisticName: "averagerating", value: 4.5 },
                ],
              },
            ],
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const service = createVscodeExtensionService({ hanakoHome: tempRoot, fetchImpl });

    const result = await service.searchGallery("py", 1);

    expect(requested?.url).toBe("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery");
    expect(JSON.parse(String(requested?.init?.body))).toMatchObject({
      filters: [
        {
          criteria: [{ filterType: 10, value: "py" }],
          pageNumber: 1,
          pageSize: 1,
        },
      ],
    });
    expect(result.results).toEqual([
      {
        id: "ms-python.python",
        publisher: "ms-python",
        name: "python",
        displayName: "Python",
        shortDescription: "Python language support",
        version: "2026.1.0",
        installCount: 1000,
        rating: 4.5,
        itemUrl: "https://marketplace.visualstudio.com/items?itemName=ms-python.python",
        vsixUrl: "https://example.invalid/ms-python.python.vsix",
      },
    ]);
  });

  it("installs Marketplace extensions by exact VSCode extension id", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const vsixBuffer = await createVsixBuffer({
      publisher: "ms-python",
      name: "python",
      displayName: "Python",
      version: "2026.1.0",
      engines: { vscode: "^1.90.0" },
      main: "./extension.js",
      extensionKind: ["workspace"],
      contributes: {
        commands: [
          { command: "python.run", title: "Run Python File" },
        ],
      },
    }, "exports.activate = () => undefined;\n");
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/extensionquery")) {
        return new Response(JSON.stringify({
          results: [
            {
              extensions: [
                {
                  publisher: { publisherName: "ms-python" },
                  extensionName: "python",
                  displayName: "Python",
                  shortDescription: "Python language support",
                  versions: [
                    {
                      version: "2026.1.0",
                      files: [
                        {
                          assetType: "Microsoft.VisualStudio.Services.VSIXPackage",
                          source: "https://example.invalid/ms-python.python.vsix",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url) === "https://example.invalid/ms-python.python.vsix") {
        return new Response(toArrayBuffer(vsixBuffer), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const service = createVscodeExtensionService({ hanakoHome: tempRoot, fetchImpl });

    const installed = await service.installFromGallery("ms-python.python");

    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({
      filters: [
        {
          criteria: [{ filterType: 7, value: "ms-python.python" }],
          pageNumber: 1,
          pageSize: 1,
        },
      ],
    });
    expect(requests[1].url).toBe("https://example.invalid/ms-python.python.vsix");
    expect(installed).toMatchObject({
      id: "ms-python.python",
      enabled: true,
      runtime: { hostKind: "node-workspace", supported: true },
      contributions: { commands: [{ command: "python.run", title: "Run Python File" }] },
    });
  });
});
