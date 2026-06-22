/**
 * Kimi / Moonshot OpenAI-compatible thinking compatibility.
 *
 * Official Kimi Code and Moonshot thinking models use Chat Completions plus:
 *   - request thinking control: `thinking: { type: "enabled" | "disabled", keep? }`
 *   - effort control: `reasoning_effort`
 *   - replay / response carrier: `reasoning_content`
 *
 * This module keeps those rules out of the generic OpenAI-compatible path so
 * Qwen, DeepSeek, OpenRouter, and plain OpenAI models do not inherit Kimi-only
 * fields.
 */

import { getReasoningProfile, getThinkingFormat } from "../../shared/model-capabilities.ts";
import {
  ensureReasoningContentForToolCalls as ensureReasoningContentForToolCallsBase,
  stripReasoningContent,
} from "./reasoning-content-replay.ts";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  return getThinkingFormat(model) === "kimi"
    || getReasoningProfile(model) === "kimi-openai";
}

function isThinkingOff(level) {
  return level === "off" || level === "none" || level === "disabled";
}

function reasoningEffortForLevel(level) {
  if (level === "low") return "low";
  if (level === "medium") return "medium";
  if (level === "high" || level === "xhigh" || level === "max") return "high";
  return null;
}

function normalizeThinking(thinking) {
  const next: { type: string; keep?: unknown } = { type: "enabled" };
  if (thinking && typeof thinking === "object" && !Array.isArray(thinking) && hasOwn(thinking, "keep")) {
    next.keep = thinking.keep;
  }
  return next;
}

function normalizeMaxCompletionTokenField(payload) {
  if (!hasOwn(payload, "max_tokens")) return;
  if (!hasOwn(payload, "max_completion_tokens")) {
    payload.max_completion_tokens = payload.max_tokens;
  }
  delete payload.max_tokens;
}

function disableThinking(payload) {
  delete payload.reasoning_effort;
  payload.thinking = { type: "disabled" };
  if (Array.isArray(payload.messages)) {
    const stripped = stripReasoningContent(payload.messages);
    if (stripped !== payload.messages) payload.messages = stripped;
  }
}

function shouldDisableThinking(payload, model, options) {
  if (options?.mode === "utility") return true;
  if (isThinkingOff(options?.reasoningLevel)) return true;
  if (model?.reasoning === false) return true;
  return payload.thinking?.type === "disabled";
}

function shouldEnableThinking(payload, model, options) {
  return Boolean(
    model?.reasoning === true
    || payload.reasoning_effort
    || payload.thinking
    || reasoningEffortForLevel(options?.reasoningLevel)
  );
}

function ensureReasoningContentForToolCalls(messages) {
  return ensureReasoningContentForToolCallsBase(messages, { providerLabel: "Kimi" });
}

export function apply(payload, model, options: Record<string, unknown> = {}) {
  if (!payload || typeof payload !== "object") return payload;
  if (!Array.isArray(payload.messages)) return payload;

  let next = payload;
  const editable = () => {
    if (next === payload) next = { ...payload };
    return next;
  };

  if (hasOwn(payload, "max_tokens")) {
    normalizeMaxCompletionTokenField(editable());
  }

  if (shouldDisableThinking(next, model, options)) {
    disableThinking(editable());
    return next;
  }

  if (!shouldEnableThinking(next, model, options)) return next;

  const p = editable();
  p.thinking = normalizeThinking(p.thinking);

  const effort = reasoningEffortForLevel(options?.reasoningLevel);
  if (effort) {
    p.reasoning_effort = effort;
  }

  const messages = ensureReasoningContentForToolCalls(p.messages);
  if (messages !== p.messages) p.messages = messages;

  return next;
}
