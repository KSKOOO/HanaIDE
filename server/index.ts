/**
 * HanaIDE Server — HTTP + WebSocket API
 *
 * 启动方式：
 *   node server/index.js              （独立运行）
 *   Electron main.js fork 启动        （桌面应用内嵌）
 *
 * 当通过 fork() 启动时，会通过 IPC 通知父进程端口号。
 */
import crypto from "crypto";
import fs from "fs";
import { setMaxListeners } from "events";
import path from "path";
import { Hono } from "hono";
import { createAdaptorServer } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocketServer } from "ws";
import { AppError } from "../shared/errors.ts";
import { errorBus } from "../shared/error-bus.ts";
import { HanaEngine } from "../core/engine.ts";
import { ensureFirstRun } from "../core/first-run.ts";
import { initDebugLog, createModuleLogger } from "../lib/debug-log.ts";
import { redactLogLabel, redactLogText } from "../lib/log-redactor.ts";
import { safeJson } from "./hono-helpers.ts";
import { resolveSessionThinkingLevelState } from "./session-thinking-level-state.ts";

const log = createModuleLogger("server");
const checkpointLog = createModuleLogger("checkpoint");
const sessionFilesLog = createModuleLogger("session-files");
import { createOutboundProxyRuntime } from "../lib/net/outbound-proxy.ts";
import { createServerAuthService } from "../core/server-auth.ts";
import { createWebSocketTicketService } from "../core/ws-auth-ticket.ts";
import { resolveServerListenOptions } from "../core/server-network-config.ts";
import { isCorsOriginAllowed } from "./http/cors-policy.ts";
import { inferHttpConnectionKind } from "./http/transport-context.ts";
import { authorizeHttpRoute, isPublicHttpRoute } from "./http/route-security.ts";

// Pi SDK 的 fetch 请求会累积 AbortSignal listener，提高上限避免无害警告
setMaxListeners(50);

import { loadLocale } from "../lib/i18n.ts";
import { createChatRoute } from "./routes/chat.ts";
import { createSessionsRoute } from "./routes/sessions.ts";
import { createSessionProjectsRoute } from "./routes/session-projects.ts";
import { createModelsRoute } from "./routes/models.ts";
import { createConfigRoute } from "./routes/config.ts";
import { createUploadRoute } from "./routes/upload.ts";
import { createProvidersRoute } from "./routes/providers.ts";
import { createAvatarRoute } from "./routes/avatar.ts";
import { createAgentsRoute } from "./routes/agents.ts";
import { createDevicesRoute } from "./routes/devices.ts";
import { createCharacterCardsRoute } from "./routes/character-cards.ts";
import { createDeskRoute } from "./routes/desk.ts";
import { createSkillsRoute } from "./routes/skills.ts";
import { createFsRoute } from "./routes/fs.ts";
import { createPreferencesRoute } from "./routes/preferences.ts";
import { createSettingsSnapshotRoute } from "./routes/settings-snapshot.ts";
import { createExperimentsRoute } from "./routes/experiments.ts";
import { createBridgeRoute } from "./routes/bridge.ts";
import { createAuthRoute } from "./routes/auth.ts";
import { createDiaryRoute } from "./routes/diary.ts";
import { createConfirmRoute } from "./routes/confirm.ts";
import {
  createPluginsRoute,
  verifyPluginIframeTicketForHostRequest,
} from "./routes/plugins.ts";
import { PluginIframeTicketError } from "../core/plugin-iframe-ticket-service.ts";
import { PluginAssetSessionError } from "../core/plugin-asset-session-service.ts";
import {
  isMalformedPluginAssetRequest,
  isPluginAssetRequest,
  verifyPluginAssetSessionForHostRequest,
} from "./http/plugin-assets.ts";
import { resolveHttpRequestPrincipal } from "./http/request-principal.ts";
import { createCheckpointsRoute } from "./routes/checkpoints.ts";
import { createCommandsRoute } from "./routes/commands.ts";
import { createServerIdentityRoute } from "./routes/server-identity.ts";
import { ensureLocalIdentityRegistries } from "../core/server-identity.ts";
import { createResourcesRoute } from "./routes/resources.ts";
import { createUsageRoute } from "./routes/usage.ts";
import { createWebAuthRoute } from "./routes/web-auth.ts";
import { createWebSocketAuthRoute } from "./routes/ws-auth.ts";
import { createMobileWorkbenchRoute } from "./routes/mobile-workbench.ts";
import { createStudioWorkspacesRoute } from "./routes/studio-workspaces.ts";
import { createMobileStaticRoute } from "./routes/mobile-static.ts";
import { createHtmlPreviewRoute } from "./routes/html-preview.ts";
import { createAccessRoute } from "./routes/access.ts";
import { createMediaRoute } from "./routes/media.ts";
import { createSpeechRecognitionRoute } from "./routes/speech-recognition.ts";
import { createTerminalRoute } from "./routes/terminal.ts";
import { createVscodeExtensionsRoute } from "./routes/vscode-extensions.ts";
import { registerTaskRegistryBusHandlers } from "./task-bus-handlers.ts";
import { registerDeferredResultBusHandlers } from "./deferred-result-bus-handlers.ts";
import { configureProcessPiSdkEnv, ensureHanaPiSdkDirs, resolveHanakoHome } from "../shared/hana-runtime-paths.ts";
// internal-browser WS is handled directly via raw ws.WebSocketServer in the
// upgrade handler below (WsTransport needs raw ws .on()/.off() methods)
import { ConfirmStore } from "../lib/confirm-store.ts";
import { DeferredResultStore } from "../lib/deferred-result-store.ts";
import { SubagentRunStore } from "../lib/subagent-run-store.ts";
import { SubagentThreadStore } from "../lib/subagent-thread-store.ts";
import { ActivityHub } from "../lib/activity-hub.ts";
import { WorkflowActivityStore } from "../lib/workflow-activity-store.ts";
import { createDeferredResultExtension } from "../lib/extensions/deferred-result-ext.ts";
import { createCompactionGuardExtension } from "../lib/extensions/compaction-guard-ext.ts";
import { getResolvedCompactionMode } from "../shared/compaction-mode.ts";
import { Hub } from "../hub/index.ts";
import { startCLI } from "./cli.ts";
import { fromRoot } from "../shared/hana-root.ts";
import { callText } from "../core/llm-client.ts";

const productDir = fromRoot("lib");

async function bindServerTransportOwnership(server: any, { host, port, listenHost, networkMode }: any) {
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.off("listening", onListening);
        server.off("error", onError);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(port, host);
    });
  } catch (err: any) {
    const startupError: any = isAddressInUseError(err)
      ? createPortInUseStartupError(err, { host, port, listenHost, networkMode })
      : isListenPermissionError(err)
      ? createListenPermissionStartupError(err, { host, port, listenHost, networkMode })
      : err;
    if (startupError.startupPayload) {
      log.error(`startup-error ${JSON.stringify(startupError.startupPayload)}`);
    }
    log.error(`启动失败: ${startupError.message}`);
    process.exit(1);
  }
}

function isAddressInUseError(err: any) {
  return err?.code === "EADDRINUSE";
}

function isListenPermissionError(err: any) {
  return err?.code === "EACCES" || err?.code === "EPERM";
}

function createPortInUseStartupError(cause: any, { host, port, listenHost, networkMode }: any) {
  const payload = {
    code: "PORT_IN_USE",
    host,
    port,
    listenHost,
    networkMode,
    suggestions: [
      `Close the process already listening on ${host}:${port}.`,
      "If this is another Hana server, restart that instance or quit it cleanly.",
      "To use a different port, change the port in Access & Devices and restart.",
    ],
  };
  const err: any = new Error(
    `PORT_IN_USE: ${host}:${port} is already in use (network mode: ${networkMode}, configured host: ${listenHost}).`
  );
  err.code = "PORT_IN_USE";
  err.startupPayload = payload;
  err.cause = cause;
  return err;
}

function createListenPermissionStartupError(cause: any, { host, port, listenHost, networkMode }: any) {
  const payload = {
    code: "LISTEN_PERMISSION_DENIED",
    host,
    port,
    listenHost,
    networkMode,
    suggestions: [
      `Check whether Windows reserved port policy or security software blocks listening on ${host}:${port}.`,
      "Use loopback mode for local-only access, or enable LAN from Access & Devices and restart.",
      "To use a different port, change the port in Access & Devices and restart.",
    ],
  };
  const err: any = new Error(
    `LISTEN_PERMISSION_DENIED: ${host}:${port} cannot be listened on (network mode: ${networkMode}, configured host: ${listenHost}).`
  );
  err.code = "LISTEN_PERMISSION_DENIED";
  err.startupPayload = payload;
  err.cause = cause;
  return err;
}

// 用户数据存放在 ~/.hanako/（打包后与产品代码分离）
// 开发时可通过 HANA_HOME 环境变量隔离数据目录，如：HANA_HOME=~/.hanako-dev node server/index.js
const hanakoHome = resolveHanakoHome(process.env.HANA_HOME);
process.env.HANA_HOME = hanakoHome;
ensureHanaPiSdkDirs(hanakoHome);
configureProcessPiSdkEnv(hanakoHome);

// 读取版本号
let appVersion = "?";
try {
  const pkg = JSON.parse(fs.readFileSync(fromRoot("package.json"), "utf-8"));
  appVersion = pkg.version || "?";
} catch {}

const SERVER_TOKEN = process.env.HANA_TOKEN || crypto.randomBytes(16).toString("hex");
const serverNetwork = resolveServerListenOptions(hanakoHome);
const envPort = Number.parseInt(process.env.HANA_PORT || "", 10);
const port = Number.isInteger(envPort) && envPort >= 0 ? envPort : serverNetwork.port;
const serverRuntimeState = {
  mode: serverNetwork.mode,
  listenHost: serverNetwork.host,
  bindHost: serverNetwork.host,
  configuredMode: serverNetwork.mode,
  configuredListenHost: serverNetwork.host,
  configuredPort: port,
  actualPort: null,
  applyNetworkConfig(network) {
    this.configuredMode = network.mode;
    this.configuredListenHost = network.listenHost;
    this.configuredPort = network.listenPort;
  },
};
const host = serverRuntimeState.bindHost;

function createServerRuntimeNetworkSummary() {
  return {
    mode: serverRuntimeState.mode,
    listenHost: serverRuntimeState.listenHost,
    bindHost: serverRuntimeState.bindHost,
    actualPort: Number.isInteger(serverRuntimeState.actualPort) ? serverRuntimeState.actualPort : null,
    configuredMode: serverRuntimeState.configuredMode || serverRuntimeState.mode,
    configuredListenHost: serverRuntimeState.configuredListenHost || serverRuntimeState.listenHost,
    configuredPort: Number.isInteger(serverRuntimeState.configuredPort) ? serverRuntimeState.configuredPort : port,
  };
}

let activeFetch: any = (request: any) => {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") {
    return Response.json({
      status: "starting",
      version: appVersion,
      networkMode: serverRuntimeState.mode,
      configuredHost: serverRuntimeState.listenHost,
      network: createServerRuntimeNetworkSummary(),
    }, { status: 503 });
  }
  return Response.json({ error: "server_starting" }, { status: 503 });
};

let server: any = createAdaptorServer({
  fetch: (...args: any[]) => activeFetch(...args),
  hostname: host,
});

await bindServerTransportOwnership(server, {
  host,
  port,
  listenHost: serverNetwork.host,
  networkMode: serverNetwork.mode,
});

// ── 首次运行播种 ──
log.log("① ensureFirstRun...");
const firstRunReport = ensureFirstRun(hanakoHome, productDir);
for (const invalid of firstRunReport.invalidAgentDirs) {
  log.warn(`① 发现无效 agent 目录（已跳过启动校验）: "${invalid.id}" (${invalid.reason})`);
}
if (firstRunReport.defaultConfigBackupPath) {
  log.warn(`① 默认助手 config.yaml 已损坏，原文件备份于: ${firstRunReport.defaultConfigBackupPath}`);
}
log.log("① ensureFirstRun 完成");

log.log("① ensureLocalIdentityRegistries...");
ensureLocalIdentityRegistries(hanakoHome);
log.log("① ensureLocalIdentityRegistries 完成");

// ── 初始化 Debug 日志 ──
const dlog = initDebugLog(path.join(hanakoHome, "logs"));

// ── 初始化引擎 ──
log.log("② 创建 HanaEngine...");
const engine: any = new HanaEngine({ hanakoHome, productDir, appVersion } as any);
log.log("② HanaEngine 构造完成，开始 init...");
await engine.init((msg: any) => log.log(msg));
log.log("② engine.init 完成");
dlog.log("server", "engine initialized");

const outboundProxyRuntime = createOutboundProxyRuntime({
  log: (msg: any) => dlog.log("server", msg),
  warn: (msg: any) => log.warn(msg),
} as any);
engine.setOutboundProxyRuntime(outboundProxyRuntime);
outboundProxyRuntime.apply(engine.getNetworkProxy());

// 注入依赖给 BrowserManager（避免循环依赖）
import { BrowserManager } from "../lib/browser/browser-manager.ts";
BrowserManager.setHanakoHome(engine.hanakoHome);
BrowserManager.setSessionIdResolver((sessionPath: string) => engine.getSessionIdForPath?.(sessionPath) || null);

// 注：createSession 必须在所有 Pi SDK extension factory 都注册完之后
// (framework extension via registerExtensionFactory + plugin extension via
//  initPlugins)。否则 ExtensionRunner 在 session 构造时只绑定当时已有的
// factories。运行期插件热操作后，engine.syncPluginExtensions() 会 reload
// 已加载且空闲的 session，让 ExtensionRunner 重新绑定最新 factories。
// 实际 createSession 调用下移到 initPlugins + registerExtensionFactory 之后。

// 写日志头部
dlog.header(appVersion, {
  model: engine.currentModel?.name || "(none)",
  agent: engine.agentName,
  agentId: engine.currentAgentId, // @ui-focus-ok: startup log
  utilityModel: (() => { try { return engine.resolveUtilityConfig?.()?.utility?.id || "(none)"; } catch { return "(none)"; } })(),
  channelsDir: engine.channelsDir,
});

if (process.platform === "win32") engine.startWin32LegacySandboxMaintenance();

// ── 初始化 Hub（调度中枢，包装 engine） ──
const hub = new Hub({ engine });

// ── 初始化插件系统 ──
await engine.initPlugins(hub.eventBus);

// 启动 Hub 调度器（Scheduler + ChannelRouter）
hub.initSchedulers();

engine.cleanupCheckpoints().catch(err => {
  checkpointLog.warn(`startup cleanup failed: ${err.message}`);
});

engine.cleanupColdSessionFiles().catch(err => {
  sessionFilesLog.warn(`startup cleanup failed: ${err.message}`);
});
const sessionFileCleanupTimer = setInterval(() => {
  engine.cleanupColdSessionFiles().catch(err => {
    sessionFilesLog.warn(`periodic cleanup failed: ${err.message}`);
  });
}, 24 * 60 * 60 * 1000);
sessionFileCleanupTimer.unref?.();

// 加载 i18n（engine.init 已经按全局偏好加载过，这里保持启动入口显式同步）
loadLocale(engine.getLocale?.() || engine.config?.locale);

const serverAuthService = createServerAuthService({
  hanakoHome,
  loopbackToken: SERVER_TOKEN,
  runtimeContext: () => engine.getRuntimeContext(),
});
const wsTicketService = createWebSocketTicketService();

// ── 创建 Hono 实例 ──
const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// CORS（默认允许 localhost 开发前端和 production Electron file:// 前端；HANA_CORS_ORIGIN 可收紧到单一来源）+ 鉴权
const corsAllowedOrigin = process.env.HANA_CORS_ORIGIN;
app.use("*", async (c: any, next: any) => {
  const origin = c.req.header("origin") || "";
  const isAllowed = isCorsOriginAllowed({
    origin,
    configuredOrigin: corsAllowedOrigin,
  } as any);
  if (origin && isAllowed) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
  }
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (c.req.method === "OPTIONS") return c.text("", 204);

  const transport = inferHttpConnectionKind({
    hostHeader: c.req.header("host"),
    remoteAddress: (c.env as any)?.incoming?.socket?.remoteAddress,
    networkMode: serverRuntimeState.mode,
  } as any);
  if (!transport.connectionKind) {
    return c.json({ error: "invalid_transport", detail: transport.reason }, 403);
  }
  const routePath = new URL(c.req.url).pathname;
  c.set("transportConnectionKind", transport.connectionKind);

  if (isResourceTicketContentRequest(c, routePath)) {
    await next();
    return;
  }

  if (isPluginIframeTicketRequest(c, routePath)) {
    try {
      verifyPluginIframeTicketForHostRequest(c, engine, { requireTicket: true });
    } catch (err: any) {
      if (err instanceof PluginIframeTicketError) {
        return c.json({ error: (err as any).code, detail: err.message }, (err as any).status);
      }
      throw err;
    }
    await next();
    return;
  }

  if (isMalformedPluginAssetRequest(c.req.url, routePath)) {
    return c.json({ error: "plugin_asset_not_found" }, 404);
  }

  if (isPluginAssetSessionRequest(c, routePath)) {
    try {
      const session = verifyPluginAssetSessionForHostRequest(c, engine, { requireSession: false });
      if (session) {
        await next();
        return;
      }
    } catch (err: any) {
      if (err instanceof PluginAssetSessionError) {
        return c.json({ error: (err as any).code, detail: err.message }, (err as any).status);
      }
      throw err;
    }
  }

  if (isPublicHttpRoute({ method: c.req.method, path: routePath })) {
    await next();
    return;
  }

  // 主鉴权 → plugin surface session 后备（仅 missing_credential 时）→ 路由授权。
  // 链路实现与契约见 server/http/request-principal.ts（与测试共用）。
  const resolved = resolveHttpRequestPrincipal(c, engine, {
    serverAuthService,
    wsTicketService,
    connectionKind: transport.connectionKind,
  });
  if (!resolved.ok) {
    return c.json(resolved.body, resolved.status);
  }
  c.set("authPrincipal", resolved.principal);

  await next();
});

function isResourceTicketContentRequest(c: any, routePath: any) {
  const method = c.req.method;
  return (method === "GET" || method === "HEAD")
    && /^\/api\/resources\/[^/]+\/content$/.test(routePath)
    && !!c.req.query("ticket");
}

function isPluginIframeTicketRequest(c: any, routePath: any) {
  const method = c.req.method;
  return (method === "GET" || method === "HEAD")
    && /^\/api\/plugins\/[^/]+\/.+$/.test(routePath)
    && !!c.req.query("pluginIframeTicket");
}

function isPluginAssetSessionRequest(c: any, routePath: any) {
  const method = c.req.method;
  return (method === "GET" || method === "HEAD")
    && isPluginAssetRequest(routePath);
}

// 全局错误处理
app.onError((err: any, c: any) => {
  const appErr = AppError.wrap(err);
  errorBus.report(appErr, {
    context: { method: c.req.method, url: c.req.url },
  });
  return c.json(
    { error: { code: appErr.code, message: appErr.message, traceId: appErr.traceId } },
    appErr.httpStatus
  );
});

// ── 阻塞式确认存储 ──
const confirmStore = new ConfirmStore({
  getSessionIdForPath: (sessionPath: string) => engine.getSessionIdForPath?.(sessionPath) || null,
});
engine.setConfirmStore(confirmStore);

// --- Deferred Result Store ---
const deferredResultStore = new DeferredResultStore(
  hub.eventBus,
  path.join(hanakoHome, ".ephemeral", "deferred-tasks.json"),
  { getSessionIdForPath: (sessionPath: string) => engine.getSessionIdForPath?.(sessionPath) || null },
);
engine.setDeferredResultStore(deferredResultStore);

const subagentRunStore = new SubagentRunStore(
  path.join(hanakoHome, "subagent-runs.json"),
  { getSessionIdForPath: (sessionPath: string) => engine.getSessionIdForPath?.(sessionPath) || null },
);
engine.setSubagentRunStore(subagentRunStore);

const subagentThreadStore = new SubagentThreadStore(
  path.join(hanakoHome, "subagent-threads.json"),
  { getSessionIdForPath: (sessionPath: string) => engine.getSessionIdForPath?.(sessionPath) || null },
);
engine.setSubagentThreadStore(subagentThreadStore);

// 统一 Agent Activity 实时真相源（内存广播层）：subagent / workflow / 巡检 都往这推，
// 前端按当前对话 sessionPath 订阅。广播走 engine.emitEvent → WS（与 block_update 同一路）。
// workflow / workflow_agent 另有持久化背书（重启不丢右侧卡）：启动先按 72h 修剪冷活动，
// 再交给 ActivityHub 回灌（构造时把遗留 running 判孤儿、标 failed）。
const WORKFLOW_ACTIVITY_TTL_MS = 72 * 60 * 60 * 1000;
const workflowActivityStore = new WorkflowActivityStore(
  path.join(hanakoHome, "workflow-activity.json"),
);
workflowActivityStore.prune(WORKFLOW_ACTIVITY_TTL_MS, Date.now());
const activityHub = new ActivityHub(
  { emit: (event, sp) => engine.emitEvent(event, sp) },
  workflowActivityStore,
  { getSessionIdForPath: (sessionPath: string) => engine.getSessionIdForPath?.(sessionPath) || null },
);
engine.setActivityHub(activityHub);

// Bus handlers for plugin access
registerDeferredResultBusHandlers(hub.eventBus, deferredResultStore);

// Task registry bus handlers (plugin access)
registerTaskRegistryBusHandlers(hub.eventBus, engine.taskRegistry);
hub.eventBus.handle("session:get-titles", async ({ paths }) => {
  if (!Array.isArray(paths) || !paths.length) return { titles: {} };
  const coord = engine._sessionCoord;
  if (!coord?.getTitlesForPaths) return { titles: {} };
  const titles = await coord.getTitlesForPaths(paths);
  return { titles };
});
function sessionUsageFields(sessionPath: string | null) {
  const cleanSessionPath = typeof sessionPath === "string" && sessionPath.trim()
    ? sessionPath.trim()
    : null;
  const sessionId = cleanSessionPath
    ? engine.getSessionIdForPath?.(cleanSessionPath) || null
    : null;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(cleanSessionPath ? { sessionPath: cleanSessionPath } : {}),
  };
}

function sessionUsageAttribution(sessionPath: string | null, agentId: string | null, extra: Record<string, any> = {}) {
  return {
    kind: "session",
    agentId: agentId || null,
    ...sessionUsageFields(sessionPath),
    ...extra,
  };
}

hub.eventBus.handle("utility:call-text", async (payload: any = {}) => {
  const sessionPath = typeof payload.sessionPath === "string" && payload.sessionPath.trim()
    ? payload.sessionPath.trim()
    : null;
  const agentId = typeof payload.agentId === "string" && payload.agentId.trim()
    ? payload.agentId.trim()
    : (sessionPath ? engine.agentIdFromSessionPath?.(sessionPath) || null : null);
  const utility = engine.resolveUtilityConfig({ agentId, sessionPath });
  const text = await callText({
    api: utility.api,
    apiKey: utility.api_key,
    baseUrl: utility.base_url,
    model: utility.utility,
    systemPrompt: payload.systemPrompt || "",
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    temperature: payload.temperature,
    maxTokens: payload.maxTokens,
    usageLedger: utility.usageLedger,
    usageContext: {
      source: {
        subsystem: "utility",
        operation: payload.operation || "call-text",
        surface: sessionPath ? "desktop" : "system",
        trigger: "tool",
      },
      attribution: sessionPath
        ? sessionUsageAttribution(sessionPath, utility.usageAgentId || agentId || null)
        : { kind: "utility", agentId: utility.usageAgentId || agentId || null },
    },
  } as any);
  return { text };
});
hub.eventBus.handle("model:sample-text", async (payload: any = {}) => {
  if (!Array.isArray(payload.messages)) {
    throw new Error("messages is required");
  }
  const sessionPath = typeof payload.sessionPath === "string" && payload.sessionPath.trim()
    ? payload.sessionPath.trim()
    : null;
  const agentId = typeof payload.agentId === "string" && payload.agentId.trim()
    ? payload.agentId.trim()
    : (sessionPath ? engine.agentIdFromSessionPath?.(sessionPath) || null : null);
  const pluginId = typeof payload.pluginId === "string" && payload.pluginId.trim()
    ? payload.pluginId.trim()
    : null;
  const utility = engine.resolveUtilityConfig({ agentId, sessionPath });
  const text = await callText({
    api: utility.api,
    apiKey: utility.api_key,
    baseUrl: utility.base_url,
    model: utility.utility,
    systemPrompt: payload.systemPrompt || "",
    messages: payload.messages,
    temperature: payload.temperature,
    maxTokens: payload.maxTokens,
    usageLedger: utility.usageLedger,
    usageContext: {
      source: {
        subsystem: pluginId ? "plugin" : "utility",
        operation: payload.operation || "sample-text",
        surface: "plugin",
        trigger: "tool",
        actor: pluginId ? { kind: "plugin", pluginId, agentId: agentId || null, ...sessionUsageFields(sessionPath) } : undefined,
      },
      attribution: pluginId
        ? { kind: "plugin", pluginId, agentId: utility.usageAgentId || agentId || null, ...sessionUsageFields(sessionPath) }
        : sessionPath
          ? sessionUsageAttribution(sessionPath, utility.usageAgentId || agentId || null)
          : { kind: "utility", agentId: utility.usageAgentId || agentId || null },
    },
  } as any);
  return { text };
});
hub.eventBus.handle("usage:list", (filter = {}) => {
  return engine.usageLedger.list(filter);
});

// Register Pi SDK extension factory
await engine.registerExtensionFactory(createDeferredResultExtension(deferredResultStore));
// Cache-preserving compaction — 接管 Pi auto/manual compact，避免原生 summarizer 冷读上下文
await engine.registerExtensionFactory(createCompactionGuardExtension({
  usageLedger: engine.usageLedger,
  getCompactionMode: () => getResolvedCompactionMode(engine.preferences),
  buildSessionCacheSnapshot: (sessionPath, options) => engine.buildSessionCacheSnapshot(sessionPath, options),
  buildUsageContext: ({ ctx }) => {
    const sessionPath = ctx?.sessionManager?.getSessionFile?.() || null;
    const bridgeContext = sessionPath ? engine.getBridgeContextForSessionPath(sessionPath) : null;
    if (bridgeContext?.isBridgeSession) {
      const conversationType = bridgeContext.chatType === "channel" ? "channel" : "dm";
      return {
        source: {
          subsystem: "compaction",
          operation: "fresh_compact",
          surface: conversationType,
          trigger: "threshold",
        },
        attribution: {
          kind: "phone_conversation",
          agentId: bridgeContext.agentId || null,
          conversationId: bridgeContext.sessionKey || bridgeContext.chatId || sessionPath,
          conversationType,
          ...sessionUsageFields(sessionPath),
        },
      };
    }
    return {
      source: {
        subsystem: "compaction",
        operation: "compact",
        surface: "desktop",
        trigger: "threshold",
      },
      attribution: sessionUsageAttribution(
        sessionPath,
        sessionPath ? engine.agentIdFromSessionPath?.(sessionPath) || null : null,
      ),
    };
  },
}));

// ── 启动默认 session ──
// Desktop 会显式跳过：renderer 首屏就是 pending-new-session，首次发送消息时
// 才需要创建 chat session；独立 server/CLI 保持旧行为。
// 时序要求：所有 framework extension + plugin extension 都注册完之后再 create，
// 否则 pi SDK ExtensionRunner 构造时拿不到这些 factory，extension 不会挂到
// startup session 上（Codex 评审发现的 issue#437 部分失效场景）。
const shouldCreateStartupSession = process.env.HANA_CREATE_STARTUP_SESSION !== "0";
if (shouldCreateStartupSession && engine.currentModel) {
  log.log("③ 创建 session...");
  await engine.createSession();
  log.log("③ Session created");
  dlog.log("server", `session created, model=${engine.currentModel.name}`);
} else if (!shouldCreateStartupSession) {
  log.log("③ 跳过启动期 session 创建");
  dlog.log("server", "startup session creation skipped");
} else {
  // 诊断信息：区分三种 currentModel=null 的情况，方便用户排查 (#414)
  const availableCount = engine.availableModels?.length ?? 0;
  const chatRef = engine.agent?.config?.models?.chat;
  const chatRefStr = typeof chatRef === "object" ? JSON.stringify(chatRef) : (chatRef || "(empty)");
  let reason;
  if (availableCount === 0) {
    reason = "available models list is empty (no provider has valid api_key + models)";
  } else if (!chatRef) {
    reason = `agent.config.models.chat is empty, but ${availableCount} models are available`;
  } else {
    reason = `models.chat=${chatRefStr} not found in ${availableCount} available models`;
  }
  log.warn(`⚠ 无可用模型，跳过 session 创建：${reason}`);
  dlog.warn("server", `session creation skipped: ${reason}`);
}

// ── 外部平台接入管理器 ──
let bridgeManager = null;
let bridgeManagerInitPromise = null;
let bridgeManagerInitError = null;
let bridgeAutoStartRequested = false;
let bridgeAutoStartDone = false;

function runBridgeAutoStart(manager: any) {
  if (!manager || bridgeAutoStartDone) return;
  bridgeAutoStartDone = true;
  manager.autoStart(engine.agents);
  dlog.log("server", "bridge autoStart done");
}

async function startBridgeManager({ autoStart = false } = {}) {
  if (autoStart) bridgeAutoStartRequested = true;
  if (bridgeManager) {
    if (autoStart) runBridgeAutoStart(bridgeManager);
    return bridgeManager;
  }
  if (bridgeManagerInitPromise) return bridgeManagerInitPromise;

  bridgeManagerInitError = null;
  bridgeManagerInitPromise = (async () => {
    log.log("Bridge manager 初始化...");
    const { BridgeManager } = await import("../lib/bridge/bridge-manager.ts");
    const manager = new BridgeManager({ engine, hub });
    bridgeManager = manager;
    hub.bridgeManager = manager;
    if (bridgeAutoStartRequested) runBridgeAutoStart(manager);
    log.log("Bridge manager 初始化完成");
    return manager;
  })().catch((err) => {
    bridgeManagerInitError = err;
    hub.bridgeManager = null;
    log.error(`Bridge manager 初始化失败: ${err.message}`);
    dlog.error("server", `bridge init failed: ${err.stack || err.message}`);
    return null;
  }).finally(() => {
    bridgeManagerInitPromise = null;
  });

  return bridgeManagerInitPromise;
}

const bridgeManagerRef = {
  get: () => bridgeManager,
  ensureReady: () => startBridgeManager(),
  getState: () => ({
    ready: !!bridgeManager,
    initializing: !!bridgeManagerInitPromise,
    error: bridgeManagerInitError?.message || null,
  }),
};

const { restRoute: chatRestRoute, wsRoute: chatWsRoute } = createChatRoute(engine, hub, { upgradeWebSocket });
app.route("", createMobileStaticRoute({ distDir: fromRoot("desktop", "dist-renderer") }));
app.route("", createHtmlPreviewRoute());
app.route("/api", chatRestRoute);
app.route("", chatWsRoute);
app.route("/api", createWebSocketAuthRoute({ ticketService: wsTicketService }));
app.route("/api", createWebAuthRoute({
  hanakoHome: engine.hanakoHome,
  authService: serverAuthService,
  getConnectionKind: (c: any) => c.get("transportConnectionKind"),
  getRuntimeContext: () => engine.getRuntimeContext(),
} as any));
app.route("/api", createAccessRoute({
  engine,
  runtimeState: serverRuntimeState,
} as any));
app.route("/api", createSessionsRoute(engine, hub));
app.route("/api", createSessionProjectsRoute(engine));
app.route("/api", createModelsRoute(engine));
app.route("/api", createConfigRoute(engine));
app.route("/api", createUploadRoute(engine));
app.route("/api", createProvidersRoute(engine));
app.route("/api", createAvatarRoute(engine));
app.route("/api", createAgentsRoute(engine));
app.route("/api", createDevicesRoute(engine));
app.route("/api", createCharacterCardsRoute(engine));
app.route("/api", createDeskRoute(engine, hub));
app.route("/api", createMobileWorkbenchRoute(engine));
app.route("/api", createStudioWorkspacesRoute(engine));
app.route("/api", createSkillsRoute(engine));
app.route("/api", createFsRoute(engine));
app.route("/api", createPreferencesRoute(engine));
app.route("/api", createSettingsSnapshotRoute(engine, {
  bridgeManagerRef,
  runtimeState: serverRuntimeState,
}));
app.route("/api", createExperimentsRoute(engine));
app.route("/api", createBridgeRoute(engine, bridgeManagerRef));
app.route("/api", createAuthRoute(engine));
app.route("/api", createDiaryRoute(engine));
app.route("/api", createConfirmRoute(confirmStore, engine));
app.route("/api", createMediaRoute(engine));
app.route("/api", createPluginsRoute(engine));
app.route("/api", createCheckpointsRoute(engine));
app.route("/api", createCommandsRoute(engine));
app.route("/api", createResourcesRoute(engine));
app.route("/api", createUsageRoute(engine));
app.route("/api", createSpeechRecognitionRoute(engine));
app.route("/api", createTerminalRoute(engine));
app.route("/api", createVscodeExtensionsRoute(engine));
app.route("/api", createServerIdentityRoute({
  hanakoHome: engine.hanakoHome,
  appVersion,
  getRuntimeContext: () => engine.getRuntimeContext(),
} as any));
// internal-browser WS — see unified upgrade handler in server startup below

// 健康检查 + 身份信息
app.get("/api/health", async (c) => {
  // 检查自定义头像是否存在（避免前端 HEAD 请求 404）
  const avatars = {};
  for (const role of ['agent', 'user']) {
    const dir = path.join(role === 'user' ? engine.userDir : engine.agentDir, 'avatars');
    avatars[role] = false;
    try {
      const files = fs.readdirSync(dir);
      avatars[role] = files.some(f => /\.(png|jpe?g|webp)$/i.test(f));
    } catch {}
  }
  return c.json({
    status: "ok",
    version: appVersion,
    agentId: engine.currentAgentId || null,
    agent: engine.agentName,
    agentYuan: engine.agent?.config?.agent?.yuan || "hanako",
    user: engine.userName,
    model: engine.currentModel?.name,
    avatars,
    network: createServerRuntimeNetworkSummary(),
  });
});

activeFetch = app.fetch.bind(app);

// 前端日志上报（desktop 端把错误 POST 到 server 写进持久化日志）
app.post("/api/log", async (c) => {
  const { level, module, message } = await safeJson(c);
  if (!message) return c.json({ ok: false });
  const safeModule = redactLogLabel(module || "desktop");
  const safeMessage = redactLogText(message);
  if (level === "error") dlog.error(safeModule, safeMessage);
  else if (level === "warn") dlog.warn(safeModule, safeMessage);
  else dlog.log(safeModule, safeMessage);
  return c.json({ ok: true });
});

// Plan Mode（只读探索模式）
app.get("/api/plan-mode", async (c) => {
  return c.json({
    enabled: engine.planMode,
    mode: engine.permissionMode,
    accessMode: engine.accessMode,
    locked: false,
  });
});
app.post("/api/plan-mode", async (c) => {
  const { enabled, mode } = await safeJson(c);
  const result = mode ? engine.setSessionPermissionMode(mode) : engine.setPlanMode(!!enabled);
  return c.json({
    ok: result?.ok !== false,
    locked: false,
    enabled: engine.planMode,
    mode: engine.permissionMode,
    accessMode: engine.accessMode,
  });
});

app.get("/api/session-permission-mode", async (c) => {
  return c.json({
    mode: engine.permissionMode,
    accessMode: engine.accessMode,
    defaultMode: engine.getSessionPermissionModeDefault(),
  });
});

app.get("/api/session-thinking-level", async (c) => {
  const sessionPath = c.req.query("sessionPath") || null;
  const pendingNewSession = c.req.query("pendingNewSession") === "1";
  return c.json(resolveSessionThinkingLevelState(engine, { sessionPath, pendingNewSession }));
});

app.post("/api/session-thinking-level", async (c) => {
  const { sessionPath, level } = await safeJson(c);
  const result = sessionPath
    ? await engine.setSessionThinkingLevel(sessionPath, level)
    : await engine.setDefaultThinkingLevel(level);
  if (result?.ok === false) {
    return c.json({
      ok: false,
      error: result.error || "failed to set thinking level",
      ...resolveSessionThinkingLevelState(engine, { sessionPath, pendingNewSession: !sessionPath }),
    }, 409);
  }
  return c.json({
    ok: true,
    ...resolveSessionThinkingLevelState(engine, { sessionPath, pendingNewSession: !sessionPath }),
  });
});

app.post("/api/session-permission-mode", async (c) => {
  const { mode, pendingNewSession, currentSessionOnly, sessionPath } = await safeJson(c);
  const targetSessionPath = typeof sessionPath === "string" && sessionPath ? sessionPath : null;
  const result = currentSessionOnly === true
    ? engine.setCurrentSessionPermissionMode(mode)
    : pendingNewSession === true
    ? engine.setPendingSessionPermissionMode(mode)
    : targetSessionPath
    ? engine.setSessionPermissionModeForSession(targetSessionPath, mode)
    : engine.setSessionPermissionMode(mode);
  const explicitSession = currentSessionOnly === true || !!targetSessionPath;
  if (explicitSession && result?.ok === false) {
    return c.json({
      ok: false,
      error: result.error || "session permission mode requires an active session",
      mode: result.mode,
      accessMode: result.mode === "read_only" ? "read_only" : "operate",
      defaultMode: engine.getSessionPermissionModeDefault(),
    }, 409);
  }
  const scopedMode = pendingNewSession === true || explicitSession;
  return c.json({
    ok: result?.ok !== false,
    mode: scopedMode ? result?.mode : engine.permissionMode,
    accessMode: scopedMode
      ? (result?.mode === "read_only" ? "read_only" : "operate")
      : engine.accessMode,
    defaultMode: engine.getSessionPermissionModeDefault(),
  });
});

// 远程关闭（供 desktop 端复用 server 退出时调用，跨平台可靠的 graceful shutdown）
app.post("/api/shutdown", async (c) => {
  log.log("收到 HTTP shutdown 请求，正在清理...");
  // 异步执行，先返回响应
  setTimeout(() => gracefulShutdown(), 100);
  return c.json({ ok: true });
});

// ── 发布已绑定服务器 ──
try {
  // ── Internal browser control WS (raw ws) ──
  // WsTransport requires raw ws .on()/.off() event methods that Hono's WSContext
  // doesn't expose, so we handle /internal/browser via a standalone WebSocketServer.
  //
  // To avoid both handlers firing on the same upgrade request (which would corrupt
  // the socket), we pass injectWebSocket a proxy that filters out /internal/browser
  // upgrades before they reach Hono's handler.
  const browserWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/internal/browser") return; // let Hono handle it

    const transport = inferHttpConnectionKind({
      hostHeader: req.headers.host,
      remoteAddress: req.socket?.remoteAddress,
      networkMode: serverRuntimeState.mode,
    } as any);
    if (!transport.connectionKind) {
      socket.destroy();
      return;
    }

    const authPrincipal = serverAuthService.authenticateRequest({
      authorization: req.headers.authorization,
      queryToken: url.searchParams.get("token"),
      allowQueryToken: true,
      connectionKind: transport.connectionKind,
    });
    const authz = authPrincipal
      ? authorizeHttpRoute({ method: "GET", path: url.pathname, principal: authPrincipal })
      : null;
    if (!authPrincipal || !authz?.allowed) {
      socket.destroy();
      return;
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => {
      browserWss.emit("connection", ws, req);
    });
  });

  browserWss.on("connection", (ws) => {
    const bm = BrowserManager.instance();
    bm.setWsTransport(ws);

    // 调试：记录浏览器 WS 消息往返（异步写入 + 缓冲，仅 HANA_DEBUG=1 时启用）
    const _bwsEnabled = process.env.HANA_DEBUG === "1";
    let _bwsBuf = "";
    let _bwsFlushTimer = null;
    const _bwsLogPath = path.join(hanakoHome, "browser-ws.log");
    let _bwsFlushChain = Promise.resolve();
    const _bwsFlush = () => {
      if (!_bwsBuf) return;
      const chunk = _bwsBuf;
      _bwsBuf = "";
      _bwsFlushTimer = null;
      _bwsFlushChain = _bwsFlushChain.then(() =>
        fs.promises.appendFile(_bwsLogPath, chunk)
      ).catch(() => {});
    };
    const _bwsLog = (line: any) => {
      if (!_bwsEnabled) return;
      _bwsBuf += `${new Date().toISOString()} ${line}\n`;
      if (!_bwsFlushTimer) _bwsFlushTimer = setTimeout(_bwsFlush, 500);
    };
    _bwsLog("browser WS connected");
    const origSend = ws.send.bind(ws);
    ws.send = function(data: any, ...args: any[]) {
      try { const m = JSON.parse(data); _bwsLog(`→ cmd=${m.cmd || m.type} id=${m.id || "?"}`); } catch {}
      return origSend(data, ...args);
    };
    ws.on("message", (data) => {
      try { const m = JSON.parse(data); _bwsLog(`← type=${m.type} id=${m.id || "?"} error=${m.error || "none"}`); } catch {}
    });

    ws.on("close", () => {
      if (bm._transport?._ws === ws) bm.setWsTransport(null);
      log.log("Electron browser control WS disconnected");
    });
    ws.on("error", (err) => {
      log.error(`Electron browser control WS error: ${err.message}`);
      if (bm._transport?._ws === ws) bm.setWsTransport(null);
    });
    log.log("Electron browser control WS connected");
  });

  // Inject Hono WS for chat and other WS routes, but skip /internal/browser
  // to prevent double-handling the same upgrade request
  injectWebSocket({
    on(event: any, handler: any) {
      if (event === "upgrade") {
        server.on("upgrade", (req: any, socket: any, head: any) => {
          const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
          if (url.pathname === "/internal/browser") return; // already handled above
          handler(req, socket, head);
        });
      } else {
        server.on(event, handler);
      }
    },
  } as any);

  const address: any = server.address();
  const actualPort = address.port;
  serverRuntimeState.actualPort = actualPort;

  log.log(`HanaIDE Server 运行在 http://${host}:${actualPort}`);
  dlog.log("server", `listening on :${actualPort}`);

  // 写 server-info 文件，供 Electron 检测复用或外部工具查询。
  // 文件含 128-bit loopback SERVER_TOKEN (本机最高权限凭据)，
  // 必须 owner-only 可读 (0o600)，否则共享主机上的另一 UID / 沙箱外的
  // 非授权进程能读到 token 后冒充 owner 调任意 LOCAL_ONLY 路由。
  const serverInfoPath = path.join(hanakoHome, "server-info.json");
  try {
    const runtimeContext = engine.getRuntimeContext?.() || {};
    fs.writeFileSync(serverInfoPath, JSON.stringify({
      pid: process.pid,
      port: actualPort,
      host,
      configuredHost: serverRuntimeState.listenHost,
      networkMode: serverRuntimeState.mode,
      configuredMode: serverRuntimeState.configuredMode,
      configuredListenHost: serverRuntimeState.configuredListenHost,
      configuredPort: serverRuntimeState.configuredPort,
      network: createServerRuntimeNetworkSummary(),
      token: SERVER_TOKEN,
      version: appVersion,
      ownerKind: process.env.HANA_SERVER_OWNER === "desktop" ? "desktop" : "standalone",
      ownerPid: Number.parseInt(process.env.HANA_SERVER_OWNER_PID || "", 10) || null,
      serverId: runtimeContext.serverId || null,
      serverNodeId: runtimeContext.serverNodeId || runtimeContext.serverId || null,
      studioId: runtimeContext.studioId || null,
      userId: runtimeContext.userId || null,
    }), { mode: 0o600 });
    // mode-on-create 在某些 fs 上不可靠（已有文件不会重置 mode），显式 chmod 兜底
    try { fs.chmodSync(serverInfoPath, 0o600); } catch {}
  } catch (e) {
    log.error(`写入 server-info.json 失败: ${e.message}`);
  }

  // 通知就绪（server-info.json 已在上方写入，无需额外动作）
  log.log(`ready: port=${actualPort}`);

  // Bridge 平台依赖不属于 HTTP readiness 的前置条件。先让桌面端拿到
  // server-info，再在后台加载外部平台 adapter，避免 Windows 上依赖加载
  // 或杀毒扫描拖垮主启动握手。
  startBridgeManager({ autoStart: true });

  // Legacy explicit attach mode. Normal headless server runs stay quiet.
  if (process.stdin.isTTY && (process.argv.includes("--cli") || process.argv.includes("--chat"))) {
    startCLI({
      port: actualPort,
      token: SERVER_TOKEN,
      agentName: engine.agentName,
      userName: engine.userName,
    });
  }

} catch (err) {
  log.error(`启动失败: ${err.message}`);
  process.exit(1);
}

// 优雅退出（防止并发关闭，带超时保护）
let _shutting = false;
async function gracefulShutdown() {
  if (_shutting) return;
  _shutting = true;
  log.log("\n正在关闭...");
  dlog.log("server", "shutting down...");

  // 超时保护：15 秒内必须完成（含 memory final pass LLM 调用），否则强制退出
  const forceTimer = setTimeout(() => {
    log.error("关闭超时，强制退出");
    process.exit(1);
  }, 15000);
  forceTimer.unref();

  try {
    // 1. 先停止接受新请求
    server.close();
    log.log("HTTP server 已关闭");
    dlog.log("server", "HTTP server closed");

    // 2. 挂起浏览器（保留冷保存，重启后可恢复卡片）
    try {
      const { BrowserManager } = await import("../lib/browser/browser-manager.ts");
      const bm = BrowserManager.instance();
      for (const sp of bm.runningSessions) {
        await bm.suspendForSession(sp);
        log.log(`浏览器已挂起: ${sp}`);
      }
    } catch (e) {
      log.error(`浏览器挂起失败: ${e.message}`);
    }

    // 3. 停止外部平台
    bridgeManager?.stopAll();
    dlog.log("server", "bridge stopped");

    // 4. flush deferred result store（debounce 可能有未写盘的脏数据）
    engine.deferredResults?.dispose?.();

    // 5. 清理 Hub + 引擎（停 ticker → 等 tick 完成 → 关 DB → 清理 session）
    await hub.dispose();
    log.log("Hub + Engine 已清理");
    dlog.log("server", "hub + engine disposed");
  } catch (err) {
    log.error(`关闭出错: ${err.message}`);
    dlog.error("server", `shutdown error: ${err.message}`);
  }

  clearTimeout(forceTimer);
  try { fs.unlinkSync(path.join(hanakoHome, "server-info.json")); } catch {}
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
if (process.platform === "win32") process.on("SIGBREAK", gracefulShutdown);

// 全局未捕获错误（写入持久化日志，防止崩溃无痕）
let _stdoutBroken = false;
function _safeConsoleError(...args) {
  if (_stdoutBroken) return;
  try {
    console.error(...args);
  } catch {
    _stdoutBroken = true;
  }
}

process.on("uncaughtException", (err: any) => {
  if (err?.code === "EPIPE" || err?.code === "ERR_IPC_CHANNEL_CLOSED") {
    if (!_stdoutBroken) {
      _stdoutBroken = true;
      dlog.error("server", `stdout pipe broken (${err.code}), suppressing further console output`);
    }
    return;
  }
  dlog.error("server", `uncaughtException: ${err.message}`);
  _safeConsoleError("[server] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  dlog.error("server", `unhandledRejection: ${reason}`);
  _safeConsoleError("[server] unhandledRejection:", reason);
});
