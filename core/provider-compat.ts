/**
 * core/provider-compat.js — LLM HTTP payload 兼容层（唯一对外入口）
 *
 * 架构：dispatcher + 子模块。所有 provider-specific 补丁拆到 ./provider-compat/<name>.js。
 * 完整规范见 ./provider-compat/README.md。
 *
 * 两条调用路径共享本入口（commit f5b5d69 — chat 路径与 utility 路径合一的纪律）：
 *   - core/llm-client.js 的 callText（非流式 / utility 路径）
 *   - core/engine.js 的 Pi SDK before_provider_request 扩展（流式 / chat 路径）
 *
 * 本文件只保留：
 *   1. dispatcher（按 matches 分发到子模块，first-match-wins）
 *   2. 与 provider 无关的通用补丁（stripEmptyTools, stripIncompatibleThinking,
 *      normalizeImplicitOutputBudget）
 *   3. 协议鉴别函数（isDeepSeekModel, isAnthropicModel, getThinkingFormat）— 供其他 hana 模块复用
 *
 * 不允许在本文件加任何 provider-specific 实现细节；新 provider 一律开
 * core/provider-compat/<name>.js 子模块。
 */

import * as deepseek from "./provider-compat/deepseek.ts";
import * as kimi from "./provider-compat/kimi.ts";
import * as mimo from "./provider-compat/mimo.ts";
import * as qwen from "./provider-compat/qwen.ts";
import * as zhipu from "./provider-compat/zhipu.ts";
import * as agnes from "./provider-compat/agnes.ts";
import * as openaiInputAudio from "./provider-compat/openai-input-audio.ts";
import * as openaiVideoUrl from "./provider-compat/openai-video-url.ts";
import * as openrouter from "./provider-compat/openrouter.ts";
import * as anthropic from "./provider-compat/anthropic.ts";
import { normalizeImplicitOutputBudget } from "./provider-compat/output-budget.ts";
import { stripOrphanToolResults } from "./provider-compat/tool-pairing.ts";
import { normalizeOpenAIInputAudioPayload } from "./provider-compat/input-audio.ts";
import {
  MODEL_AUDIO_TRANSPORTS,
  resolveModelAudioInputTransport,
} from "../shared/model-capabilities.ts";
import {
  getReasoningProfile as getDeclaredReasoningProfile,
  getThinkingFormat as getDeclaredThinkingFormat,
} from "../shared/model-capabilities.ts";
import { normalizeRequestThinkingLevel } from "./session-thinking-level.ts";

interface ProviderModule {
  matches(model: any): boolean;
  apply(payload: any, model: any, options?: any): any;
  normalizeContextMessages?(messages: any[], model: any, options?: any): any[];
}

/**
 * 子模块注册表。顺序敏感：first-match-wins。
 * 新 provider 默认加在末尾；只有当模块的 matches 是另一模块子集（更具体规则）时才前置。
 */
const PROVIDER_MODULES: ProviderModule[] = [
  deepseek,
  kimi,
  mimo,
  qwen,
  zhipu,
  agnes,
  openaiInputAudio,
  openaiVideoUrl,
  openrouter,
  anthropic,
];

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

// ── Provider 鉴别（导出供其他 hana 模块复用，不属于子模块逻辑）──

/**
 * 判断 model 是否走 DeepSeek 兼容路径。
 * 委托给 deepseek 子模块的 matches，避免双源真相。
 */
export function isDeepSeekModel(model) {
  return deepseek.matches(model);
}

/**
 * 判断 model 是否走 Anthropic thinking 兼容路径。
 * Anthropic 没有专门的子模块（pi-ai SDK 已直接兼容），这里消费
 * model.compat.thinkingFormat，不按 provider 名猜测第三方兼容服务。
 */
export function isAnthropicModel(model) {
  if (!model || typeof model !== "object") return false;
  return lower(model.provider) === "anthropic" || getThinkingFormat(model) === "anthropic";
}

export function getThinkingFormat(model) {
  const declared = getDeclaredThinkingFormat(model);
  if (declared) return declared;
  if (isDeepSeekModel(model)) return "deepseek";
  if (zhipu.matches(model)) return "zhipu";
  return null;
}

export function getReasoningProfile(model) {
  return getDeclaredReasoningProfile(model);
}

// ── 通用 payload 处理（与 provider 无关）──

function stripEmptyTools(payload) {
  if (Array.isArray(payload.tools) && payload.tools.length === 0) {
    const { tools, ...rest } = payload;
    return rest;
  }
  return payload;
}

function stripIncompatibleThinking(payload, model) {
  if (!payload.thinking) return payload;
  // payload.thinking 只对 Anthropic-style / DeepSeek-style / Kimi-style 请求体有效。
  // Qwen/openrouter 等格式即使支持 reasoning，也不接收这个字段。
  // 没有 model 信息时保守保留（旧降级路径），避免误删 anthropic 调用。
  if (!model) return payload;
  const thinkingFormat = getThinkingFormat(model);
  if (thinkingFormat === "anthropic" || thinkingFormat === "deepseek" || thinkingFormat === "zhipu" || thinkingFormat === "kimi") return payload;
  const { thinking, ...rest } = payload;
  return rest;
}

function isDisabledReasoningEffort(value) {
  if (value === false || value == null) return true;
  const normalized = lower(value);
  return normalized === "" || normalized === "none" || normalized === "off" || normalized === "disabled";
}

function stripDisabledReasoningEffort(payload) {
  if (!Object.prototype.hasOwnProperty.call(payload, "reasoning_effort")) return payload;
  if (!isDisabledReasoningEffort(payload.reasoning_effort)) return payload;
  const { reasoning_effort, ...rest } = payload;
  return rest;
}

function normalizeAutoReasoningEffort(payload) {
  if (!Object.prototype.hasOwnProperty.call(payload, "reasoning_effort")) return payload;
  if (lower(payload.reasoning_effort) !== "auto") return payload;
  return { ...payload, reasoning_effort: "medium" };
}

function normalizeProviderOptions(options: Record<string, any> = {}) {
  if (!Object.prototype.hasOwnProperty.call(options, "reasoningLevel")) return options;
  return {
    ...options,
    reasoningLevel: normalizeRequestThinkingLevel(options.reasoningLevel, "off"),
  };
}

/**
 * 孤儿 toolResult 配对兜底（issue #1285，provider-agnostic）。
 * 删除「父 tool_calls 已被 SDK transform-messages 丢弃的孤儿 role:"tool"」，
 * 使每个 role:"tool" 都有前驱带匹配 tool_calls 的 assistant，避免 OpenAI-compatible
 * provider 返回 400。逻辑与删除条件见 ./provider-compat/tool-pairing.js。
 */
function stripOrphanToolMessages(payload) {
  if (!Array.isArray(payload.messages)) return payload;
  const repaired = stripOrphanToolResults(payload.messages);
  if (repaired === payload.messages) return payload;
  return { ...payload, messages: repaired };
}

const ATTACHED_MEDIA_MARKER_RE = {
  image: /\[attached_image:\s*[^\]]+\]\n?/g,
  video: /\[attached_video:\s*[^\]]+\]\n?/g,
  audio: /\[attached_audio:\s*[^\]]+\]\n?/g,
};

function stripNativeMediaAttachmentMarkers(payload) {
  if (!Array.isArray(payload.messages)) return payload;

  let changed = false;
  const messages = payload.messages.map((message) => {
    if (!Array.isArray(message?.content)) return message;
    const mediaKinds = nativeMediaKindsInContent(message.content);
    if (mediaKinds.size === 0) return message;

    let contentChanged = false;
    const content = message.content.map((part) => {
      if (!part || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string") {
        return part;
      }
      const nextText = stripMediaMarkersFromText(part.text, mediaKinds);
      if (nextText === part.text) return part;
      contentChanged = true;
      return { ...part, text: nextText };
    });

    if (!contentChanged) return message;
    changed = true;
    return { ...message, content };
  });

  return changed ? { ...payload, messages } : payload;
}

function nativeMediaKindsInContent(content) {
  const kinds = new Set();
  for (const part of content) {
    const kind = nativeMediaKind(part);
    if (kind) kinds.add(kind);
  }
  return kinds;
}

function nativeMediaKind(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "input_audio" || part.type === "audio") return "audio";
  if (part.type === "input_image" || part.type === "image") return "image";
  if (part.type === "video" || part.type === "video_url") return "video";

  if (part.type !== "image_url") return null;
  const url = part.image_url?.url ?? part.imageUrl?.url;
  if (typeof url !== "string") return null;
  const normalized = url.toLowerCase();
  if (normalized.startsWith("data:image/")) return "image";
  if (normalized.startsWith("data:audio/")) return "audio";
  if (normalized.startsWith("data:video/")) return "video";
  return null;
}

function stripMediaMarkersFromText(text, mediaKinds) {
  let next = text;
  for (const kind of mediaKinds) {
    next = next.replace(ATTACHED_MEDIA_MARKER_RE[kind], "");
  }
  return next.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeAudioTransportPayload(payload, model) {
  const transport = resolveModelAudioInputTransport(model);
  if (transport === MODEL_AUDIO_TRANSPORTS.MIMO_INPUT_AUDIO
    || transport === MODEL_AUDIO_TRANSPORTS.OPENAI_INPUT_AUDIO) {
    return normalizeOpenAIInputAudioPayload(payload);
  }
  return payload;
}

/**
 * Provider payload 兼容化的唯一入口。chat 路径与 utility 路径共享。
 *
 * 处理顺序：
 *   1. 通用补丁（stripEmptyTools / stripIncompatibleThinking / stripDisabledReasoningEffort）
 *   2. 子模块分发（first-match-wins，最多匹配一个）
 *
 * @param {object} payload — 即将发送的 HTTP body（OpenAI / Anthropic 风格）
 * @param {object|null|undefined} model — 完整 model 对象 {id, provider, baseUrl, reasoning, maxTokens, quirks, ...}
 * @param {{ mode?: "chat" | "utility", reasoningLevel?: string, outputBudgetSource?: "user" | "system" | "sdk-default", maxTokensSource?: string, userMaxTokens?: number }} [options]
 * @returns {object} 处理后的 payload
 */
export function normalizeProviderPayload(payload, model, options = {}) {
  if (!payload || typeof payload !== "object") return payload;

  const normalizedOptions = normalizeProviderOptions(options);
  let result = payload;

  // 1. 通用补丁（与 provider 无关）
  result = stripEmptyTools(result);
  result = stripIncompatibleThinking(result, model);
  result = stripDisabledReasoningEffort(result);
  result = normalizeAutoReasoningEffort(result);
  // 孤儿 toolResult 配对兜底先于 provider 子模块：保证子模块（如 deepseek 的
  // reasoning_content 校验）拿到的是已配对的 messages，不会被孤儿干扰。
  result = stripOrphanToolMessages(result);
  result = normalizeImplicitOutputBudget(result, model, normalizedOptions);
  result = stripNativeMediaAttachmentMarkers(result);
  result = normalizeAudioTransportPayload(result, model);

  // 2. Provider-specific 补丁（按 matches 分发，first-match-wins）
  for (const mod of PROVIDER_MODULES) {
    if (mod.matches(model)) {
      result = mod.apply(result, model, normalizedOptions);
      break;
    }
  }

  return result;
}

/**
 * Provider context 兼容化入口。运行于 Pi SDK context hook，早于 provider
 * serializer，专门承载 replay/history 这类 payload hook 已经来不及处理的协议校验。
 *
 * @param {Array|any} messages — Pi SDK AgentMessage[]
 * @param {object|null|undefined} model
 * @param {{ mode?: "chat" | "utility", reasoningLevel?: string }} [options]
 * @returns {Array|any}
 */
export function normalizeProviderContextMessages(messages, model, options = {}) {
  if (!Array.isArray(messages)) return messages;

  const normalizedOptions = normalizeProviderOptions(options);
  for (const mod of PROVIDER_MODULES) {
    if (mod.matches(model)) {
      if (typeof mod.normalizeContextMessages === "function") {
        return mod.normalizeContextMessages(messages, model, normalizedOptions);
      }
      break;
    }
  }

  return messages;
}
