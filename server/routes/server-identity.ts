import { Hono } from "hono";
import { createServerRuntimeContext, toServerIdentityResponse } from "../../core/server-runtime-context.ts";
import { readAuthPrincipal } from "../http/capability-guard.ts";

export function createServerIdentityRoute({ hanakoHome, appVersion = "?", getRuntimeContext }: { hanakoHome?: string; appVersion?: string; getRuntimeContext?: () => any } = {}) {
  const route = new Hono();

  route.get("/server/identity", (c) => {
    try {
      const runtimeContext = typeof getRuntimeContext === "function"
        ? getRuntimeContext()
        : createServerRuntimeContext({ hanakoHome, appVersion });
      return c.json(toServerIdentityResponse(
        contextForPrincipal(runtimeContext, readAuthPrincipal(c)),
        { appVersion },
      ));
    } catch (err: any) {
      return c.json({
        error: "invalid server identity registry",
        detail: err.message,
      }, 500);
    }
  });

  return route;
}

function contextForPrincipal(runtimeContext, principal) {
  if (!principal || principal.kind === "local_user") return runtimeContext;
  return {
    ...runtimeContext,
    connectionKind: principal.connectionKind || runtimeContext.connectionKind,
    trustState: principal.trustState || runtimeContext.trustState,
    authState: principal.kind === "device" ? "paired" : "user",
    credentialKind: principal.credentialKind || runtimeContext.credentialKind,
    platformAccountId: principal.platformAccountId ?? null,
    officialServiceKind: principal.officialServiceKind ?? null,
    userId: principal.userId || runtimeContext.userId,
    studioId: principal.studioId || runtimeContext.studioId,
    capabilities: capabilitiesForPrincipal(principal, runtimeContext.capabilities),
  };
}

function capabilitiesForPrincipal(principal, fallback = []) {
  const scopes = Array.isArray(principal?.scopes) ? principal.scopes : [];
  if (scopes.length === 0) return Array.isArray(fallback) ? [...fallback] : [];
  const out = new Set();
  for (const scope of scopes) {
    out.add(scope);
    if (scope === "chat") out.add("chat");
    else if (scope === "resources" || scope.startsWith("resources.")) out.add("resources");
    else if (scope === "files" || scope.startsWith("files.")) out.add("files");
    else if (scope === "tools" || scope.startsWith("tools.")) out.add("tools");
    else if (scope === "settings" || scope.startsWith("settings.")) out.add("settings");
  }
  return [...out];
}
