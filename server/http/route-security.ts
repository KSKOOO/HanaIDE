import { hasStudioOwnerScope } from "../../shared/access-scope-profiles.ts";

const AUTHENTICATED_ONLY = Object.freeze({ kind: "authenticated" });
const LOCAL_ONLY = Object.freeze({ kind: "local_only" });
const PUBLIC = Object.freeze({ kind: "public" });
const STUDIO_OWNER = Object.freeze({ kind: "studio_owner" });

/**
 * 宿主自有的 /api/plugins/* 一级命名空间。这些 id 下的子路径属于插件管理 API，
 * 永远不会被代理到插件 route app，也绝不接受 plugin surface 凭证。
 * server/routes/plugins.ts 的 iframe ticket 签发校验与这里共用同一份名单。
 */
export const PLUGIN_HOST_ROUTE_PLUGIN_IDS = Object.freeze(new Set([
  "config-schemas",
  "event-bus",
  "diagnostics",
  "dev",
  "marketplace",
  "install",
  "settings",
  "pages",
  "widgets",
  "ui-host-capabilities",
  "settings-tabs",
  "iframe-ticket",
  "theme.css",
]));

export function authorizeHttpRoute({ method, path, principal }) {
  const policy = classifyHttpRoute({ method, path });
  if (policy.kind === "public") {
    return allowed(policy);
  }
  if (isLocalOwnerPrincipal(principal)) {
    return allowed(policy);
  }
  if (policy.kind === "local_only") {
    return denied("local_only_route", 403, policy, {
      reason: "local_owner_required",
    });
  }
  if (policy.kind === "authenticated") {
    return principal ? allowed(policy) : denied("forbidden", 403, policy, {
      reason: "missing_principal",
    });
  }
  if (!principal) {
    return denied("forbidden", 403, policy, {
      reason: "missing_principal",
    });
  }
  if (policy.kind === "plugin_route") {
    if (isPluginSurfacePrincipal(principal) && principal.pluginId === policy.pluginId) {
      return allowed(policy);
    }
    if (isStudioOwnerPrincipal(principal)) {
      return allowed(policy);
    }
    return denied("plugin_route_forbidden", 403, policy, {
      reason: "plugin_route_requires_owner_or_matching_plugin_surface",
      pluginId: policy.pluginId,
    });
  }
  const scopes = Array.isArray(principal.scopes) ? principal.scopes : [];
  if (policy.kind === "studio_owner") {
    return isStudioOwnerPrincipal(principal)
      ? allowed(policy)
      : denied("studio_owner_required", 403, policy, {
        reason: "studio_owner_required",
      });
  }
  const required = policy.scope;
  if (scopeAllows(scopes, required)) {
    return allowed(policy);
  }
  return denied("insufficient_scope", 403, policy, {
    reason: "missing_required_scope",
    requiredScope: required,
  });
}

export function classifyHttpRoute({ method = "GET", path = "" } = {}) {
  const verb = String(method || "GET").toUpperCase();
  const routePath = normalizePath(path);

  if (isMobileStaticRoute(verb, routePath)) return PUBLIC;
  if (isWebAuthBootstrapRoute(verb, routePath)) return PUBLIC;
  if (isMcpOAuthCallbackRoute(verb, routePath)) return PUBLIC;
  if (isHtmlPreviewDocumentRoute(verb, routePath)) return PUBLIC;

  if (routePath === "/api/health") return AUTHENTICATED_ONLY;
  if (routePath === "/api/server/identity") return AUTHENTICATED_ONLY;
  if (routePath === "/api/ws-ticket") return verb === "POST" ? scoped("chat") : LOCAL_ONLY;
  if (isClientLocalOnlyRoute(verb, routePath)) return LOCAL_ONLY;

  if (routePath === "/ws") return scoped("chat");
  if (routePath === "/api/mobile/bootstrap") {
    return verb === "GET" ? scoped("chat") : LOCAL_ONLY;
  }
  if (isAvatarReadRoute(verb, routePath)) return scoped("chat");
  if (isAvatarWriteRoute(verb, routePath)) return scoped("settings.write");
  if (isAvatarRoutePath(routePath)) return LOCAL_ONLY;
  if (isWorkbenchFileReadRoute(verb, routePath)) return scoped("files.read");
  if (isWorkbenchFileWriteRoute(verb, routePath)) return scoped("files.write");
  if (isStudioWorkspaceReadRoute(verb, routePath)) return scoped("files.read");
  if (isStudioWorkspaceWriteRoute(verb, routePath)) return scoped("files.write");
  if (isVscodeExtensionReadRoute(verb, routePath)) return scoped("settings.read");
  if (isVscodeExtensionLocalOnlyRoute(verb, routePath)) return LOCAL_ONLY;
  if (routePath === "/api/preferences/quick-chat") return LOCAL_ONLY;
  if (routePath === "/api/preferences/workspace-ui-state") {
    if (verb === "GET") return scoped("files.read");
    if (verb === "PUT") return scoped("files.write");
    return LOCAL_ONLY;
  }
  if (routePath === "/api/preview/html") {
    return verb === "POST" ? scoped("files.read") : LOCAL_ONLY;
  }
  if (isDeskFileReadRoute(verb, routePath)) return scoped("files.read");
  if (isDeskFileWriteRoute(verb, routePath)) return scoped("files.write");
  if (routePath === "/api/usage/llm") return verb === "GET" ? STUDIO_OWNER : LOCAL_ONLY;
  if (routePath === "/api/session-projects" || routePath.startsWith("/api/session-projects/")) {
    return scoped("chat");
  }
  if (routePath === "/api/preferences/sidebar-ui") {
    return (verb === "GET" || verb === "PUT") ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/preferences/session-permission-default") {
    return (verb === "GET" || verb === "PUT") ? scoped("chat") : LOCAL_ONLY;
  }
  if (isSettingsReadRoute(verb, routePath)) return scoped("settings.read");
  if (isSettingsWriteRoute(verb, routePath)) return scoped("settings.write");
  if (isSkillSettingsReadRoute(verb, routePath)) return scoped("settings.read");
  if (isSkillSettingsWriteRoute(verb, routePath)) return scoped("settings.write");
  if (isMcpSettingsReadRoute(verb, routePath)) return scoped("settings.read");
  if (isMcpSettingsWriteRoute(verb, routePath)) return scoped("settings.write");
  if (isMediaSubmitRoute(verb, routePath)) return scoped("chat");
  if (isImageGenerationReadRoute(verb, routePath)) return scoped("settings.read");
  if (isImageGenerationWriteRoute(verb, routePath)) return scoped("settings.write");
  if (isImageGenerationProviderManagementRoute(verb, routePath)) return scoped("providers.manage");
  if (isPluginSettingsReadRoute(verb, routePath)) return scoped("settings.read");
  if (isPluginSettingsWriteRoute(verb, routePath)) return scoped("settings.write");
  if (isProviderManagementRoute(verb, routePath)) return scoped("providers.manage");
  if (isBridgeManagementRoute(verb, routePath)) return scoped("bridge.manage");
  if (isPluginAssetReadRoute(verb, routePath)) return scoped("chat");
  if (isPluginUiReadRoute(verb, routePath)) return scoped("chat");
  if (verb === "POST" && routePath === "/api/plugins/iframe-ticket") return scoped("chat");
  if (verb === "POST" && /^\/api\/resources\/[^/]+\/ticket$/.test(routePath)) {
    return scoped("resources.read");
  }
  if (routePath.startsWith("/api/resources/")) {
    if (verb === "GET" || verb === "HEAD") return scoped("resources.read");
    return scoped("resources.write");
  }
  if (routePath === "/api/sessions" || routePath.startsWith("/api/sessions/")) {
    return scoped("chat");
  }
  if (routePath === "/api/models") {
    return verb === "GET" ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/models/auxiliary-vision") {
    return verb === "GET" ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/models/set" || routePath === "/api/models/switch") {
    return verb === "POST" ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/session-permission-mode") {
    return (verb === "GET" || verb === "POST") ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/session-thinking-level") {
    return (verb === "GET" || verb === "POST") ? scoped("chat") : LOCAL_ONLY;
  }
  if (/^\/api\/confirm\/[^/]+$/.test(routePath)) {
    return verb === "POST" ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/browser/session-states") {
    return verb === "GET" ? scoped("chat") : LOCAL_ONLY;
  }
  if (routePath === "/api/upload-blob") {
    return verb === "POST" ? scoped("files.write") : LOCAL_ONLY;
  }
  if (routePath === "/api/chat" || routePath.startsWith("/api/chat/")) {
    return scoped("chat");
  }
  if (isStandaloneChannelRoute(routePath)) return LOCAL_ONLY;

  const pluginRoute = classifyPluginRouteProxyPath(routePath);
  if (pluginRoute) return pluginRoute;

  if (routePath.startsWith("/api/")) return STUDIO_OWNER;

  return LOCAL_ONLY;
}

/**
 * 插件 route 代理路径：/api/plugins/:pluginId/<subPath>，排除宿主自有 id。
 * 必须在所有更具体的 /api/plugins/* 匹配器（settings / mcp / image-gen /
 * assets / dev / iframe-ticket 等）之后调用，那些路径保持原有 scope 策略。
 */
function classifyPluginRouteProxyPath(routePath) {
  const match = /^\/api\/plugins\/([^/]+)\/.+$/.exec(routePath);
  if (!match) return null;
  let pluginId;
  try {
    pluginId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!pluginId || PLUGIN_HOST_ROUTE_PLUGIN_IDS.has(pluginId)) return null;
  return Object.freeze({ kind: "plugin_route", pluginId });
}

export function isPluginSurfacePrincipal(principal) {
  if (!principal || typeof principal !== "object") return false;
  return principal.kind === "plugin"
    && principal.credentialKind === "plugin_surface_session"
    && typeof principal.pluginId === "string"
    && principal.pluginId.length > 0;
}

export function isPublicHttpRoute({ method = "GET", path = "" } = {}) {
  return classifyHttpRoute({ method, path }).kind === "public";
}

export function isLocalOwnerPrincipal(principal) {
  if (!principal || typeof principal !== "object") return false;
  return principal.kind === "local_user"
    && principal.connectionKind === "local"
    && principal.credentialKind === "loopback_token";
}

export function isStudioOwnerPrincipal(principal) {
  if (isLocalOwnerPrincipal(principal)) return true;
  if (!principal || typeof principal !== "object") return false;
  const scopes = Array.isArray(principal.scopes) ? principal.scopes : [];
  return hasStudioOwnerScope(scopes);
}

function scoped(scope) {
  return Object.freeze({ kind: "scope", scope });
}

function allowed(policy) {
  return { allowed: true, policy };
}

function denied(error, status, policy, details = {}) {
  return { allowed: false, error, status, policy, ...details };
}

function normalizePath(path) {
  const raw = String(path || "");
  try {
    return new URL(raw, "http://hana.local").pathname;
  } catch {
    return raw.split("?")[0] || "/";
  }
}

function isAvatarRoutePath(routePath) {
  return routePath === "/api/avatar/agent"
    || routePath === "/api/avatar/user"
    || /^\/api\/agents\/[^/]+\/avatar$/.test(routePath);
}

function isAvatarReadRoute(verb, routePath) {
  return (verb === "GET" || verb === "HEAD") && isAvatarRoutePath(routePath);
}

function isAvatarWriteRoute(verb, routePath) {
  return (verb === "POST" || verb === "DELETE") && isAvatarRoutePath(routePath);
}

export function scopeAllows(scopes, required) {
  if (!required) return true;
  if (scopes.includes(required)) return true;
  const [namespace] = required.split(".");
  return scopes.includes(namespace) || scopes.includes(`${namespace}.*`);
}

function isMobileStaticRoute(verb, routePath) {
  if (verb !== "GET" && verb !== "HEAD") return false;
  return isWebClientStaticRoute(routePath, "/mobile")
    || isWebClientStaticRoute(routePath, "/desktop")
    || isWebClientStaticRoute(routePath, "/app");
}

function isWebClientStaticRoute(routePath, prefix) {
  return routePath === prefix
    || routePath === `${prefix}/`
    || routePath === `${prefix}/index.html`
    || routePath === `${prefix}/manifest.webmanifest`
    || routePath === `${prefix}/sw.js`
    || routePath === `${prefix}/icon.png`
    || routePath.startsWith(`${prefix}/assets/`)
    || routePath.startsWith(`${prefix}/lib/`)
    || routePath.startsWith(`${prefix}/modules/`)
    || routePath.startsWith(`${prefix}/themes/`)
    || routePath.startsWith(`${prefix}/locales/`)
    || routePath.startsWith(`${prefix}/icons/`);
}

function isWebAuthBootstrapRoute(verb, routePath) {
  if (routePath === "/api/web-auth/login") return verb === "POST";
  if (routePath === "/api/web-auth/session") return verb === "GET";
  if (routePath === "/api/web-auth/logout") return verb === "POST";
  return false;
}

function isMcpOAuthCallbackRoute(verb, routePath) {
  return verb === "GET" && routePath === "/api/plugins/mcp/oauth/callback";
}

function isHtmlPreviewDocumentRoute(verb, routePath) {
  if (verb !== "GET" && verb !== "HEAD") return false;
  return /^\/preview\/html\/[^/]+(?:\/assets\/[^/]+\/.+)?$/.test(routePath);
}

function isClientLocalOnlyRoute(verb, routePath) {
  if (routePath === "/api/shutdown") return true;
  if (routePath.startsWith("/api/access/")) return true;
  if (routePath.startsWith("/api/devices/")) return true;
  if (routePath === "/api/skills/external-paths") return true;
  if (routePath === "/api/plugins/install") return true;
  if (routePath.startsWith("/api/plugins/dev/") || routePath === "/api/plugins/dev") return true;
  if (routePath === "/api/preferences/computer-use/request-permissions") return true;
  if (routePath.startsWith("/api/plugins/image-gen/media/open/")) return true;
  if (routePath.startsWith("/api/media/generated/open/")) return true;
  if (/^\/api\/plugins\/[^/]+\/assets\/.+$/.test(routePath) && verb !== "GET" && verb !== "HEAD") {
    return true;
  }
  return false;
}

function isSettingsReadRoute(verb, routePath) {
  if (verb !== "GET") return false;
  return routePath === "/api/config"
    || routePath === "/api/settings/snapshot"
    || routePath === "/api/plugins/settings"
    || routePath === "/api/plugins/settings-tabs"
    || routePath === "/api/providers/summary"
    || routePath === "/api/preferences/models"
    || routePath === "/api/preferences/appearance"
    || routePath === "/api/speech-recognition/providers"
    || routePath === "/api/experiments"
    || routePath === "/api/experiments/memory/cache-snapshot-reflection/observation"
    || routePath === "/api/bridge/status"
    || routePath === "/api/agents"
    || routePath === "/api/user-profile"
    || routePath === "/api/memories"
    || routePath === "/api/memories/health"
    || routePath === "/api/memories/compiled"
    || routePath === "/api/memories/export"
    || routePath === "/api/preferences/notifications"
    || routePath === "/api/preferences/computer-use"
    || /^\/api\/agents\/[^/]+\/(?:identity|ishiki|public-ishiki|pinned|experience)$/.test(routePath)
    || /^\/api\/agents\/[^/]+\/config$/.test(routePath);
}

function isWorkbenchFileReadRoute(verb, routePath) {
  if (verb !== "GET" && verb !== "HEAD") return false;
  if (routePath === "/api/mobile/workbench/files" || routePath === "/api/mobile/workbench/search") {
    return verb === "GET";
  }
  if (routePath === "/api/workbench/files" || routePath === "/api/workbench/search") {
    return verb === "GET";
  }
  return routePath === "/api/mobile/workbench/content"
    || routePath === "/api/workbench/content";
}

function isWorkbenchFileWriteRoute(verb, routePath) {
  if (verb !== "POST") return false;
  return routePath === "/api/mobile/workbench/actions"
    || routePath === "/api/mobile/workbench/upload"
    || routePath === "/api/workbench/actions"
    || routePath === "/api/workbench/upload";
}

function isStudioWorkspaceReadRoute(verb, routePath) {
  if (verb !== "GET" && verb !== "HEAD") return false;
  return routePath === "/api/studio/workspaces"
    || /^\/api\/studio\/workspaces\/[^/]+\/files$/.test(routePath);
}

function isStudioWorkspaceWriteRoute(verb, routePath) {
  if (verb === "POST") return routePath === "/api/studio/workspaces";
  if (verb === "DELETE") return /^\/api\/studio\/workspaces\/[^/]+$/.test(routePath);
  return false;
}

function isVscodeExtensionReadRoute(verb, routePath) {
  if (verb !== "GET") return false;
  return routePath === "/api/vscode-extensions"
    || routePath === "/api/vscode-extensions/gallery/search"
    || routePath === "/api/vscode-extensions/runtime/commands";
}

function isVscodeExtensionLocalOnlyRoute(verb, routePath) {
  if (verb === "POST" && (
    routePath === "/api/vscode-extensions/install"
    || routePath === "/api/vscode-extensions/gallery/install"
    || routePath === "/api/vscode-extensions/runtime/start"
  )) return true;
  if (verb === "PUT" && /^\/api\/vscode-extensions\/[^/]+\/enabled$/.test(routePath)) return true;
  if (verb === "POST" && /^\/api\/vscode-extensions\/runtime\/commands\/[^/]+$/.test(routePath)) return true;
  return false;
}

function isStandaloneChannelRoute(routePath) {
  return routePath === "/api/channels"
    || routePath.startsWith("/api/channels/")
    || routePath.startsWith("/api/conversations/")
    || routePath === "/api/dm"
    || routePath.startsWith("/api/dm/");
}

function isDeskFileReadRoute(verb, routePath) {
  if (verb !== "GET") return false;
  return routePath === "/api/desk/path"
    || routePath === "/api/desk/files"
    || routePath === "/api/desk/search-files"
    || routePath === "/api/desk/jian"
    || routePath === "/api/desk/beautify/status";
}

function isDeskFileWriteRoute(verb, routePath) {
  if (verb !== "POST") return false;
  return routePath === "/api/desk/files"
    || routePath === "/api/desk/jian"
    || routePath === "/api/desk/beautify/cover"
    || routePath === "/api/desk/beautify/cover/apply"
    || routePath === "/api/desk/beautify/cover/preset/apply";
}

function isSettingsWriteRoute(verb, routePath) {
  if (verb === "POST" && routePath === "/api/preferences/setup-complete") return true;
  if (verb === "PATCH" && /^\/api\/experiments\/[^/]+$/.test(routePath)) return true;
  if (verb === "DELETE" && routePath === "/api/experiments/memory/cache-snapshot-reflection/observation") return true;
  return (verb === "PUT" && (
    routePath === "/api/config"
    || routePath === "/api/user-profile"
    || routePath === "/api/preferences/models"
    || routePath === "/api/preferences/appearance"
    || routePath === "/api/preferences/notifications"
    || routePath === "/api/preferences/computer-use"
    || routePath === "/api/speech-recognition/config"
    || /^\/api\/agents\/[^/]+\/(?:identity|ishiki|public-ishiki|pinned|experience)$/.test(routePath)
    || /^\/api\/agents\/[^/]+\/config$/.test(routePath)
  ))
    || (verb === "DELETE" && (
      routePath === "/api/memories"
      || routePath === "/api/memories/compiled"
    ))
    || (verb === "POST" && routePath === "/api/memories/import");
}

function isSkillSettingsReadRoute(verb, routePath) {
  if (verb !== "GET") return false;
  return routePath === "/api/skills"
    || routePath === "/api/skills/bundles";
}

function isSkillSettingsWriteRoute(verb, routePath) {
  return (verb === "PUT" && (
    /^\/api\/agents\/[^/]+\/skills$/.test(routePath)
    || routePath === "/api/skills/bundles/order"
    || /^\/api\/skills\/bundles\/[^/]+$/.test(routePath)
  ))
    || (verb === "PATCH" && (
      /^\/api\/agents\/[^/]+\/skills\/[^/]+$/.test(routePath)
      || /^\/api\/agents\/[^/]+\/skill-bundles\/[^/]+$/.test(routePath)
    ))
    || (verb === "POST" && (
      routePath === "/api/skills/install"
      || routePath === "/api/skills/bundles"
      || /^\/api\/skills\/bundles\/[^/]+\/export$/.test(routePath)
    ))
    || (verb === "DELETE" && (
      /^\/api\/skills\/bundles\/[^/]+$/.test(routePath)
      || /^\/api\/skills\/[^/]+$/.test(routePath)
    ));
}

function isProviderManagementRoute(verb, routePath) {
  if (verb === "POST" && (
    routePath === "/api/providers/test"
    || routePath === "/api/providers/fetch-models"
  )) return true;
  if (
    (verb === "GET" && (
      /^\/api\/providers\/[^/]+\/discovered-models$/.test(routePath)
      || /^\/api\/providers\/[^/]+\/api-key$/.test(routePath)
    ))
    || ((verb === "PUT" || verb === "DELETE") && /^\/api\/providers\/[^/]+\/models\/[^/]+$/.test(routePath))
  ) {
    return true;
  }
  return false;
}

function isBridgeManagementRoute(verb, routePath) {
  if (verb !== "POST") return false;
  return routePath === "/api/bridge/config"
    || routePath === "/api/bridge/settings"
    || routePath === "/api/bridge/owner"
    || routePath === "/api/bridge/stop"
    || routePath === "/api/bridge/test";
}

function isMcpSettingsReadRoute(verb, routePath) {
  if (verb !== "GET") return false;
  return routePath === "/api/plugins/mcp/state"
    || /^\/api\/plugins\/mcp\/oauth\/poll\/[^/]+$/.test(routePath);
}

function isMcpSettingsWriteRoute(verb, routePath) {
  if (verb === "PUT" && (routePath === "/api/plugins/mcp/settings/enabled" || routePath === "/api/plugins/mcp/enabled")) return true;
  if (verb === "POST" && (routePath === "/api/plugins/mcp/connectors" || routePath === "/api/plugins/mcp/servers")) return true;
  if ((verb === "PUT" || verb === "DELETE") && /^\/api\/plugins\/mcp\/(?:connectors|servers)\/[^/]+$/.test(routePath)) return true;
  if (verb === "POST" && /^\/api\/plugins\/mcp\/(?:connectors|servers)\/[^/]+\/(?:start|stop|refresh-tools)$/.test(routePath)) return true;
  if (verb === "PUT" && /^\/api\/plugins\/mcp\/agents\/[^/]+\/(?:connectors|servers)\/[^/]+$/.test(routePath)) return true;
  if (verb === "POST" && /^\/api\/plugins\/mcp\/(?:connectors|servers)\/[^/]+\/oauth\/(?:start|logout)$/.test(routePath)) return true;
  return false;
}

function isImageGenerationReadRoute(verb, routePath) {
  if (verb !== "GET" && verb !== "HEAD") return false;
  return routePath === "/api/media/providers"
    || routePath === "/api/media/image/providers"
    || routePath === "/api/media/tasks"
    || /^\/api\/media\/generated\/[^/]+$/.test(routePath)
    || /^\/api\/media\/tasks\/batch\/[^/]+$/.test(routePath)
    || /^\/api\/media\/tasks\/[^/]+$/.test(routePath)
    || routePath === "/api/plugins/image-gen/providers"
    || routePath === "/api/plugins/image-gen/tasks"
    || /^\/api\/plugins\/image-gen\/media\/[^/]+$/.test(routePath)
    || /^\/api\/plugins\/image-gen\/tasks\/batch\/[^/]+$/.test(routePath)
    || /^\/api\/plugins\/image-gen\/tasks\/[^/]+$/.test(routePath);
}

function isMediaSubmitRoute(verb, routePath) {
  if (verb !== "POST") return false;
  return routePath === "/api/media/generate"
    || routePath === "/api/media/image/generate"
    || routePath === "/api/media/video/generate"
    || routePath === "/api/media/asr/transcribe";
}

function isImageGenerationWriteRoute(verb, routePath) {
  return verb === "PUT" && (
    routePath === "/api/media/image/config"
    || routePath === "/api/plugins/image-gen/config"
  );
}

function isImageGenerationProviderManagementRoute(verb, routePath) {
  return (verb === "POST" && /^\/api\/media\/image\/providers\/[^/]+\/models$/.test(routePath))
    || (verb === "DELETE" && /^\/api\/media\/image\/providers\/[^/]+\/models\/[^/]+$/.test(routePath))
    || (verb === "POST" && /^\/api\/media\/tasks\/[^/]+\/retry$/.test(routePath))
    || (verb === "POST" && /^\/api\/plugins\/image-gen\/providers\/[^/]+\/models$/.test(routePath))
    || (verb === "DELETE" && /^\/api\/plugins\/image-gen\/providers\/[^/]+\/models\/[^/]+$/.test(routePath))
    || (verb === "POST" && /^\/api\/plugins\/image-gen\/tasks\/[^/]+\/retry$/.test(routePath));
}

function isPluginSettingsReadRoute(verb, routePath) {
  if (verb !== "GET") return false;
  return routePath === "/api/plugins"
    || routePath === "/api/plugins/config-schemas"
    || routePath === "/api/plugins/event-bus/capabilities"
    || routePath === "/api/plugins/diagnostics"
    || routePath === "/api/plugins/marketplace"
    || /^\/api\/plugins\/marketplace\/[^/]+\/readme$/.test(routePath)
    || /^\/api\/plugins\/[^/]+\/config-schema$/.test(routePath)
    || /^\/api\/plugins\/[^/]+\/config$/.test(routePath);
}

function isPluginSettingsWriteRoute(verb, routePath) {
  return (verb === "PUT" && (
    routePath === "/api/plugins/settings"
    || /^\/api\/plugins\/[^/]+\/config$/.test(routePath)
    || /^\/api\/plugins\/[^/]+\/enabled$/.test(routePath)
  ))
    || (verb === "POST" && /^\/api\/plugins\/marketplace\/[^/]+\/install$/.test(routePath))
    || (verb === "DELETE" && /^\/api\/plugins\/[^/]+$/.test(routePath));
}

function isPluginUiReadRoute(verb, routePath) {
  if (verb !== "GET") return false;
  return routePath === "/api/plugins/pages"
    || routePath === "/api/plugins/widgets"
    || routePath === "/api/plugins/ui-host-capabilities"
    || routePath === "/api/plugins/theme.css";
}

function isPluginAssetReadRoute(verb, routePath) {
  if (verb !== "GET" && verb !== "HEAD") return false;
  return /^\/api\/plugins\/[^/]+\/assets\/.+$/.test(routePath);
}
