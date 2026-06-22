import fs from "fs/promises";
import path from "path";
import { Hono } from "hono";
import { readPinnedMemoryItems } from "../../lib/memory/pinned-memory-store.ts";
import { listExperienceDocuments } from "../../lib/tools/experience.ts";
import { createAccessSummary, getLanAddresses } from "./access.ts";
import { buildBridgeStatus } from "./bridge.ts";
import { buildComputerUsePreferences } from "./preferences.ts";
import { normalizeNotificationPreferences } from "../../shared/notification-preferences.ts";
import { normalizeQuickChatPreferences } from "../../shared/quick-chat-preferences.ts";
import { normalizeBrowserPreferences } from "../../shared/browser-preferences.ts";
import { normalizeSearchApiKeys, SEARCH_API_PROVIDER_IDS } from "../../shared/search-providers.ts";
import { maskSecretValue } from "../../shared/secret-custody.ts";
import { listResolvedExperiments } from "../../lib/experiments/registry.ts";
import { normalizeBridgePermissionMode } from "../../core/session-permission-mode.ts";
import { agentExists, validateId } from "../utils/validation.ts";
import { readAuthPrincipal } from "../http/capability-guard.ts";
import { isLocalOwnerPrincipal } from "../http/route-security.ts";
import { readUserProfile } from "../../lib/user-profile-store.ts";
import { buildSettingsConfigResponse } from "./settings-config-builder.ts";

function agentDir(engine: any, id: string) {
  return path.join(engine.agentsDir, id);
}

async function readTextFile(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

function readPinned(agentBaseDir: string) {
  return readPinnedMemoryItems(agentBaseDir).map(item => item.content);
}

function isExperienceEnabled(engine: any, id: string, config: Record<string, any>) {
  const agent = typeof engine.getAgent === "function" ? engine.getAgent(id) : null;
  if (typeof agent?.experienceEnabled === "boolean") return agent.experienceEnabled === true;
  return config.experience?.enabled === true;
}

function readExperience(engine: any, id: string, config: Record<string, any>) {
  if (!isExperienceEnabled(engine, id, config)) return "";
  try {
    const expDir = path.join(agentDir(engine, id), "experience");
    const docs = listExperienceDocuments(expDir).sort((a, b) => a.title.localeCompare(b.title));
    if (docs.length === 0) return "";
    return docs.map(doc => `# ${doc.title}\n${doc.body.trimEnd()}`).join("\n\n") + "\n";
  } catch (err: any) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

function maskSearchApiKeys(apiKeys: any) {
  const normalized = normalizeSearchApiKeys(apiKeys);
  return Object.fromEntries(
    SEARCH_API_PROVIDER_IDS.map(provider => [provider, maskSecretValue(normalized[provider] || "")]),
  );
}

function buildGlobalModels(engine: any) {
  const search = engine.getSearchConfig?.() || {};
  const utilityApi = engine.getUtilityApi?.() || {};
  return {
    models: engine.getSharedModels?.() || {},
    thinking_level: engine.getThinkingLevel?.() || "medium",
    search: {
      provider: search.provider || "",
      api_key: maskSecretValue(search.api_key || ""),
      api_keys: maskSearchApiKeys(search.api_keys || {}),
    },
    utility_api: {
      provider: utilityApi.provider || "",
      base_url: utilityApi.base_url || "",
      api_key: maskSecretValue(utilityApi.api_key || ""),
    },
  };
}

function resolveSnapshotAgentId(engine: any, rawAgentId: string | undefined) {
  const id = rawAgentId || engine.currentAgentId || engine.getPrimaryAgent?.() || engine.listAgents?.()[0]?.id;
  if (!id || !validateId(id) || !agentExists(engine, id)) {
    throw new Error("settings snapshot agent not found");
  }
  return id;
}

function buildPluginSettings(engine: any, canSeeLocalPaths: boolean) {
  const pm = engine.pluginManager;
  return {
    allowFullAccess: pm?.getAllowFullAccess?.() || false,
    devToolsEnabled: engine.getPluginDevToolsEnabled?.() || false,
    userDir: canSeeLocalPaths ? (pm?.getUserPluginsDir?.() || "") : "",
    settingsTabs: pm?.getSettingsTabs?.().map((tab: any) => ({
      pluginId: tab.pluginId,
      id: tab.id,
      title: tab.title,
      icon: tab.icon,
      nativeComponent: tab.nativeComponent,
    })) || [],
  };
}

function buildBridgePreferences(engine: any) {
  const permissionMode = engine.getBridgePermissionMode?.()
    || normalizeBridgePermissionMode({ readOnly: engine.getBridgeReadOnly?.() });
  return {
    permissionMode,
    readOnly: engine.getBridgeReadOnly?.() === true,
    receiptEnabled: engine.getBridgeReceiptEnabled?.() !== false,
    richStreamingEnabled: engine.getBridgeRichStreamingEnabled?.() !== false,
  };
}

function resolveBridgeManager(ref: any) {
  if (!ref) return null;
  if (typeof ref.get === "function") return ref.get() || null;
  return ref;
}

function buildAccessSnapshot(engine: any, canSeeLocalPaths: boolean, options: Record<string, any>) {
  if (!canSeeLocalPaths || !engine?.hanakoHome) return null;
  return createAccessSummary(
    engine,
    options.runtimeState || {},
    options.listLanAddresses || getLanAddresses,
  );
}

export function createSettingsSnapshotRoute(engine: any, options: Record<string, any> = {}) {
  const route = new Hono();

  route.get("/settings/snapshot", async (c) => {
    try {
      const agentId = resolveSnapshotAgentId(engine, c.req.query("agentId"));
      const baseDir = agentDir(engine, agentId);
      const config = await buildSettingsConfigResponse(engine, {
        kind: "agent",
        agentId,
        includeProviderHeaders: false,
      });
      const runtimeAgent = engine.getAgent?.(agentId);
      const snapshotAgent = runtimeAgent?.config
        ? runtimeAgent
        : { ...(runtimeAgent || {}), id: agentId, config };
      const [identity, ishiki, publicIshiki] = await Promise.all([
        readTextFile(path.join(baseDir, "identity.md")),
        readTextFile(path.join(baseDir, "ishiki.md")),
        readTextFile(path.join(baseDir, "public-ishiki.md")),
      ]);
      const canSeeLocalPaths = isLocalOwnerPrincipal(readAuthPrincipal(c));
      return c.json({
        agentId,
        config,
        identity,
        ishiki,
        publicIshiki,
        userProfile: await readUserProfile(engine.userDir),
        experience: readExperience(engine, agentId, config),
        pinned: { pins: readPinned(baseDir) },
        globalModels: buildGlobalModels(engine),
        preferences: {
          quickChat: engine.getQuickChatPreferences?.() || normalizeQuickChatPreferences({}),
          browser: engine.getBrowserPreferences?.() || normalizeBrowserPreferences({}),
          notifications: engine.getNotificationPreferences?.() || normalizeNotificationPreferences({}),
          bridge: buildBridgePreferences(engine),
          computerUse: await buildComputerUsePreferences(engine, {
            platform: options.platform || process.platform,
          }),
          imageGeneration: engine.media?.getImageConfig?.() || engine.preferences?.getImageGenerationConfig?.() || {},
          speechRecognition: engine.speechRecognition?.getConfig?.() || engine.getSpeechRecognitionConfig?.() || { enabled: false },
          experiments: listResolvedExperiments(engine.preferences),
        },
        access: buildAccessSnapshot(engine, canSeeLocalPaths, options),
        bridgeStatus: snapshotAgent
          ? buildBridgeStatus(engine, resolveBridgeManager(options.bridgeManagerRef), snapshotAgent)
          : null,
        plugins: buildPluginSettings(engine, canSeeLocalPaths),
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
