/**
 * model-sync.js — Provider Catalog provider configs → models.json 单向投影
 *
 * 系统中唯一写 models.json 的地方。从 providers 配置（snake_case）
 * 投影为 Pi SDK 格式（camelCase），附加 known-models.json 元数据。
 */

import fs from "fs";
import { getPiModel } from "../lib/pi-sdk/index.ts";
import { lookupKnown } from "../shared/known-models.ts";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import {
  normalizeModelProtocolCompat,
  normalizeToolUseContract,
  normalizeVisionCapabilities,
  withHanaAudioInputCompat,
  withHanaVideoInputCompat,
  withThinkingFormatCompat,
} from "../shared/model-capabilities.ts";
import { normalizeProviderHeaders, providerCredentialAllowsMissingApiKey } from "../shared/provider-auth.ts";
import { validateProviderModels } from "../shared/provider-model-validation.ts";
import { buildRuntimeApiKeyRef } from "../shared/runtime-api-key-ref.ts";
import { normalizeProviderBaseUrlForApi } from "../lib/llm/provider-client.ts";
import { normalizeThinkingLevelForModel } from "./session-thinking-level.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const PI_BUILTIN_PROVIDER_REUSE = new Set(["kimi-coding"]);
const KIMI_CODING_PROVIDER = "kimi-coding";
const KIMI_CODING_MODEL_ID = "kimi-for-coding";

/**
 * 模型 ID → 人类可读名
 * "doubao-seed-2-0-pro-260215" → "Doubao Seed 2.0 Pro"
 */
function humanizeName(id) {
  let name = id.replace(/-(\d{6})$/, "");
  name = name.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  name = name.replace(/(\d) (\d)/g, "$1.$2");
  return name;
}

/** 从 auth.json entry 提取 API key（兼容多种格式） */
function extractApiKey(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry?.apiKey === "string") return entry.apiKey;
  if (typeof entry?.access === "string") return entry.access;
  if (typeof entry?.token === "string") return entry.token;
  return "";
}

function getModelId(modelEntry) {
  return typeof modelEntry === "object" && modelEntry !== null ? modelEntry.id : modelEntry;
}

function getProviderModelDefaultThinkingLevel(modelDefaults, modelId) {
  if (!modelDefaults || !modelId) return undefined;
  const entry = modelDefaults[modelId];
  const level = entry?.thinking_level ?? entry?.thinkingLevel;
  return typeof level === "string" ? level : undefined;
}

function buildPiInputModalities({ image = false } = {}) {
  return [
    "text",
    ...(image ? ["image"] : []),
  ];
}

function getPiBuiltinModel(provider, modelId) {
  if (!PI_BUILTIN_PROVIDER_REUSE.has(provider) || !modelId) return null;
  try {
    return getPiModel(provider, modelId) || null;
  } catch {
    return null;
  }
}

function shouldReusePiBuiltinModel(provider, modelId, api) {
  return api === "anthropic-messages" && !!getPiBuiltinModel(provider, modelId);
}

function isKimiCodingProvider(provider) {
  return provider === KIMI_CODING_PROVIDER;
}

function isOfficialKimiCodingBaseUrl(baseUrl) {
  try {
    const parsed = new URL(String(baseUrl || ""));
    return parsed.hostname === "api.kimi.com"
      && (
        parsed.pathname.replace(/\/+$/, "") === "/coding"
        || parsed.pathname.replace(/\/+$/, "") === "/coding/v1"
      );
  } catch {
    return String(baseUrl || "").replace(/\/+$/, "") === "https://api.kimi.com/coding";
  }
}

function getKimiCodingEffectiveApi(provider, baseUrl, api) {
  if (!isKimiCodingProvider(provider)) return api;
  if (!isOfficialKimiCodingBaseUrl(baseUrl)) return api;
  return "openai-completions";
}

function normalizeKimiCodingModelEntry(modelEntry) {
  if (typeof modelEntry === "object" && modelEntry !== null) {
    return { ...modelEntry, id: KIMI_CODING_MODEL_ID };
  }
  return KIMI_CODING_MODEL_ID;
}

function isObjectModelEntry(modelEntry) {
  return typeof modelEntry === "object" && modelEntry !== null;
}

function normalizeKimiCodingModelEntries(provider, baseUrl, modelEntries) {
  if (!isKimiCodingProvider(provider) || !isOfficialKimiCodingBaseUrl(baseUrl)) return modelEntries;

  const byId = new Map();
  for (const rawEntry of modelEntries) {
    const entry = normalizeKimiCodingModelEntry(rawEntry);
    const id = getModelId(entry);
    const current = byId.get(id);
    if (!current) {
      byId.set(id, entry);
      continue;
    }
    if (isObjectModelEntry(current) || !isObjectModelEntry(entry)) continue;
    byId.set(id, entry);
  }
  return Array.from(byId.values());
}

function isZhipuOpenAICompat(provider, baseUrl, api) {
  return api === "openai-completions" && (
    provider === "zhipu"
    || provider === "zhipu-coding"
    || baseUrl.includes("open.bigmodel.cn")
    || (
      baseUrl.includes("api.z.ai")
      && (
        baseUrl.includes("/api/paas/v4")
        || baseUrl.includes("/api/coding/paas/v4")
      )
    )
  );
}

function buildModelOverride(modelEntry, modelDefaults = {}) {
  const modelDefaultThinkingLevel = getProviderModelDefaultThinkingLevel(modelDefaults, getModelId(modelEntry));
  if (typeof modelEntry !== "object" || modelEntry === null) {
    return modelDefaultThinkingLevel !== undefined
      ? { defaultThinkingLevel: modelDefaultThinkingLevel }
      : null;
  }

  const override: Record<string, any> = {};
  if (modelEntry.name !== undefined) override.name = modelEntry.name;
  if (modelEntry.context !== undefined) override.contextWindow = modelEntry.context;
  if (modelEntry.contextWindow !== undefined) override.contextWindow = modelEntry.contextWindow;
  if (modelEntry.maxOutput !== undefined) override.maxTokens = modelEntry.maxOutput;
  if (modelEntry.maxTokens !== undefined) override.maxTokens = modelEntry.maxTokens;
  const defaultThinkingLevel = modelEntry.defaultThinkingLevel ?? modelDefaultThinkingLevel;
  if (defaultThinkingLevel !== undefined) {
    override.defaultThinkingLevel = defaultThinkingLevel;
  }
  const image = modelEntry.image ?? modelEntry.vision;
  const video = modelEntry.video;
  const audio = modelEntry.audio;
  if (image !== undefined || video !== undefined) {
    override.input = buildPiInputModalities({
      image: image === true,
    });
  }
  if (modelEntry.reasoning !== undefined) override.reasoning = modelEntry.reasoning;
  if (modelEntry.xhigh !== undefined) override.xhigh = modelEntry.xhigh;
  const compat = normalizeModelProtocolCompat(modelEntry.compat);
  if (compat) override.compat = compat;
  const toolUse = normalizeToolUseContract(modelEntry.toolUse);
  if (modelEntry.toolUse !== undefined && !toolUse) {
    throw new Error(`invalid toolUse contract for model "${getModelId(modelEntry) || "unknown"}"`);
  }
  if (toolUse) override.toolUse = toolUse;
  const visionCapabilities = image === true
    ? normalizeVisionCapabilities(modelEntry.visionCapabilities)
    : null;
  if (visionCapabilities) override.visionCapabilities = visionCapabilities;

  let finalOverride = video === true ? withHanaVideoInputCompat(override, true) : override;
  finalOverride = audio === true ? withHanaAudioInputCompat(finalOverride, true) : finalOverride;
  return Object.keys(finalOverride).length > 0 ? finalOverride : null;
}

/**
 * 构建单个模型的 Pi SDK 格式条目
 * @param {string|{id:string, name?:string, context?:number, maxOutput?:number}} modelEntry
 * @param {string} provider - provider 名称（查词典用）
 */
function buildModelEntry(modelEntry, provider, baseUrl = "", api = "openai-completions", modelDefaults = {}) {
  const isObj = typeof modelEntry === "object" && modelEntry !== null;
  const id = getModelId(modelEntry);
  const known = lookupKnown(provider, id);
  const piBuiltin = getPiBuiltinModel(provider, id);

  // 输入模态能力：用户设置 > known-models 词典 > 默认 false
  // 兼容读：migration #7 之前的旧数据用 vision 字段；两个版本后移除 vision fallback
  const userImage = isObj ? (modelEntry.image ?? modelEntry.vision) : undefined;
  const knownImage = known?.image ?? known?.vision;
  const image = userImage !== undefined ? userImage : (knownImage === true);
  const userVideo = isObj ? modelEntry.video : undefined;
  const knownVideo = known?.video;
  const video = userVideo !== undefined ? userVideo : (knownVideo === true);
  const userAudio = isObj ? modelEntry.audio : undefined;
  const knownAudio = known?.audio;
  const audio = userAudio !== undefined ? userAudio : (knownAudio === true);
  const userXhigh = isObj ? modelEntry.xhigh : undefined;
  const xhigh = userXhigh !== undefined ? userXhigh : (known?.xhigh === true);
  const entry: Record<string, any> = {
    id,
    name: (isObj && modelEntry.name) || known?.name || humanizeName(id),
    input: buildPiInputModalities({ image: image === true }),
    contextWindow: (isObj && modelEntry.context) || known?.context || DEFAULT_CONTEXT_WINDOW,
    reasoning: (isObj && modelEntry.reasoning !== undefined) ? modelEntry.reasoning : (known?.reasoning === true),
  };
  if (xhigh === true) entry.xhigh = true;

  const maxOutput = (isObj && modelEntry.maxOutput) || known?.maxOutput;
  if (maxOutput) entry.maxTokens = maxOutput;
  const defaultThinkingLevel = isObj
    ? (modelEntry.defaultThinkingLevel ?? getProviderModelDefaultThinkingLevel(modelDefaults, id))
    : getProviderModelDefaultThinkingLevel(modelDefaults, id);
  if (defaultThinkingLevel !== undefined) {
    entry.defaultThinkingLevel = normalizeThinkingLevelForModel(
      defaultThinkingLevel,
      { ...entry, provider, api, baseUrl },
    );
  }

  if (known?.quirks?.length) entry.quirks = known.quirks;
  if (piBuiltin?.headers) entry.headers = { ...piBuiltin.headers };

  const rawToolUse = isObj && modelEntry.toolUse !== undefined ? modelEntry.toolUse : known?.toolUse;
  const toolUse = normalizeToolUseContract(rawToolUse);
  if (rawToolUse !== undefined && !toolUse) {
    throw new Error(`invalid toolUse contract for model "${id}"`);
  }
  if (toolUse) entry.toolUse = toolUse;

  const rawVisionCapabilities = isObj && modelEntry.visionCapabilities !== undefined
    ? modelEntry.visionCapabilities
    : known?.visionCapabilities;
  const visionCapabilities = image ? normalizeVisionCapabilities(rawVisionCapabilities) : null;
  if (visionCapabilities) entry.visionCapabilities = visionCapabilities;

  // Pi SDK compat 覆盖：
  // 1. 非 OpenAI provider 不发 developer role（dashscope 等不支持）— 与 reasoning 无关
  // 2. thinkingFormat 由 shared/model-capabilities.js 统一派生，避免请求层按 provider 猜
  // 3. Gemini OpenAI 兼容层（/v1beta/openai）严格校验，不识别 store 字段会 400。
  //    Native google-generative-ai 不走 Chat Completions，不需要这组 OpenAI 字段兼容。
  if (provider !== "openai") {
    const knownCompat = normalizeModelProtocolCompat(known?.compat) || {};
    const explicitCompat = isObj
      ? (normalizeModelProtocolCompat(modelEntry.compat) || {})
      : {};
    const compat: Record<string, unknown> = { ...knownCompat, ...explicitCompat, supportsDeveloperRole: false };
    if (api === "openai-completions" && (
      provider === "gemini"
      || baseUrl.includes("generativelanguage.googleapis.com")
    )) {
      compat.supportsStore = false;
    }
    if (compat.thinkingFormat === "zhipu" || isZhipuOpenAICompat(provider, baseUrl, api)) {
      compat.supportsStore = false;
      compat.supportsReasoningEffort = false;
    }
    entry.compat = compat;
  }

  let mediaAwareEntry = video === true ? withHanaVideoInputCompat(entry, true) : entry;
  mediaAwareEntry = audio === true ? withHanaAudioInputCompat(mediaAwareEntry, true) : mediaAwareEntry;
  return withThinkingFormatCompat(mediaAwareEntry, { provider, api, baseUrl });
}

function filterChatModelEntries(provider, models) {
  return models.filter(m => {
    const isObj = typeof m === "object" && m !== null;
    const id = getModelId(m);
    const known = lookupKnown(provider, id);
    const type = (isObj && m.type) || known?.type || "chat";
    return type === "chat";
  });
}

/**
 * 单向投影：providers 配置 → models.json（Pi SDK 格式）
 *
 * @param {Record<string, object>} providers - Provider Catalog 中的 providers 块（snake_case）
 * @param {object} [opts]
 * @param {string} opts.modelsJsonPath - models.json 输出路径
 * @param {string} [opts.authJsonPath] - auth.json 路径（OAuth 凭证查找用）
 * @param {Record<string, string>} [opts.oauthKeyMap] - providerId → auth.json key 映射
 * @returns {boolean} 内容是否有变化
 */
export function syncModels(providers, opts: Record<string, any> = {}) {
  const modelsJsonPath = opts.modelsJsonPath;
  const authJsonPath = opts.authJsonPath;
  const oauthKeyMap = opts.oauthKeyMap || {};
  const chatProjectionMap = opts.chatProjectionMap || {};

  // 懒加载 auth.json（只在需要时读一次）
  let _authJson;
  function getAuthJson() {
    if (_authJson !== undefined) return _authJson;
    if (!authJsonPath) { _authJson = {}; return _authJson; }
    try {
      _authJson = JSON.parse(fs.readFileSync(authJsonPath, "utf-8")) || {};
    } catch {
      _authJson = {};
    }
    return _authJson;
  }

  // 构建新的 providers 块
  const newProviders = {};

  for (const [name, p] of Object.entries(providers || {}) as [string, Record<string, any>][]) {
    const projection = chatProjectionMap[name] || "models-json";
    if (projection === "sdk-auth-alias" || projection === "none") continue;
    if (!p.base_url) continue;
    if (!p.models || p.models.length === 0) continue;
    validateProviderModels(name, p.models, { baseUrl: p.base_url });

    let apiKey = p.api_key || "";
    const hasLiteralApiKey = typeof p.api_key === "string" && p.api_key.length > 0;

    // 无 api_key 时尝试 OAuth 查找
    if (!apiKey) {
      const authKey = oauthKeyMap[name] || name;
      apiKey = extractApiKey(getAuthJson()[authKey]);
    }

    const headers = normalizeProviderHeaders(p.headers);
    const hasHeaders = Object.keys(headers).length > 0;

    // 无凭证时只允许 provider 契约声明无需 key、旧本地 loopback 配置，或显式 provider headers。
    if (!apiKey && !hasHeaders && !providerCredentialAllowsMissingApiKey({
      authType: p.auth_type,
      baseUrl: p.base_url,
    })) continue;

    const effectiveApiKey = apiKey || (hasHeaders ? "headers" : "local");
    const configuredApi = p.api || "openai-completions";
    const effectiveApi = getKimiCodingEffectiveApi(name, p.base_url, configuredApi);
    const effectiveBaseUrl = normalizeProviderBaseUrlForApi({
      provider: name,
      baseUrl: p.base_url,
      api: effectiveApi,
    });
    const modelDefaults = p.model_defaults || {};
    const chatModels = normalizeKimiCodingModelEntries(
      name,
      p.base_url,
      filterChatModelEntries(name, p.models),
    );
    const customModels = [];
    const modelOverrides = {};

    for (const modelEntry of chatModels) {
      const id = getModelId(modelEntry);
      if (shouldReusePiBuiltinModel(name, id, effectiveApi)) {
        const override = buildModelOverride(modelEntry, modelDefaults);
        if (override) modelOverrides[id] = override;
        continue;
      }
      customModels.push(buildModelEntry(modelEntry, name, effectiveBaseUrl, effectiveApi, modelDefaults));
    }

    const providerConfig: Record<string, any> = {
      baseUrl: effectiveBaseUrl,
      api: effectiveApi,
      apiKey: hasLiteralApiKey ? buildRuntimeApiKeyRef(name) : effectiveApiKey,
    };
    if (Object.keys(headers).length > 0) providerConfig.headers = headers;
    if (customModels.length > 0) providerConfig.models = customModels;
    if (Object.keys(modelOverrides).length > 0) providerConfig.modelOverrides = modelOverrides;

    newProviders[name] = providerConfig;
  }

  const newJson = { providers: newProviders };
  const newStr = JSON.stringify(newJson, null, 4) + "\n";

  // 比较是否有变化
  let oldStr = "";
  try {
    oldStr = fs.readFileSync(modelsJsonPath, "utf-8");
  } catch {
    // 文件不存在，视为有变化
  }
  if (oldStr === newStr) return false;

  // 原子写入：先写 tmp 文件，再 rename
  atomicWriteSync(modelsJsonPath, newStr);

  return true;
}
