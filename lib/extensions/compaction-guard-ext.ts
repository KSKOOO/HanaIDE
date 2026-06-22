/**
 * Hana cache-preserving compaction Pi SDK Extension
 *
 * 三层防护，防 session 因上下文超限而死锁，同时避免 Pi SDK 原生
 * summarizer 走冷启动请求破坏 prompt cache：
 *
 *   L1 (tool_result hook)：
 *     单条 tool_result 的 text 内容超过 maxToolResultBytes 字节时，
 *     做 head+tail 截断，中间塞省略标记。
 *     防"一次工具调用返回 200KB 直接把 session 推过悬崖"。
 *
 *   L3 (session_before_compact hook)：
 *     pi SDK 进入压缩流程时，预判 Hana 摘要请求的输入是否已经超窗。
 *     若 messagesToSummarize 总量 > contextWindow * hardTruncateThreshold，
 *     摘要调用必然失败（issue#437 的根本死锁场景），直接走硬截断。
 *     否则追加一条内部压缩指令到原会话前缀后面，让主模型在同一
 *     prompt cache 前缀上生成 summary，并通过 hook 返回 compaction。
 *
 *   L2（非 hook，由 session-defaults.js 调大 reserveTokens 实现）：
 *     让 pi SDK 的原生 threshold 压缩更早触发，给 tool_result 累积留 buffer。
 *
 * 纪律：
 *   - 零 pi SDK 改动，全走官方 ExtensionAPI
 *   - 不调用任何私有方法（不碰 _overflowRecoveryAttempted / _runAutoCompaction）
 *   - 失败路径：auto 模式下 cache-preserving 链路失败时返回 undefined，让 Pi 原生 summarizer 接手；
 *     显式 cache_preserving 模式仍 cancel，保留严格诊断能力
 */

import { computeHardTruncation, estimatePreparationTokens, truncateTextHeadTail } from "../../core/compaction-utils.ts";
import {
  createCachePreservingCompactionResult,
  shouldHardTruncateCachePreservingCompaction,
  stripInlineMediaFromCompactionPreparation,
} from "../../core/session-compactor.ts";
import {
  normalizeProviderContextMessages,
  normalizeProviderPayload,
} from "../../core/provider-compat.ts";
import {
  ensureReasoningContentForToolCalls,
  isReasoningReplayUnavailable,
} from "../../core/provider-compat/reasoning-content-replay.ts";
import {
  CACHE_STRATEGIES,
  buildCacheStrategyMetadata,
} from "../llm/cache-strategy-contract.ts";
import {
  COMPACTION_MODES,
  normalizeCompactionMode,
} from "../../shared/compaction-mode.ts";
import { convertAgentMessagesToLlm } from "../pi-sdk/index.ts";
import { createModuleLogger } from "../debug-log.ts";
import { normalizeRequestThinkingLevel } from "../../core/session-thinking-level.ts";

const log = createModuleLogger("compaction-guard");

const DEFAULT_MAX_TOOL_RESULT_BYTES = 32 * 1024; // 32KB ≈ 8K token
const DEFAULT_HARD_TRUNCATE_THRESHOLD = 0.85;    // messagesToSummarize 超 85% 窗口 → 硬截断

function needsToolCallReasoningReplay(model: any) {
  const provider = typeof model?.provider === "string" ? model.provider.toLowerCase() : "";
  const baseUrl = typeof model?.baseUrl === "string"
    ? model.baseUrl.toLowerCase()
    : (typeof model?.base_url === "string" ? model.base_url.toLowerCase() : "");
  return provider === "zhipu" || baseUrl.includes("open.bigmodel.cn");
}

function hardTruncateFromPreparation(event: any, ctx: any, preparation: any) {
  const sm = ctx.sessionManager;
  const pathEntries = event.branchEntries || sm?.getBranch?.() || [];
  const keepRecentTokens = preparation.settings?.keepRecentTokens ?? 20_000;

  return {
    keepRecentTokens,
    pathEntries,
    truncation: computeHardTruncation(pathEntries, keepRecentTokens, {
      summary: "[由于对话过长且摘要请求本身会超限，早期对话历史已被硬截断（hana-cache-preserving-compaction）]",
      reason: "compaction-guard-hard-truncate",
    }),
  };
}

function readThinkingLevel(ctx: any) {
  try {
    const level = ctx?.getThinkingLevel?.();
    if (typeof level === "string") return level;
  } catch {
    // Older or stale extension contexts may not expose getThinkingLevel.
  }
  try {
    const level = ctx?.sessionManager?.buildSessionContext?.()?.thinkingLevel;
    return typeof level === "string" ? level : undefined;
  } catch {
    return undefined;
  }
}

function snapshotCacheKeyParams(snapshot: any, fallbackThinkingLevel: any) {
  const fallback = normalizeRequestThinkingLevel(fallbackThinkingLevel, "off");
  const normalizeParams = (params) => {
    const out = { ...(params || {}) };
    out.thinkingLevel = normalizeRequestThinkingLevel(out.thinkingLevel || fallback, "off");
    if (Object.prototype.hasOwnProperty.call(out, "reasoning")) {
      out.reasoning = normalizeRequestThinkingLevel(out.reasoning, "off");
    }
    return out;
  };
  if (snapshot?.cacheKeyParams && typeof snapshot.cacheKeyParams === "object" && !Array.isArray(snapshot.cacheKeyParams)) {
    return normalizeParams(snapshot.cacheKeyParams);
  }
  return normalizeParams({ thinkingLevel: fallback });
}

/**
 * Factory。
 * @param {object} [opts]
 * @param {number} [opts.maxToolResultBytes=32768] - L1 单条 tool_result text 字节上限
 * @param {number} [opts.hardTruncateThreshold=0.85] - L3 触发硬截断的窗口占比
 * @returns {(pi: object) => void}
 */
export function createCompactionGuardExtension(opts: Record<string, any> = {}) {
  const maxToolResultBytes = opts.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
  const hardTruncateThreshold = opts.hardTruncateThreshold ?? DEFAULT_HARD_TRUNCATE_THRESHOLD;
  const cacheCompactor = opts.cacheCompactor ?? createCachePreservingCompactionResult;
  const usageLedger = opts.usageLedger || null;
  const buildUsageContext = typeof opts.buildUsageContext === "function" ? opts.buildUsageContext : null;
  const getCompactionMode = typeof opts.getCompactionMode === "function"
    ? opts.getCompactionMode
    : () => COMPACTION_MODES.AUTO;
  const buildSessionCacheSnapshot = typeof opts.buildSessionCacheSnapshot === "function"
    ? opts.buildSessionCacheSnapshot
    : null;

  function readCompactionMode(event: any, ctx: any) {
    try {
      return normalizeCompactionMode(getCompactionMode({ event, ctx }));
    } catch (err) {
      log.warn(`[L3] compaction mode resolver failed, using auto: ${err?.message || err}`);
      return COMPACTION_MODES.AUTO;
    }
  }

  function fallBackToPiNative(reason: string) {
    log.warn(`[L3] cache-preserving compaction unavailable; falling back to Pi SDK native summarizer: ${reason}`);
    return undefined;
  }

  return function (pi) {
    // ── L1: tool_result 单条硬限 ──
    pi.on("tool_result", (event) => {
      try {
        // 错误返回保留完整，帮 debug
        if (event.isError) return undefined;
        if (!Array.isArray(event.content)) return undefined;

        let changed = false;
        const newContent = event.content.map((block) => {
          if (!block || block.type !== "text" || typeof block.text !== "string") return block;
          const res = truncateTextHeadTail(block.text, { maxBytes: maxToolResultBytes });
          if (!res.truncated) return block;
          changed = true;
          log.log(
            `[L1] tool_result text truncated: tool=${event.toolName || "?"} ` +
            `original=${res.originalBytes}B → ${Buffer.byteLength(res.text, "utf8")}B`
          );
          return { ...block, text: res.text };
        });

        if (changed) return { content: newContent };
        return undefined;
      } catch (err) {
        log.warn(`[L1] tool_result hook error (passthrough): ${err?.message || err}`);
        return undefined;
      }
    });

    // ── L3: 压缩前预判，必败时走硬截断 ──
    pi.on("session_before_compact", async (event, ctx) => {
      let allowNativeFallback = false;
      try {
        const preparation = stripInlineMediaFromCompactionPreparation(event?.preparation);
        const model = ctx?.model;
        if (!preparation || !model) return { cancel: true };

        const compactionMode = readCompactionMode(event, ctx);
        if (compactionMode === COMPACTION_MODES.PI_COMPATIBLE) {
          log.log("[L3] pi-compatible compaction selected; falling through to Pi SDK native summarizer");
          return undefined;
        }

        const contextWindow = model.contextWindow ?? 0;
        if (contextWindow <= 0) return { cancel: true };

        const worstCaseLlmTokens = estimatePreparationTokens(preparation);
        const threshold = Math.floor(contextWindow * hardTruncateThreshold);

        if (worstCaseLlmTokens > threshold) {
          // 摘要请求必然超窗（issue#437 死锁根源），走硬截断。
          if (event.signal?.aborted) return { cancel: true };

          const { keepRecentTokens, truncation } = hardTruncateFromPreparation(event, ctx, preparation);

          if (!truncation) {
            log.warn(
              `[L3] hard-truncate unavailable: worstCaseLlmTokens=${worstCaseLlmTokens} ` +
              `threshold=${threshold} contextWindow=${contextWindow}`
            );
            return { cancel: true };
          }

          log.log(
            `[L3] preemptive hard-truncate: worstCaseLlmTokens=${worstCaseLlmTokens} ` +
            `> threshold=${threshold} (ctx=${contextWindow}), keep=${keepRecentTokens}`
          );

          return { compaction: truncation };
        }

        if (event.signal?.aborted) return { cancel: true };
        allowNativeFallback = compactionMode === COMPACTION_MODES.AUTO;

        let thinkingLevel = normalizeRequestThinkingLevel(readThinkingLevel(ctx), "off");
        let reasoningLevel = typeof thinkingLevel === "string" && thinkingLevel !== "off" ? thinkingLevel : null;
        let reasoningReplay = "preserve";
        let cacheMetadataOverride = null;
        const builtContext = ctx.sessionManager?.buildSessionContext?.();
        const rawMessages = Array.isArray(preparation.messagesToSummarize)
          ? preparation.messagesToSummarize
          : [];
        let messages;
        try {
          messages = normalizeProviderContextMessages(rawMessages, model, {
            mode: "chat",
            reasoningLevel,
          });
          if (reasoningLevel && needsToolCallReasoningReplay(model)) {
            messages = ensureReasoningContentForToolCalls(messages, { providerLabel: "Zhipu" });
          }
        } catch (err) {
          if (!isReasoningReplayUnavailable(err)) throw err;
          reasoningReplay = "clear";
          cacheMetadataOverride = buildCacheStrategyMetadata({
            cacheStrategy: CACHE_STRATEGIES.CACHE_RECOVERY,
            cacheGroup: "compaction.history",
            templateVersion: "v1",
            strict: false,
            degradeReason: "reasoning_replay_unavailable",
          } as any);
          messages = normalizeProviderContextMessages(rawMessages, model, {
            mode: "chat",
            reasoningLevel,
          });
          log.warn(`[L3] cache recovery compaction: reasoning replay unavailable, historical thinking cleared for this compaction`);
        }
        const systemPrompt = ctx.getSystemPrompt?.() || builtContext?.systemPrompt || "";
        const sessionPath = ctx.sessionManager?.getSessionFile?.() || null;
        const fit = shouldHardTruncateCachePreservingCompaction({
          preparation,
          model,
          systemPrompt,
          customInstructions: event.customInstructions,
          hardTruncateThreshold,
        });
        if (fit.shouldHardTruncate) {
          const { keepRecentTokens, truncation } = hardTruncateFromPreparation(event, ctx, preparation);
          if (!truncation) {
            log.warn(
              `[L3] hard-truncate unavailable for cache-preserving request: ` +
              `requestTokens=${fit.budget.totalTokens} threshold=${fit.threshold} contextWindow=${fit.contextWindow}`
            );
            return { cancel: true };
          }
          log.log(
            `[L3] cache-preserving request hard-truncate: requestTokens=${fit.budget.totalTokens} ` +
            `> threshold=${fit.threshold} (ctx=${fit.contextWindow}), keep=${keepRecentTokens}`
          );
          return { compaction: truncation };
        }

        const auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(model);
        if (!auth?.ok || !auth.apiKey) {
          log.warn(`[L3] model auth unavailable for cache-preserving compaction: ${auth?.error || model.id}`);
          if (allowNativeFallback) {
            return fallBackToPiNative(`model auth unavailable for cache-preserving compaction: ${auth?.error || model.id}`);
          }
          return { cancel: true };
        }
        const sessionSnapshot = buildSessionCacheSnapshot
          ? buildSessionCacheSnapshot(sessionPath, {
            reason: "compaction.history",
            messages,
          })
          : null;
        const requestCacheKeyParams = cacheMetadataOverride
          ? {
            thinkingLevel: normalizeRequestThinkingLevel(thinkingLevel, "off"),
            reasoningReplay,
          }
          : snapshotCacheKeyParams(sessionSnapshot, thinkingLevel);
        const requestThinkingLevel = typeof requestCacheKeyParams.thinkingLevel === "string"
          ? normalizeRequestThinkingLevel(requestCacheKeyParams.thinkingLevel, "off")
          : normalizeRequestThinkingLevel(thinkingLevel, "off");
        const requestReasoningLevel = requestThinkingLevel !== "off" ? requestThinkingLevel : null;

        const buildCompactorRequest = ({
          requestMessages = messages,
          requestReplay = reasoningReplay,
          requestMetadataOverride = cacheMetadataOverride,
          requestKeyParams = requestCacheKeyParams,
          requestThinking = requestMetadataOverride ? thinkingLevel : requestThinkingLevel,
          requestReasoning = requestMetadataOverride ? reasoningLevel : requestReasoningLevel,
        } = {}) => ({
          preparation,
          model,
          systemPrompt,
          messages: requestMessages,
          tools: sessionSnapshot?.tools || [],
          sessionSnapshot,
          cacheKeyParams: requestKeyParams,
          cacheMetadataOverride: requestMetadataOverride,
          customInstructions: event.customInstructions,
          signal: event.signal,
          thinkingLevel: requestThinking,
          streamOptions: {
            apiKey: auth.apiKey,
            headers: auth.headers,
            sessionId: ctx.sessionManager?.getSessionId?.(),
            onPayload: (payload, requestModel) => normalizeProviderPayload(payload, requestModel || model, {
              mode: "chat",
              reasoningLevel: requestReasoning,
              reasoningReplay: requestReplay,
            }),
          },
          convertToLlm: convertAgentMessagesToLlm,
          usageLedger,
          usageContext: buildUsageContext?.({ event, ctx, model }) || null,
        });

        async function retryWithClearedReasoningReplay(originalError: any) {
          if (!isReasoningReplayUnavailable(originalError) || reasoningReplay === "clear") {
            throw originalError;
          }
          const recoveryMetadata = buildCacheStrategyMetadata({
            cacheStrategy: CACHE_STRATEGIES.CACHE_RECOVERY,
            cacheGroup: "compaction.history",
            templateVersion: "v1",
            strict: false,
            degradeReason: "reasoning_replay_unavailable",
          } as any);
          const recoveryMessages = normalizeProviderContextMessages(rawMessages, model, {
            mode: "chat",
            reasoningLevel,
          });
          const recoveryCacheKeyParams = {
            thinkingLevel: normalizeRequestThinkingLevel(thinkingLevel, "off"),
            reasoningReplay: "clear",
          };
          log.warn(`[L3] cache recovery compaction: reasoning replay failed during request build, retrying with historical thinking cleared`);
          return await cacheCompactor(buildCompactorRequest({
            requestMessages: recoveryMessages,
            requestReplay: "clear",
            requestMetadataOverride: recoveryMetadata,
            requestKeyParams: recoveryCacheKeyParams,
            requestThinking: thinkingLevel,
            requestReasoning: reasoningLevel,
          }));
        }

        let compaction;
        try {
          compaction = await cacheCompactor(buildCompactorRequest());
        } catch (err) {
          compaction = await retryWithClearedReasoningReplay(err);
        }

        log.log(
          `[L3] cache-preserving compaction: tokensBefore=${compaction.tokensBefore} ` +
          `firstKept=${compaction.firstKeptEntryId}`
        );
        return { compaction };
      } catch (err) {
        if (allowNativeFallback) {
          return fallBackToPiNative(err?.message || String(err));
        }
        log.warn(`[L3] session_before_compact hook error (cancelled): ${err?.message || err}`);
        return { cancel: true };
      }
    });
  };
}
