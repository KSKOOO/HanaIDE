import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { createRequire } from "node:module";
import { extractZip } from "../lib/extract-zip.ts";

const EXTENSIONS_DIR = "vscode-extensions";
const DISABLED_FILE = "disabled.json";
const DEFAULT_GALLERY_SERVICE_URL = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const DEFAULT_GALLERY_ITEM_URL = "https://marketplace.visualstudio.com/items";
const VSIX_ASSET_TYPE = "Microsoft.VisualStudio.Services.VSIXPackage";
const GALLERY_FLAGS = 1 | 2 | 4 | 16 | 128 | 256 | 512;
const GALLERY_FILTER_EXTENSION_NAME = 7;
const GALLERY_FILTER_SEARCH_TEXT = 10;

type JsonRecord = Record<string, any>;

export interface VscodeExtensionServiceOptions {
  hanakoHome?: string;
  fetchImpl?: typeof fetch;
  gallery?: {
    serviceUrl?: string;
    itemUrl?: string;
  };
}

export interface VscodeExtensionRuntimeOptions {
  workspacePath?: string;
}

interface RuntimeWebviewState {
  viewId: string;
  extensionId: string;
  html: string;
  options: any;
  title: string;
  description: string;
  badge: any;
  messageEmitter: ReturnType<typeof createEmitter>;
  disposeEmitter: ReturnType<typeof createEmitter>;
  visibilityEmitter: ReturnType<typeof createEmitter>;
  outgoingMessages: Array<{ id: number; message: any }>;
  nextMessageId: number;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^\.+/, "") || "extension";
}

function readJsonFile(filePath: string): JsonRecord {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function httpError(message: string, status: number) {
  const err: any = new Error(message);
  err.status = status;
  return err;
}

function assertInsideDir(candidate: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes extension directory: ${candidate}`);
  }
}

function toExtensionId(manifest: JsonRecord): string {
  const publisher = nonEmptyString(manifest.publisher) || "unknown";
  const name = nonEmptyString(manifest.name);
  if (!name) throw new Error("VSCode extension package.json is missing name");
  return `${publisher}.${name}`.toLowerCase();
}

function findManifestRoot(extractedRoot: string): string {
  const direct = path.join(extractedRoot, "package.json");
  if (fs.existsSync(direct)) return extractedRoot;

  const vscodeRoot = path.join(extractedRoot, "extension", "package.json");
  if (fs.existsSync(vscodeRoot)) return path.join(extractedRoot, "extension");

  const children = fs.readdirSync(extractedRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(extractedRoot, entry.name));
  if (children.length === 1 && fs.existsSync(path.join(children[0], "package.json"))) {
    return children[0];
  }

  throw new Error("VSIX package does not contain extension/package.json");
}

function normalizeCommands(manifest: JsonRecord) {
  const commands = Array.isArray(manifest?.contributes?.commands) ? manifest.contributes.commands : [];
  return commands
    .filter((command: any) => nonEmptyString(command?.command))
    .map((command: any) => ({
      command: nonEmptyString(command.command),
      title: nonEmptyString(command.title) || nonEmptyString(command.command),
      ...(nonEmptyString(command.category) ? { category: nonEmptyString(command.category) } : {}),
    }));
}

function normalizeViewsContainers(manifest: JsonRecord) {
  const containers = manifest?.contributes?.viewsContainers;
  if (!containers || typeof containers !== "object") return {};
  return Object.fromEntries(
    Object.entries(containers)
      .map(([location, value]) => [
        location,
        normalizeArray(value)
          .filter((container: any) => nonEmptyString(container?.id))
          .map((container: any) => ({
            id: nonEmptyString(container.id),
            title: nonEmptyString(container.title) || nonEmptyString(container.id),
            ...(nonEmptyString(container.icon) ? { icon: nonEmptyString(container.icon) } : {}),
          })),
      ])
      .filter(([, value]) => (value as any[]).length > 0),
  );
}

function normalizeViews(manifest: JsonRecord) {
  const views = manifest?.contributes?.views;
  if (!views || typeof views !== "object") return {};
  return Object.fromEntries(
    Object.entries(views)
      .map(([containerId, value]) => [
        containerId,
        normalizeArray(value)
          .filter((view: any) => nonEmptyString(view?.id))
          .map((view: any) => ({
            id: nonEmptyString(view.id),
            name: nonEmptyString(view.name) || nonEmptyString(view.id),
            ...(nonEmptyString(view.when) ? { when: nonEmptyString(view.when) } : {}),
          })),
      ])
      .filter(([, value]) => (value as any[]).length > 0),
  );
}

function normalizeArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function inferRuntime(manifest: JsonRecord) {
  const kinds = normalizeArray(manifest.extensionKind).map(kind => String(kind));
  const hasBrowserMain = !!nonEmptyString(manifest.browser);
  const hasNodeMain = !!nonEmptyString(manifest.main);
  const isWorkspace = kinds.length === 0
    || kinds.includes("workspace")
    || (!kinds.includes("ui") && !hasBrowserMain);
  const hostKind = hasNodeMain && isWorkspace ? "node-workspace" : hasBrowserMain ? "web-ui" : "manifest-only";
  return {
    hostKind,
    supported: hostKind === "node-workspace",
    reason: hostKind === "node-workspace" ? null : "Only Node/workspace VSCode extensions are executable in HanaIDE Coding Mode.",
  };
}

function createFileUri(fsPath: string) {
  return {
    scheme: "file",
    fsPath,
    path: fsPath.replace(/\\/g, "/"),
    toString() {
      const normalized = fsPath.replace(/\\/g, "/");
      return `file://${normalized.startsWith("/") ? "" : "/"}${normalized}`;
    },
  };
}

function fsPathFromUri(value: any): string {
  if (typeof value === "string") return value.replace(/^file:\/\/\/?/, "");
  if (nonEmptyString(value?.fsPath)) return nonEmptyString(value.fsPath);
  if (nonEmptyString(value?.scheme) === "file") {
    const uriPath = nonEmptyString(value.path);
    return /^\/[A-Za-z]:\//.test(uriPath) ? uriPath.slice(1) : uriPath;
  }
  return nonEmptyString(value?.path);
}

function createDisposable(dispose: () => void = () => undefined) {
  return { dispose };
}

function createMemento() {
  const values = new Map<string, any>();
  return {
    get(key: string, fallback?: any) {
      return values.has(key) ? values.get(key) : fallback;
    },
    update(key: string, value: any) {
      values.set(key, value);
      return Promise.resolve();
    },
    keys() {
      return Array.from(values.keys());
    },
  };
}

function createNoopEvent() {
  return (_listener: any, _thisArg?: any, disposables?: any[]) => {
    const disposable = { dispose: () => undefined };
    if (Array.isArray(disposables)) disposables.push(disposable);
    return disposable;
  };
}

function createEmitter() {
  const listeners = new Set<(...args: any[]) => void>();
  return {
    event(listener: (...args: any[]) => void, thisArg?: any, disposables?: any[]) {
      const wrapped = thisArg ? listener.bind(thisArg) : listener;
      listeners.add(wrapped);
      const disposable = { dispose: () => listeners.delete(wrapped) };
      if (Array.isArray(disposables)) disposables.push(disposable);
      return disposable;
    },
    fire(value?: any) {
      for (const listener of Array.from(listeners)) listener(value);
    },
    dispose() {
      listeners.clear();
    },
  };
}

function cancellationTokenNone() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: createNoopEvent(),
  };
}

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8";
  if (ext === ".json" || ext === ".map") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".woff") return "font/woff";
  if (ext === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

export class VscodeExtensionService {
  readonly hanakoHome: string;
  readonly extensionsDir: string;
  private readonly disabledFile: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly galleryServiceUrl: string;
  private readonly galleryItemUrl: string;
  private readonly activatedExtensions = new Map<string, { subscriptions: any[] }>();
  private readonly commands = new Map<string, { command: string; title: string; extensionId: string; callback: (...args: any[]) => any }>();
  private readonly webviewViewProviders = new Map<string, { viewId: string; extensionId: string; provider: any; options?: any }>();
  private readonly treeDataProviders = new Map<string, { viewId: string; extensionId: string; provider: any }>();
  private readonly resolvedWebviews = new Map<string, RuntimeWebviewState>();
  private readonly contextValues = new Map<string, any>();
  private clipboardText = "";

  constructor(options: VscodeExtensionServiceOptions = {}) {
    this.hanakoHome = path.resolve(options.hanakoHome || process.env.HANA_HOME || path.join(os.homedir(), ".hanako"));
    this.extensionsDir = path.join(this.hanakoHome, EXTENSIONS_DIR);
    this.disabledFile = path.join(this.extensionsDir, DISABLED_FILE);
    this.fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
    this.galleryServiceUrl = options.gallery?.serviceUrl || DEFAULT_GALLERY_SERVICE_URL;
    this.galleryItemUrl = options.gallery?.itemUrl || DEFAULT_GALLERY_ITEM_URL;
    ensureDir(this.extensionsDir);
  }

  async listExtensions() {
    ensureDir(this.extensionsDir);
    const disabled = this.readDisabledSet();
    const extensions = fs.readdirSync(this.extensionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
      .map(entry => this.readInstalledExtension(path.join(this.extensionsDir, entry.name), disabled))
      .filter(Boolean)
      .sort((a: any, b: any) => a.id.localeCompare(b.id));
    return {
      extensions,
      extensionsDir: this.extensionsDir,
      runtimeCommands: this.listRuntimeCommands(),
    };
  }

  async installFromPath(sourcePath: string) {
    const resolvedSource = path.resolve(sourcePath);
    const stat = fs.statSync(resolvedSource);
    ensureDir(this.extensionsDir);

    let cleanupRoot: string | null = null;
    let sourceRoot = resolvedSource;
    if (stat.isFile()) {
      cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-vsix-"));
      await extractZip(resolvedSource, cleanupRoot);
      sourceRoot = findManifestRoot(cleanupRoot);
    } else if (stat.isDirectory()) {
      sourceRoot = findManifestRoot(resolvedSource);
    } else {
      throw new Error("extension source must be a VSIX file or directory");
    }

    try {
      const manifest = readJsonFile(path.join(sourceRoot, "package.json"));
      const id = toExtensionId(manifest);
      const targetDir = path.join(this.extensionsDir, safePathSegment(id));
      const tempTarget = path.join(this.extensionsDir, `.installing-${safePathSegment(id)}-${Date.now()}`);
      fs.cpSync(sourceRoot, tempTarget, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(tempTarget, targetDir);
      const disabled = this.readDisabledSet();
      disabled.delete(id);
      this.writeDisabledSet(disabled);
      return this.readInstalledExtension(targetDir, disabled);
    } finally {
      if (cleanupRoot) fs.rmSync(cleanupRoot, { recursive: true, force: true });
    }
  }

  async setEnabled(id: string, enabled: boolean) {
    const normalizedId = id.toLowerCase();
    const disabled = this.readDisabledSet();
    if (enabled) disabled.delete(normalizedId);
    else {
      disabled.add(normalizedId);
      this.deactivateExtension(normalizedId);
    }
    this.writeDisabledSet(disabled);
    return { ok: true, id: normalizedId, enabled: !disabled.has(normalizedId) };
  }

  async uninstallExtension(id: string) {
    const normalizedId = nonEmptyString(id).toLowerCase();
    if (!normalizedId) throw httpError("id is required", 400);
    const list = await this.listExtensions();
    const extension = list.extensions.find((item: any) => item.id === normalizedId);
    if (!extension) throw httpError(`extension not found: ${normalizedId}`, 404);
    this.deactivateExtension(normalizedId);
    const targetDir = path.resolve(extension.installedPath);
    assertInsideDir(targetDir, this.extensionsDir);
    fs.rmSync(targetDir, { recursive: true, force: true });
    const disabled = this.readDisabledSet();
    disabled.delete(normalizedId);
    this.writeDisabledSet(disabled);
    return { ok: true, id: normalizedId, uninstalled: true };
  }

  async activateInstalledExtensions(options: VscodeExtensionRuntimeOptions = {}) {
    const list = await this.listExtensions();
    const activated: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const extension of list.extensions) {
      if (!extension.enabled || !extension.runtime?.supported) continue;
      try {
        await this.activateExtension(extension, options);
        activated.push(extension.id);
      } catch (err: any) {
        failed.push({ id: extension.id, error: err?.message || String(err) });
      }
    }
    return {
      activated,
      failed,
      commands: this.listRuntimeCommands(),
    };
  }

  listRuntimeCommands() {
    return Array.from(this.commands.values())
      .map(command => ({
        command: command.command,
        title: command.title,
        extensionId: command.extensionId,
      }))
      .sort((a, b) => a.command.localeCompare(b.command));
  }

  async executeCommand(command: string, args: any[] = []) {
    const registered = this.commands.get(command);
    if (!registered && command.startsWith("workbench.view.extension.")) {
      const containerId = command.slice("workbench.view.extension.".length);
      return { ok: true, command, result: { viewContainer: containerId } };
    }
    if (!registered) {
      return { ok: false, command, error: "command not found" };
    }
    const result = await Promise.resolve(registered.callback(...args));
    return { ok: true, command, result };
  }

  listRuntimeViews() {
    const webviews = Array.from(this.webviewViewProviders.values()).map(provider => ({
      viewId: provider.viewId,
      extensionId: provider.extensionId,
      type: "webview",
    }));
    const trees = Array.from(this.treeDataProviders.values()).map(provider => ({
      viewId: provider.viewId,
      extensionId: provider.extensionId,
      type: "tree",
    }));
    return [...webviews, ...trees].sort((a, b) => a.viewId.localeCompare(b.viewId));
  }

  async resolveRuntimeView(viewId: string) {
    const normalizedViewId = nonEmptyString(viewId);
    if (!normalizedViewId) throw httpError("viewId is required", 400);
    const webviewProvider = this.webviewViewProviders.get(normalizedViewId);
    if (webviewProvider) {
      return this.resolveWebviewView(normalizedViewId, webviewProvider);
    }
    const treeProvider = this.treeDataProviders.get(normalizedViewId);
    if (treeProvider) {
      return this.resolveTreeView(normalizedViewId, treeProvider);
    }
    return { ok: false, viewId: normalizedViewId, error: "view provider not found" };
  }

  async readRuntimeResource(extensionId: string, resourcePath: string) {
    const normalizedId = nonEmptyString(extensionId).toLowerCase();
    const requestedPath = nonEmptyString(resourcePath);
    if (!normalizedId) throw httpError("extensionId is required", 400);
    if (!requestedPath) throw httpError("path is required", 400);
    const extension = (await this.listExtensions()).extensions.find((item: any) => item.id === normalizedId);
    if (!extension) throw httpError(`extension not found: ${normalizedId}`, 404);
    const resolvedPath = path.resolve(requestedPath);
    assertInsideDir(resolvedPath, extension.installedPath);
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) throw httpError("resource is not a file", 404);
    return {
      bytes: fs.readFileSync(resolvedPath),
      mimeType: mimeTypeForPath(resolvedPath),
    };
  }

  async postRuntimeViewMessage(viewId: string, message: any) {
    const normalizedViewId = nonEmptyString(viewId);
    if (!normalizedViewId) throw httpError("viewId is required", 400);
    const state = this.resolvedWebviews.get(normalizedViewId);
    if (!state) return { ok: false, viewId: normalizedViewId, error: "webview is not resolved" };
    state.messageEmitter.fire(message);
    return { ok: true, viewId: normalizedViewId };
  }

  async readRuntimeViewMessages(viewId: string, after = 0) {
    const normalizedViewId = nonEmptyString(viewId);
    if (!normalizedViewId) throw httpError("viewId is required", 400);
    const state = this.resolvedWebviews.get(normalizedViewId);
    if (!state) return { ok: false, viewId: normalizedViewId, error: "webview is not resolved", messages: [] };
    const minId = Number.isFinite(Number(after)) ? Number(after) : 0;
    return {
      ok: true,
      viewId: normalizedViewId,
      messages: state.outgoingMessages.filter(item => item.id > minId),
    };
  }

  async searchGallery(query: string, pageSize = 20) {
    if (!this.fetchImpl) throw new Error("fetch is unavailable");
    const searchText = nonEmptyString(query);
    if (!searchText) return { results: [] };
    const extensions = await this.queryGallery([
      { filterType: GALLERY_FILTER_SEARCH_TEXT, value: searchText },
    ], pageSize);
    return {
      results: extensions.map((extension: any) => this.mapGalleryExtension(extension)),
    };
  }

  async installFromGallery(id: string) {
    const found = await this.findGalleryExtensionById(id);
    if (!found?.vsixUrl) throw httpError(`VSCode gallery extension not found: ${id}`, 404);
    if (!this.fetchImpl) throw new Error("fetch is unavailable");
    ensureDir(path.join(this.hanakoHome, "vscode-extension-downloads"));
    const response = await this.fetchImpl(found.vsixUrl, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "HanaIDE/1.0 VSCodeExtensionInstaller",
      },
    });
    if (!response.ok) throw httpError(`VSIX download failed: ${response.status}`, 502);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw httpError("VSIX download did not return a valid ZIP package", 502);
    }
    const target = path.join(this.hanakoHome, "vscode-extension-downloads", `${safePathSegment(found.id)}.vsix`);
    fs.writeFileSync(target, buffer);
    return this.installFromPath(target);
  }

  private async queryGallery(criteria: Array<{ filterType: number; value: string }>, pageSize: number) {
    if (!this.fetchImpl) throw new Error("fetch is unavailable");
    const response = await this.fetchImpl(this.galleryServiceUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "HanaIDE/1.0 VSCodeExtensionInstaller",
        Accept: "application/json;api-version=7.2-preview.1",
      },
      body: JSON.stringify({
        filters: [
          {
            criteria,
            pageNumber: 1,
            pageSize,
            sortBy: 0,
            sortOrder: 0,
          },
        ],
        assetTypes: [VSIX_ASSET_TYPE],
        flags: GALLERY_FLAGS,
      }),
    });
    if (!response.ok) throw new Error(`VSCode gallery search failed: ${response.status}`);
    const payload = await response.json();
    return Array.isArray(payload?.results?.[0]?.extensions) ? payload.results[0].extensions : [];
  }

  private async findGalleryExtensionById(id: string) {
    const normalizedId = id.toLowerCase();
    const exactExtensions = await this.queryGallery([
      { filterType: GALLERY_FILTER_EXTENSION_NAME, value: normalizedId },
    ], 1);
    const exact = exactExtensions.map((extension: any) => this.mapGalleryExtension(extension))
      .find((item: any) => item.id.toLowerCase() === normalizedId);
    if (exact) return exact;

    const search = await this.searchGallery(id, 10);
    return search.results.find((item: any) => item.id.toLowerCase() === normalizedId) || null;
  }

  private readInstalledExtension(extensionDir: string, disabled = this.readDisabledSet()) {
    const manifestPath = path.join(extensionDir, "package.json");
    if (!fs.existsSync(manifestPath)) return null;
    const manifest = readJsonFile(manifestPath);
    const id = toExtensionId(manifest);
    const runtime = inferRuntime(manifest);
    return {
      id,
      publisher: nonEmptyString(manifest.publisher) || "unknown",
      name: nonEmptyString(manifest.name),
      displayName: nonEmptyString(manifest.displayName) || nonEmptyString(manifest.name),
      description: nonEmptyString(manifest.description),
      version: nonEmptyString(manifest.version),
      engines: manifest.engines || {},
      extensionKind: normalizeArray(manifest.extensionKind),
      activationEvents: normalizeArray(manifest.activationEvents),
      installedPath: extensionDir,
      enabled: !disabled.has(id),
      runtime: {
        ...runtime,
        activated: this.activatedExtensions.has(id),
      },
      contributions: {
        commands: normalizeCommands(manifest),
        viewsContainers: normalizeViewsContainers(manifest),
        views: normalizeViews(manifest),
        languages: normalizeArray(manifest?.contributes?.languages),
        grammars: normalizeArray(manifest?.contributes?.grammars),
        debuggers: normalizeArray(manifest?.contributes?.debuggers),
        themes: normalizeArray(manifest?.contributes?.themes),
        configuration: manifest?.contributes?.configuration || null,
      },
    };
  }

  private async activateExtension(extension: any, options: VscodeExtensionRuntimeOptions) {
    if (this.activatedExtensions.has(extension.id)) return;
    const manifest = readJsonFile(path.join(extension.installedPath, "package.json"));
    const main = nonEmptyString(manifest.main);
    if (!main) throw new Error("extension main entry is missing");
    const mainPath = path.resolve(extension.installedPath, main);
    assertInsideDir(mainPath, extension.installedPath);
    if (!fs.existsSync(mainPath)) throw new Error(`extension main entry not found: ${main}`);

    const context = this.createExtensionContext(extension, options);
    const vscodeApi = this.createVscodeApi(extension, options);
    const moduleAny = Module as any;
    const previousLoad = moduleAny._load;
    moduleAny._load = function(request: string, parent: any, isMain: boolean) {
      if (request === "vscode") return vscodeApi;
      return previousLoad.call(this, request, parent, isMain);
    };

    try {
      const requireFromExtension = createRequire(mainPath);
      const extensionModule = requireFromExtension(mainPath);
      if (typeof extensionModule?.activate === "function") {
        await Promise.resolve(extensionModule.activate(context));
      }
      this.activatedExtensions.set(extension.id, { subscriptions: context.subscriptions });
    } finally {
      moduleAny._load = previousLoad;
    }
  }

  private deactivateExtension(id: string) {
    const activation = this.activatedExtensions.get(id);
    if (activation) {
      for (const disposable of activation.subscriptions) {
        try { disposable?.dispose?.(); } catch {}
      }
    }
    for (const [command, registration] of this.commands.entries()) {
      if (registration.extensionId === id) this.commands.delete(command);
    }
    for (const [viewId, registration] of this.webviewViewProviders.entries()) {
      if (registration.extensionId === id) this.webviewViewProviders.delete(viewId);
    }
    for (const [viewId, registration] of this.treeDataProviders.entries()) {
      if (registration.extensionId === id) this.treeDataProviders.delete(viewId);
    }
    for (const [viewId, state] of this.resolvedWebviews.entries()) {
      if (state.extensionId === id) {
        state.disposeEmitter.fire(undefined);
        state.disposeEmitter.dispose();
        state.visibilityEmitter.dispose();
        state.messageEmitter.dispose();
        this.resolvedWebviews.delete(viewId);
      }
    }
    this.activatedExtensions.delete(id);
  }

  private createExtensionContext(extension: any, options: VscodeExtensionRuntimeOptions) {
    const globalStoragePath = path.join(this.hanakoHome, "vscode-extension-state", extension.id);
    const logPath = path.join(this.hanakoHome, "logs", "vscode-extensions", extension.id);
    ensureDir(globalStoragePath);
    ensureDir(logPath);
    return {
      subscriptions: [],
      extensionPath: extension.installedPath,
      extensionUri: createFileUri(extension.installedPath),
      globalStoragePath,
      storagePath: options.workspacePath ? path.join(globalStoragePath, safePathSegment(options.workspacePath)) : globalStoragePath,
      logPath,
      globalState: createMemento(),
      workspaceState: createMemento(),
      asAbsolutePath: (relativePath: string) => path.join(extension.installedPath, relativePath),
    };
  }

  private createVscodeApi(extension: any, options: VscodeExtensionRuntimeOptions) {
    const registerCommand = (command: string, callback: (...args: any[]) => any) => {
      const manifestCommand = extension.contributions.commands.find((item: any) => item.command === command);
      this.commands.set(command, {
        command,
        callback,
        extensionId: extension.id,
        title: manifestCommand?.title || command,
      });
      return {
        dispose: () => {
          const current = this.commands.get(command);
          if (current?.extensionId === extension.id) this.commands.delete(command);
        },
      };
    };
    const workspaceFolders = options.workspacePath ? [{
      name: path.basename(options.workspacePath),
      uri: createFileUri(options.workspacePath),
    }] : [];
    const workspaceRoot = workspaceFolders[0]?.uri.fsPath || "";
    const asRelativePath = (resource: any) => {
      const fsPath = fsPathFromUri(resource);
      if (!workspaceRoot || !fsPath) return fsPath || String(resource || "");
      const relative = path.relative(workspaceRoot, fsPath);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
        ? relative.replace(/\\/g, "/")
        : fsPath.replace(/\\/g, "/");
    };
    const createTextDocument = async (input: any) => {
      const fsPath = fsPathFromUri(input);
      const content = fsPath && fs.existsSync(fsPath)
        ? await fs.promises.readFile(fsPath, "utf8")
        : nonEmptyString(input?.content);
      const lineStarts = [0];
      for (let index = 0; index < content.length; index++) {
        if (content[index] === "\n") lineStarts.push(index + 1);
      }
      return {
        uri: fsPath ? createFileUri(fsPath) : createFileUri(""),
        fileName: fsPath,
        languageId: nonEmptyString(input?.language) || "plaintext",
        version: 1,
        isDirty: false,
        isUntitled: !fsPath,
        getText: () => content,
        lineAt: (line: number) => {
          const start = lineStarts[line] ?? 0;
          const end = lineStarts[line + 1] ? lineStarts[line + 1] - 1 : content.length;
          return { lineNumber: line, text: content.slice(start, end), range: null };
        },
        positionAt: (offset: number) => {
          const clamped = Math.max(0, Math.min(content.length, offset));
          let line = 0;
          for (let index = 0; index < lineStarts.length; index++) {
            if (lineStarts[index] > clamped) break;
            line = index;
          }
          return { line, character: clamped - (lineStarts[line] || 0) };
        },
        offsetAt: (position: any) => (lineStarts[position?.line || 0] || 0) + (position?.character || 0),
      };
    };
    const createWebview = () => {
      let html = "";
      let panelOptions: any = {};
      const messageEmitter = createEmitter();
      return {
        get html() { return html; },
        set html(value: string) { html = String(value ?? ""); },
        get options() { return panelOptions; },
        set options(value: any) { panelOptions = value || {}; },
        cspSource: "http://localhost:* http://127.0.0.1:*",
        onDidReceiveMessage: messageEmitter.event.bind(messageEmitter),
        postMessage: async () => true,
        asWebviewUri: (uri: any) => {
          const fsPath = fsPathFromUri(uri);
          return `/api/vscode-extensions/runtime/resources/${encodeURIComponent(extension.id)}?path=${encodeURIComponent(path.resolve(fsPath))}`;
        },
      };
    };

    return {
      version: "1.90.0-hanaide",
      ExtensionKind: { UI: 1, Workspace: 2 },
      Uri: {
        file: createFileUri,
        parse: (value: string) => {
          if (value.startsWith("file://")) return createFileUri(value.replace(/^file:\/+/, ""));
          return { scheme: value.split(":")[0] || "", path: value, fsPath: value, toString: () => value };
        },
      },
      commands: {
        registerCommand,
        executeCommand: (command: string, ...args: any[]) => {
          if (command === "setContext") {
            this.contextValues.set(String(args[0] || ""), args[1]);
            return Promise.resolve(undefined);
          }
          if (
            command === "workbench.action.showCommands"
            || command === "workbench.action.reloadWindow"
            || command === "vscode.open"
            || command === "vscode.openWith"
          ) {
            return Promise.resolve(undefined);
          }
          return this.executeCommand(command, args).then(result => result.result);
        },
      },
      workspace: {
        workspaceFolders,
        name: workspaceFolders[0]?.name,
        isTrusted: true,
        asRelativePath,
        getWorkspaceFolder: (uri: any) => {
          const fsPath = fsPathFromUri(uri);
          if (!workspaceRoot || !fsPath) return undefined;
          const relative = path.relative(workspaceRoot, fsPath);
          return !relative.startsWith("..") && !path.isAbsolute(relative) ? workspaceFolders[0] : undefined;
        },
        getConfiguration: () => ({
          get: (_key: string, fallback?: any) => fallback,
          update: () => Promise.resolve(),
          has: () => false,
        }),
        onDidChangeConfiguration: createNoopEvent(),
        onDidChangeTextDocument: createNoopEvent(),
        onDidChangeWorkspaceFolders: createNoopEvent(),
        createFileSystemWatcher: () => ({
          onDidCreate: createNoopEvent(),
          onDidChange: createNoopEvent(),
          onDidDelete: createNoopEvent(),
          dispose: () => undefined,
        }),
        openTextDocument: createTextDocument,
        findFiles: async () => {
          if (!workspaceRoot || !fs.existsSync(workspaceRoot)) return [];
          const found: any[] = [];
          const visit = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) visit(fullPath);
              else found.push(createFileUri(fullPath));
              if (found.length >= 500) return;
            }
          };
          visit(workspaceRoot);
          return found;
        },
        fs: {
          readFile: async (uri: any) => fs.promises.readFile(fsPathFromUri(uri)),
          writeFile: async (uri: any, content: Uint8Array) => fs.promises.writeFile(fsPathFromUri(uri), content),
          stat: async (uri: any) => {
            const stat = await fs.promises.stat(fsPathFromUri(uri));
            return { type: stat.isDirectory() ? 2 : 1, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
          },
          readDirectory: async (uri: any) => {
            const entries = await fs.promises.readdir(fsPathFromUri(uri), { withFileTypes: true });
            return entries.map(entry => [entry.name, entry.isDirectory() ? 2 : 1]);
          },
          createDirectory: async (uri: any) => fs.promises.mkdir(fsPathFromUri(uri), { recursive: true }),
          delete: async (uri: any, deleteOptions?: any) => fs.promises.rm(fsPathFromUri(uri), { recursive: !!deleteOptions?.recursive, force: true }),
          rename: async (oldUri: any, newUri: any, renameOptions?: any) => {
            if (renameOptions?.overwrite && fs.existsSync(fsPathFromUri(newUri))) {
              await fs.promises.rm(fsPathFromUri(newUri), { recursive: true, force: true });
            }
            await fs.promises.rename(fsPathFromUri(oldUri), fsPathFromUri(newUri));
          },
        },
      },
      window: {
        activeTextEditor: undefined,
        visibleTextEditors: [],
        tabGroups: { all: [], activeTabGroup: { tabs: [], activeTab: undefined } },
        onDidChangeActiveTextEditor: createNoopEvent(),
        onDidChangeTextEditorSelection: createNoopEvent(),
        onDidChangeWindowState: createNoopEvent(),
        onDidChangeTerminalShellIntegration: createNoopEvent(),
        registerUriHandler: () => createDisposable(),
        registerCustomEditorProvider: () => createDisposable(),
        registerWebviewViewProvider: (viewId: string, provider: any, providerOptions?: any) => {
          const normalizedViewId = nonEmptyString(viewId);
          if (!normalizedViewId) throw new Error("viewId is required");
          if (this.webviewViewProviders.has(normalizedViewId)) {
            throw new Error(`View provider for '${normalizedViewId}' already registered`);
          }
          this.webviewViewProviders.set(normalizedViewId, {
            viewId: normalizedViewId,
            extensionId: extension.id,
            provider,
            options: providerOptions?.webviewOptions || providerOptions,
          });
          return {
            dispose: () => {
              const current = this.webviewViewProviders.get(normalizedViewId);
              if (current?.extensionId === extension.id) this.webviewViewProviders.delete(normalizedViewId);
            },
          };
        },
        registerTreeDataProvider: (viewId: string, provider: any) => {
          const normalizedViewId = nonEmptyString(viewId);
          if (!normalizedViewId) throw new Error("viewId is required");
          this.treeDataProviders.set(normalizedViewId, {
            viewId: normalizedViewId,
            extensionId: extension.id,
            provider,
          });
          return {
            dispose: () => {
              const current = this.treeDataProviders.get(normalizedViewId);
              if (current?.extensionId === extension.id) this.treeDataProviders.delete(normalizedViewId);
            },
          };
        },
        createTreeView: (viewId: string, treeOptions: any) => {
          const disposable = this.createVscodeApi(extension, options).window.registerTreeDataProvider(viewId, treeOptions?.treeDataProvider);
          return {
            dispose: disposable.dispose,
            reveal: async () => undefined,
            onDidChangeSelection: createNoopEvent(),
            onDidChangeVisibility: createNoopEvent(),
            selection: [],
            visible: true,
          };
        },
        createWebviewPanel: (viewType: string, title: string) => {
          const disposeEmitter = createEmitter();
          const viewStateEmitter = createEmitter();
          return {
            viewType,
            title,
            webview: createWebview(),
            active: true,
            visible: true,
            reveal: () => undefined,
            dispose: () => disposeEmitter.fire(undefined),
            onDidDispose: disposeEmitter.event.bind(disposeEmitter),
            onDidChangeViewState: viewStateEmitter.event.bind(viewStateEmitter),
          };
        },
        createTerminal: (terminalOptions?: any) => ({
          name: nonEmptyString(terminalOptions?.name) || "HanaIDE Terminal",
          processId: Promise.resolve(undefined),
          creationOptions: terminalOptions || {},
          exitStatus: undefined,
          shellIntegration: {},
          sendText: () => undefined,
          show: () => undefined,
          hide: () => undefined,
          dispose: () => undefined,
        }),
        createTextEditorDecorationType: () => createDisposable(),
        showOpenDialog: async () => [],
        showTextDocument: async (documentOrUri: any) => ({ document: await createTextDocument(documentOrUri) }),
        showInformationMessage: async (_message: string, ...items: any[]) => items[0],
        showWarningMessage: async (_message: string, ...items: any[]) => items[0],
        showErrorMessage: async (_message: string, ...items: any[]) => items[0],
        createOutputChannel: () => ({
          append: () => undefined,
          appendLine: () => undefined,
          clear: () => undefined,
          show: () => undefined,
          hide: () => undefined,
          dispose: () => undefined,
        }),
      },
      env: {
        appName: "HanaIDE",
        appRoot: this.hanakoHome,
        uriScheme: "hanaide",
        language: "zh-cn",
        remoteName: undefined,
        openExternal: async () => true,
        clipboard: {
          readText: async () => this.clipboardText,
          writeText: async (value: string) => {
            this.clipboardText = String(value ?? "");
          },
        },
      },
      languages: {
        registerCodeLensProvider: () => createDisposable(),
        getDiagnostics: () => [],
      },
      chat: {
        registerChatSessionItemProvider: () => createDisposable(),
      },
      TreeItem: class TreeItem {
        label: any;
        collapsibleState: any;
        constructor(label: any, collapsibleState?: any) {
          this.label = label;
          this.collapsibleState = collapsibleState;
        }
      },
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
      ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
      ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
      Position: class Position {
        line: number;
        character: number;
        constructor(line: number, character: number) {
          this.line = line;
          this.character = character;
        }
      },
      Range: class Range {
        start: any;
        end: any;
        constructor(startLine: any, startCharacter?: any, endLine?: any, endCharacter?: any) {
          this.start = typeof startLine === "object" ? startLine : { line: startLine, character: startCharacter };
          this.end = typeof startLine === "object" ? startCharacter : { line: endLine, character: endCharacter };
        }
      },
      CodeLens: class CodeLens {
        range: any;
        command: any;
        constructor(range: any, command?: any) {
          this.range = range;
          this.command = command;
        }
      },
      ThemeIcon: class ThemeIcon {
        id: string;
        constructor(id: string) {
          this.id = id;
        }
      },
      EventEmitter: class EventEmitter {
        private readonly emitter = createEmitter();
        readonly event = this.emitter.event.bind(this.emitter);
        fire(value?: any) {
          this.emitter.fire(value);
        }
        dispose() {
          this.emitter.dispose();
        }
      },
      Disposable: class Disposable {
        private readonly callOnDispose: () => void;
        constructor(callOnDispose: () => void) {
          this.callOnDispose = callOnDispose;
        }
        dispose() {
          this.callOnDispose();
        }
      },
    };
  }

  private async resolveWebviewView(viewId: string, registration: { extensionId: string; provider: any; options?: any }) {
    const existing = this.resolvedWebviews.get(viewId);
    if (existing) {
      existing.disposeEmitter.fire(undefined);
      existing.disposeEmitter.dispose();
      existing.visibilityEmitter.dispose();
      existing.messageEmitter.dispose();
    }
    const state: RuntimeWebviewState = {
      viewId,
      extensionId: registration.extensionId,
      html: "",
      options: {},
      title: viewId,
      description: "",
      badge: undefined,
      messageEmitter: createEmitter(),
      disposeEmitter: createEmitter(),
      visibilityEmitter: createEmitter(),
      outgoingMessages: [],
      nextMessageId: 1,
    };
    this.resolvedWebviews.set(viewId, state);
    const webview: any = {
      get html() { return state.html; },
      set html(value: string) { state.html = String(value ?? ""); },
      get options() { return state.options; },
      set options(value: any) { state.options = value || {}; },
      cspSource: "http://localhost:* http://127.0.0.1:*",
      onDidReceiveMessage: state.messageEmitter.event.bind(state.messageEmitter),
      postMessage: async (message: any) => {
        state.outgoingMessages.push({ id: state.nextMessageId++, message });
        return true;
      },
      asWebviewUri: (uri: any) => {
        const fsPath = nonEmptyString(uri?.fsPath)
          || (nonEmptyString(uri?.scheme) === "file" ? nonEmptyString(uri?.path) : "")
          || String(uri || "").replace(/^file:\/\/\/?/, "");
        return `/api/vscode-extensions/runtime/resources/${encodeURIComponent(registration.extensionId)}?path=${encodeURIComponent(path.resolve(fsPath))}`;
      },
    };
    const webviewView: any = {
      viewType: viewId,
      webview,
      visible: true,
      get title() { return state.title; },
      set title(value: string | undefined) { state.title = nonEmptyString(value) || viewId; },
      get description() { return state.description; },
      set description(value: string | undefined) { state.description = nonEmptyString(value); },
      get badge() { return state.badge; },
      set badge(value: any) { state.badge = value; },
      onDidDispose: state.disposeEmitter.event.bind(state.disposeEmitter),
      onDidChangeVisibility: state.visibilityEmitter.event.bind(state.visibilityEmitter),
      show: () => undefined,
      dispose: () => state.disposeEmitter.fire(undefined),
    };
    try {
      await Promise.resolve(registration.provider?.resolveWebviewView?.(
        webviewView,
        { state: undefined },
        cancellationTokenNone(),
      ));
    } catch (err) {
      this.resolvedWebviews.delete(viewId);
      throw err;
    }
    return {
      ok: true,
      type: "webview",
      viewId,
      extensionId: registration.extensionId,
      title: state.title,
      description: state.description,
      badge: state.badge,
      html: state.html,
      options: state.options,
    };
  }

  private async resolveTreeView(viewId: string, registration: { extensionId: string; provider: any }) {
    const roots = await Promise.resolve(registration.provider?.getChildren?.(undefined)) || [];
    const items = await Promise.all(normalizeArray(roots).map(async (element: any) => {
      const treeItem = await Promise.resolve(registration.provider?.getTreeItem?.(element)) || element;
      const label = typeof treeItem?.label === "string"
        ? treeItem.label
        : nonEmptyString(treeItem?.label?.label) || nonEmptyString(element?.label) || String(element);
      return {
        label,
        description: nonEmptyString(treeItem?.description),
        tooltip: nonEmptyString(treeItem?.tooltip),
        collapsibleState: Number(treeItem?.collapsibleState) || 0,
        command: treeItem?.command || null,
      };
    }));
    return {
      ok: true,
      type: "tree",
      viewId,
      extensionId: registration.extensionId,
      items,
    };
  }

  private readDisabledSet(): Set<string> {
    try {
      const raw = readJsonFile(this.disabledFile);
      const values = Array.isArray(raw) ? raw : normalizeArray(raw.disabled);
      return new Set(values.map(value => String(value).toLowerCase()));
    } catch {
      return new Set();
    }
  }

  private writeDisabledSet(disabled: Set<string>) {
    ensureDir(this.extensionsDir);
    fs.writeFileSync(this.disabledFile, JSON.stringify({
      disabled: Array.from(disabled).sort(),
    }, null, 2));
  }

  private mapGalleryExtension(extension: any) {
    const publisher = nonEmptyString(extension?.publisher?.publisherName) || nonEmptyString(extension?.publisher?.displayName);
    const name = nonEmptyString(extension?.extensionName);
    const latestVersion = extension?.versions?.[0] || {};
    const files = Array.isArray(latestVersion.files) ? latestVersion.files : [];
    const vsix = files.find((file: any) => file.assetType === VSIX_ASSET_TYPE);
    const id = `${publisher}.${name}`.toLowerCase();
    return {
      id,
      publisher,
      name,
      displayName: nonEmptyString(extension?.displayName) || name,
      shortDescription: nonEmptyString(extension?.shortDescription),
      version: nonEmptyString(latestVersion.version),
      installCount: Number(extension?.statistics?.find((item: any) => item.statisticName === "install")?.value) || 0,
      rating: Number(extension?.statistics?.find((item: any) => item.statisticName === "averagerating")?.value) || 0,
      itemUrl: `${this.galleryItemUrl}?itemName=${encodeURIComponent(`${publisher}.${name}`)}`,
      vsixUrl: nonEmptyString(vsix?.source),
    };
  }
}

export function createVscodeExtensionService(options: VscodeExtensionServiceOptions = {}) {
  return new VscodeExtensionService(options);
}
