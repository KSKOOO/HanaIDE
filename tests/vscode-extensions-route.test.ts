import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVscodeExtensionsRoute } from "../server/routes/vscode-extensions.ts";
import { createVscodeExtensionService } from "../core/vscode-extension-service.ts";

async function createVsixBuffer(manifest: Record<string, any>, mainSource = "") {
  const zip = new JSZip();
  zip.file("extension/package.json", JSON.stringify(manifest));
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

async function writeVsix(targetPath: string) {
  const buffer = await createVsixBuffer({
    publisher: "hana-test",
    name: "route-tools",
    displayName: "Route Tools",
    version: "0.1.0",
    engines: { vscode: "^1.90.0" },
    main: "./extension.js",
    extensionKind: ["workspace"],
    activationEvents: ["onCommand:hana.route"],
    contributes: {
      commands: [{ command: "hana.route", title: "Route Command" }],
    },
  }, `
    const vscode = require('vscode');
    exports.activate = () => vscode.commands.registerCommand('hana.route', () => 'route-ok');
  `);
  fs.writeFileSync(targetPath, buffer);
}

describe("VSCode extensions route", () => {
  let tempRoot: string;
  let app: Hono;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-vscode-route-"));
    app = new Hono();
    app.route("/api", createVscodeExtensionsRoute({ hanakoHome: tempRoot }));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("installs VSIX packages and exposes installed extensions", async () => {
    const vsixPath = path.join(tempRoot, "route-tools.vsix");
    await writeVsix(vsixPath);

    const install = await app.request("/api/vscode-extensions/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: vsixPath }),
    });
    const list = await app.request("/api/vscode-extensions");

    expect(install.status).toBe(200);
    expect(await install.json()).toMatchObject({ id: "hana-test.route-tools", enabled: true });
    expect(await list.json()).toMatchObject({
      extensions: [
        {
          id: "hana-test.route-tools",
          runtime: { hostKind: "node-workspace", supported: true },
          contributions: { commands: [{ command: "hana.route", title: "Route Command" }] },
        },
      ],
    });
  });

  it("installs Marketplace VSIX packages through the gallery install route", async () => {
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
        commands: [{ command: "python.run", title: "Run Python File" }],
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

    app = new Hono();
    app.route("/api", createVscodeExtensionsRoute({
      vscodeExtensionService: createVscodeExtensionService({ hanakoHome: tempRoot, fetchImpl }),
    }));

    const install = await app.request("/api/vscode-extensions/gallery/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ms-python.python" }),
    });

    expect(install.status).toBe(200);
    expect(await install.json()).toMatchObject({
      id: "ms-python.python",
      enabled: true,
      runtime: { hostKind: "node-workspace", supported: true },
      contributions: { commands: [{ command: "python.run", title: "Run Python File" }] },
    });
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
    expect(String((requests[0].init?.headers as Record<string, string>)?.Accept)).not.toContain("excludeUrls");
  });

  it("enables, starts, and invokes installed command extensions", async () => {
    const vsixPath = path.join(tempRoot, "route-tools.vsix");
    await writeVsix(vsixPath);
    await app.request("/api/vscode-extensions/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: vsixPath }),
    });

    const started = await app.request("/api/vscode-extensions/runtime/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath: "D:/hana/workspace" }),
    });
    const invoked = await app.request("/api/vscode-extensions/runtime/commands/hana.route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: [] }),
    });

    expect(await started.json()).toMatchObject({ activated: ["hana-test.route-tools"], failed: [] });
    expect(await invoked.json()).toMatchObject({ ok: true, result: "route-ok" });
  });

  it("resolves installed extension webview views through the runtime route", async () => {
    const vsixPath = path.join(tempRoot, "route-webview.vsix");
    const buffer = await createVsixBuffer({
      publisher: "hana-test",
      name: "route-webview",
      displayName: "Route Webview",
      version: "0.1.0",
      engines: { vscode: "^1.90.0" },
      main: "./extension.js",
      extensionKind: ["workspace"],
      activationEvents: ["onView:hana.routeView"],
      contributes: {
        viewsContainers: {
          activitybar: [{ id: "hana-route", title: "Route View" }],
        },
        views: {
          "hana-route": [{ id: "hana.routeView", name: "Route View" }],
        },
      },
    }, `
      const vscode = require('vscode');
      exports.activate = (context) => {
        context.subscriptions.push(vscode.window.registerWebviewViewProvider('hana.routeView', {
          resolveWebviewView(view) {
            const scriptUri = view.webview.asWebviewUri(vscode.Uri.file(__filename));
            view.webview.html = '<section>route view html<script src="' + scriptUri + '"></script></section>';
          }
        }));
      };
    `);
    fs.writeFileSync(vsixPath, buffer);
    await app.request("/api/vscode-extensions/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: vsixPath }),
    });
    await app.request("/api/vscode-extensions/runtime/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath: "D:/hana/workspace" }),
    });

    const resolved = await app.request("/api/vscode-extensions/runtime/views/hana.routeView", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(resolved.status).toBe(200);
    const payload = await resolved.json();
    expect(payload).toMatchObject({
      ok: true,
      type: "webview",
      viewId: "hana.routeView",
      html: expect.stringContaining("/api/vscode-extensions/runtime/resources/hana-test.route-webview?path="),
    });
    const resourceUrl = /src="([^"]+)"/.exec(payload.html)?.[1];
    expect(resourceUrl).toBeTruthy();
    const resource = await app.request(resourceUrl!);
    expect(resource.status).toBe(200);
    expect(await resource.text()).toContain("registerWebviewViewProvider");
  });

  it("bridges installed extension webview messages through runtime routes", async () => {
    const vsixPath = path.join(tempRoot, "route-webview-message.vsix");
    const buffer = await createVsixBuffer({
      publisher: "hana-test",
      name: "route-webview-message",
      displayName: "Route Webview Message",
      version: "0.1.0",
      engines: { vscode: "^1.90.0" },
      main: "./extension.js",
      extensionKind: ["workspace"],
      activationEvents: ["onView:hana.routeMessages"],
      contributes: {
        viewsContainers: {
          activitybar: [{ id: "hana-route-messages", title: "Route Messages" }],
        },
        views: {
          "hana-route-messages": [{ id: "hana.routeMessages", name: "Route Messages" }],
        },
      },
    }, `
      const vscode = require('vscode');
      exports.activate = (context) => {
        context.subscriptions.push(vscode.window.registerWebviewViewProvider('hana.routeMessages', {
          resolveWebviewView(view) {
            view.webview.html = '<section>route messages</section>';
            view.webview.onDidReceiveMessage((message) => {
              view.webview.postMessage({ kind: 'route-reply', value: message.value });
            });
          }
        }));
      };
    `);
    fs.writeFileSync(vsixPath, buffer);
    await app.request("/api/vscode-extensions/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: vsixPath }),
    });
    await app.request("/api/vscode-extensions/runtime/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath: "D:/hana/workspace" }),
    });
    await app.request("/api/vscode-extensions/runtime/views/hana.routeMessages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const sent = await app.request("/api/vscode-extensions/runtime/views/hana.routeMessages/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { value: "ping" } }),
    });
    const messages = await app.request("/api/vscode-extensions/runtime/views/hana.routeMessages/messages?after=0");

    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ ok: true, viewId: "hana.routeMessages" });
    expect(await messages.json()).toEqual({
      ok: true,
      viewId: "hana.routeMessages",
      messages: [
        { id: 1, message: { kind: "route-reply", value: "ping" } },
      ],
    });
  });

  it("toggles extension enablement", async () => {
    const vsixPath = path.join(tempRoot, "route-tools.vsix");
    await writeVsix(vsixPath);
    await app.request("/api/vscode-extensions/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: vsixPath }),
    });

    const disabled = await app.request("/api/vscode-extensions/hana-test.route-tools/enabled", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(await disabled.json()).toMatchObject({ ok: true, id: "hana-test.route-tools", enabled: false });
    expect((await (await app.request("/api/vscode-extensions")).json()).extensions[0].enabled).toBe(false);
  });

  it("uninstalls installed extensions through the route", async () => {
    const vsixPath = path.join(tempRoot, "route-tools.vsix");
    await writeVsix(vsixPath);
    await app.request("/api/vscode-extensions/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: vsixPath }),
    });

    const removed = await app.request("/api/vscode-extensions/hana-test.route-tools", {
      method: "DELETE",
    });
    const list = await app.request("/api/vscode-extensions");

    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, id: "hana-test.route-tools", uninstalled: true });
    expect((await list.json()).extensions).toEqual([]);
  });
});
