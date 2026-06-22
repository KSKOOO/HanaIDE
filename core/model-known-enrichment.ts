import { getPiModel } from "../lib/pi-sdk/index.ts";
import { lookupKnown } from "../shared/known-models.ts";
import { normalizeVisionCapabilities, withThinkingFormatCompat } from "../shared/model-capabilities.ts";

const RUNTIME_ENRICHED_PROVIDERS = new Set(["kimi-coding"]);
const KIMI_CODING_MODEL_ID = "kimi-for-coding";

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function getPiBuiltinModel(provider, modelId) {
  if (!provider || !modelId) return null;
  try {
    return getPiModel(provider, modelId) || null;
  } catch {
    return null;
  }
}

function mergeCompat(model, known) {
  if (!known || model.provider === "openai") return model;
  return {
    ...model,
    compat: {
      supportsDeveloperRole: false,
      ...(isPlainObject(model.compat) ? model.compat : {}),
    },
  };
}

function isOfficialKimiCodingRuntime(model) {
  if (model.provider !== "kimi-coding") return false;
  try {
    const parsed = new URL(String(model.baseUrl || ""));
    return parsed.hostname === "api.kimi.com"
      && parsed.pathname.replace(/\/+$/, "").startsWith("/coding");
  } catch {
    return String(model.baseUrl || "").replace(/\/+$/, "") === "https://api.kimi.com/coding";
  }
}

function normalizeKimiCodingRuntimeModel(model) {
  if (!isOfficialKimiCodingRuntime(model)) return model;
  const compat = isPlainObject(model.compat) ? { ...model.compat } : {};
  delete compat.thinkingFormat;
  delete compat.reasoningProfile;
  return {
    ...model,
    id: KIMI_CODING_MODEL_ID,
    api: "openai-completions",
    baseUrl: "https://api.kimi.com/coding/v1",
    compat,
  };
}

export function enrichModelFromKnownMetadata(model) {
  if (!isPlainObject(model)) return model;
  if (!RUNTIME_ENRICHED_PROVIDERS.has(model.provider)) return model;

  const normalizedModel = normalizeKimiCodingRuntimeModel(model);
  const known = lookupKnown(normalizedModel.provider, normalizedModel.id);
  const piBuiltin = getPiBuiltinModel(normalizedModel.provider, normalizedModel.id);
  const patch: Record<string, unknown> = {};

  if (!normalizedModel.headers && piBuiltin?.headers) {
    patch.headers = { ...piBuiltin.headers };
  }

  const hasImageInput = Array.isArray(normalizedModel.input) && normalizedModel.input.includes("image");
  const knownImage = known?.image ?? known?.vision;
  const image = hasImageInput || knownImage === true;
  const visionCapabilities = image ? normalizeVisionCapabilities(known?.visionCapabilities) : null;
  if (visionCapabilities && !normalizedModel.visionCapabilities) {
    patch.visionCapabilities = visionCapabilities;
  }

  const withPatch = Object.keys(patch).length > 0 ? { ...normalizedModel, ...patch } : normalizedModel;
  const withCompat = mergeCompat(withPatch, known);
  return withThinkingFormatCompat(withCompat, {
    provider: withCompat.provider,
    api: withCompat.api,
    baseUrl: withCompat.baseUrl,
    id: withCompat.id,
  });
}
