import {
  createLocalTaskId,
  normalizeBaseUrl,
  normalizeImageInput,
  saveBase64Images,
} from "./common.ts";
import { t } from "../../../lib/i18n.ts";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_25_RATIOS = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const GEMINI_31_FLASH_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const GEMINI_3_PRO_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const GEMINI_3_SIZES = ["1K", "2K", "4K"];
const GEMINI_31_FLASH_SIZES = ["512", ...GEMINI_3_SIZES];

async function getCredentials(ctx, params: any = {}) {
  const providerId = params.credentialProviderId || params.providerId || "gemini";
  const creds = await ctx.bus.request("provider:credentials", { providerId });
  if (creds.error || !creds.apiKey) {
    throw new Error(t("plugin.imageGen.providerNoApiKey", { providerId }));
  }
  return creds;
}

function collectInlineImages(data) {
  const images = [];
  for (const candidate of data?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      const inline = part.inlineData || part.inline_data;
      const b64 = inline?.data;
      if (typeof b64 === "string") {
        images.push({
          data: b64,
          mimeType: inline.mimeType || inline.mime_type || "image/png",
        });
      }
    }
  }
  return images;
}

function geminiImageCapabilities(modelId) {
  const id = String(modelId || "").toLowerCase();
  if (id.includes("3.1-flash")) {
    return {
      ratios: new Set(GEMINI_31_FLASH_RATIOS),
      imageSizes: new Set(GEMINI_31_FLASH_SIZES),
      defaultImageSize: "4K",
      maxReferenceImages: 14,
      supportsImageSize: true,
    };
  }
  if (id.includes("3-pro")) {
    return {
      ratios: new Set(GEMINI_3_PRO_RATIOS),
      imageSizes: new Set(GEMINI_3_SIZES),
      defaultImageSize: "4K",
      maxReferenceImages: 14,
      supportsImageSize: true,
    };
  }
  return {
    ratios: new Set(GEMINI_25_RATIOS),
    imageSizes: new Set(),
    defaultImageSize: null,
    maxReferenceImages: 3,
    supportsImageSize: false,
  };
}

function normalizeGeminiAspectRatio(value, capabilities) {
  if (!value) return null;
  const ratio = String(value).trim();
  if (capabilities.ratios.has(ratio)) return ratio;
  throw new Error(`Gemini image ratio "${ratio}" is unsupported`);
}

function normalizeGeminiImageSize(value, fieldName, capabilities, modelId) {
  if (!value) return null;
  if (!capabilities.supportsImageSize) {
    throw new Error(`Gemini 2.5 image model "${modelId}" does not support image size`);
  }
  const raw = String(value).trim();
  const normalized = raw.toUpperCase();
  const canonical = normalized === "0.5K" ? "512" : normalized;
  if (capabilities.imageSizes.has(canonical)) return canonical;
  throw new Error(`Gemini image ${fieldName} "${raw}" is unsupported`);
}

function normalizeGeminiImageConfig(params, modelId) {
  const capabilities = geminiImageCapabilities(modelId);
  const imageConfig: any = {};
  const aspectRatio = normalizeGeminiAspectRatio(params.aspect_ratio || params.aspectRatio || params.ratio || "3:2", capabilities);
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;

  const size = normalizeGeminiImageSize(params.size, "size", capabilities, modelId);
  const defaultResolution = params.size ? null : capabilities.defaultImageSize;
  const resolution = normalizeGeminiImageSize(params.resolution || defaultResolution, "resolution", capabilities, modelId);
  if (size && resolution && size !== resolution) {
    throw new Error(`Gemini image size "${params.size}" conflicts with resolution "${params.resolution}"`);
  }
  const imageSize = size || resolution;
  if (imageSize) imageConfig.imageSize = imageSize;

  return imageConfig;
}

async function remoteImageToInlinePart(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download Gemini reference image failed ${res.status}`);
  const mimeType = res.headers?.get?.("content-type") || "image/png";
  const data = Buffer.from(await res.arrayBuffer()).toString("base64");
  return { inline_data: { mime_type: mimeType, data } };
}

async function imagePart(image) {
  if (typeof image !== "string") return null;
  if (image.startsWith("data:")) {
    const match = image.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) return null;
    return { inline_data: { mime_type: match[1], data: match[2] } };
  }
  if (/^https?:\/\//i.test(image)) {
    return remoteImageToInlinePart(image);
  }
  return { file_data: { file_uri: image } };
}

export const geminiImageAdapter = {
  id: "gemini",
  protocolId: "gemini-generate-content-image",
  name: "Gemini Image",
  types: ["image"],
  capabilities: {
    ratios: [...new Set([...GEMINI_31_FLASH_RATIOS, ...GEMINI_3_PRO_RATIOS, ...GEMINI_25_RATIOS])],
    resolutions: ["512", "1K", "2K", "4K"],
  },

  async checkAuth(ctx) {
    try {
      await getCredentials(ctx, { providerId: "gemini" });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const creds = await getCredentials(ctx, params);
    const modelId = params.modelId || params.model || "gemini-3.1-flash-image-preview";
    const capabilities = geminiImageCapabilities(modelId);
    const inputImages = normalizeImageInput(params.image);
    if (inputImages.length > capabilities.maxReferenceImages) {
      throw new Error(`Gemini model "${modelId}" supports at most ${capabilities.maxReferenceImages} reference images`);
    }
    const parts: any[] = [{ text: params.prompt }];
    for (const image of inputImages) {
      const part = await imagePart(image);
      if (part) parts.push(part as any);
    }

    const imageConfig = normalizeGeminiImageConfig(params, modelId);

    const body = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        ...(Object.keys(imageConfig).length ? { responseFormat: { image: imageConfig } } : {}),
      },
    };

    const res = await fetch(`${normalizeBaseUrl(creds.baseUrl, DEFAULT_BASE_URL)}/models/${encodeURIComponent(modelId)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": creds.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const err = await res.json();
        if (err.error?.message) msg = `${msg}: ${err.error.message}`;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    const images = collectInlineImages(data);
    if (images.length === 0) throw new Error("Gemini API returned no images");

    const files = [];
    for (const [index, image] of images.entries()) {
      const saved = await saveBase64Images(
        [image.data],
        image.mimeType,
        ctx.dataDir,
        params.filename && images.length > 1 ? `${params.filename}-${index + 1}` : params.filename,
      );
      files.push(...saved);
    }
    return { taskId: createLocalTaskId(), files };
  },
};
