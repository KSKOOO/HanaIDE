import fs from "fs/promises";
import path from "path";
import YAML from "js-yaml";
import { injectGlobalFields } from "../../shared/config-scope.ts";
import { computeSettingsAvailableToolNames } from "../../shared/tool-categories.ts";
import { maskProviderHeaders } from "../../shared/provider-auth.ts";
import { maskObjectSecrets, maskSecretValue } from "../../shared/secret-custody.ts";

type BuildSettingsConfigOptions = {
  kind: "current" | "agent";
  agentId?: string;
  rawConfig?: Record<string, any>;
  includeAvailableTools?: boolean;
  includeProviderHeaders?: boolean;
};

function agentDir(engine: any, id: string) {
  return path.join(engine.agentsDir, id);
}

export function normalizeExperienceConfigForResponse(config: Record<string, any>) {
  const current = (config.experience && typeof config.experience === "object" && !Array.isArray(config.experience))
    ? config.experience
    : {};
  config.experience = {
    ...current,
    enabled: current.enabled === true,
  };
}

export function buildRawConfigBlocks(raw: Record<string, any> = {}) {
  return {
    api: { provider: raw.api?.provider || "", base_url: raw.api?.base_url || "" },
    embedding_api: { provider: raw.embedding_api?.provider || "", base_url: raw.embedding_api?.base_url || "" },
    utility_api: { provider: raw.utility_api?.provider || "", base_url: raw.utility_api?.base_url || "" },
  };
}

export function buildProviderSummary(engine: any, options: { includeHeaders?: boolean } = {}) {
  try {
    const rawProviders = engine.providerRegistry?.getAllProvidersRaw?.() || {};
    const providerEntries: Record<string, any> = {};
    for (const [name, p] of Object.entries(rawProviders) as [string, any][]) {
      const entry = engine.providerRegistry?.get?.(name);
      providerEntries[name] = {
        base_url: p.base_url || entry?.baseUrl || "",
        api: p.api || entry?.api || "",
        api_key: maskSecretValue(p.api_key || ""),
        models: p.models || [],
        model_count: (p.models || []).length,
      };
      if (options.includeHeaders !== false) {
        providerEntries[name].headers = maskProviderHeaders(p.headers || {});
      }
    }
    return providerEntries;
  } catch {
    return {};
  }
}

function hideDisabledGlobalToolsForSettings(toolNames: string[], engine: any) {
  const computerUseEnabled = engine?.getComputerUseSettings?.()?.enabled === true;
  if (computerUseEnabled) return toolNames;
  return (toolNames || []).filter((name) => name !== "computer");
}

export function buildSettingsAvailableTools(engine: any, agentId?: string) {
  const agent = agentId && typeof engine.getAgent === "function"
    ? engine.getAgent(agentId)
    : typeof engine.getAgent === "function"
      ? engine.getAgent(engine.currentAgentId)
      : null;
  const pluginTools = engine.pluginManager?.getAllTools?.() || [];
  const runtimeToolNames = (agent?.tools || [])
    .map((tool: any) => tool.name)
    .filter(Boolean);
  return hideDisabledGlobalToolsForSettings(
    computeSettingsAvailableToolNames(runtimeToolNames, { pluginTools }),
    engine,
  );
}

async function readAgentConfig(engine: any, agentId: string) {
  const configPath = path.join(agentDir(engine, agentId), "config.yaml");
  return YAML.load(await fs.readFile(configPath, "utf-8")) as Record<string, any> || {};
}

export async function buildSettingsConfigResponse(
  engine: any,
  options: BuildSettingsConfigOptions,
): Promise<Record<string, any>> {
  const sourceConfig = options.kind === "agent"
    ? await readAgentConfig(engine, options.agentId || "")
    : { ...(engine.config || {}) };
  const config = sourceConfig as Record<string, any>;
  normalizeExperienceConfigForResponse(config);
  config._raw = buildRawConfigBlocks(options.rawConfig || sourceConfig);
  injectGlobalFields(config, engine);
  config.providers = buildProviderSummary(engine, {
    includeHeaders: options.includeProviderHeaders,
  });
  const includeAvailableTools = options.includeAvailableTools ?? (options.kind === "agent");
  if (includeAvailableTools) {
    config.availableTools = buildSettingsAvailableTools(engine, options.agentId);
  }
  return maskObjectSecrets(config) as Record<string, any>;
}
