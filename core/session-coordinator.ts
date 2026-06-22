/**
 * SessionCoordinator — Session 生命周期管理
 *
 * 从 Engine 提取，负责 session 的创建/切换/关闭/列表、
 * isolated 执行、session 标题、activity session 提升。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { createAgentSession, SessionManager, estimateTokens, refreshSessionModelFromRegistry } from "../lib/pi-sdk/index.ts";
import { createDefaultSettings } from "./session-defaults.ts";
import { restoreDefaultWorkspaceIfMissing } from "../shared/default-workspace.ts";
import { computeHardTruncation } from "./compaction-utils.ts";
import {
  appendCompactionResultToSession,
  createCachePreservingCompactionResult,
  runCachePreservingCompactionForSession,
} from "./session-compactor.ts";
import { teardownSessionResources } from "./session-teardown.ts";
import { evaluateSessionHealth, repairOrphanToolResultEntriesInFile } from "./session-health.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { BrowserManager } from "../lib/browser/browser-manager.ts";
import { t, getLocale } from "../lib/i18n.ts";
import {
  DEFAULT_SESSION_PERMISSION_MODE,
  SESSION_PERMISSION_MODES,
  isReadOnlyPermissionMode,
  legacyAccessModeFromPermissionMode,
  normalizeSessionPermissionMode,
} from "./session-permission-mode.ts";
import { findModel } from "../shared/model-ref.ts";
import { computeToolSnapshot, DEFAULT_DISABLED_TOOL_NAMES, uniqueToolNames } from "../shared/tool-categories.ts";
import {
  computeRuntimeDisabledToolNames,
  getStableFeatureDisabledToolNames,
  toolNamesFromObjects,
} from "./tool-availability.ts";
import { isActiveSessionPath } from "./message-utils.ts";
import { formatWorkspaceScopePrompt, normalizeSessionFolderScope, normalizeWorkspaceScope } from "../shared/workspace-scope.ts";
import { getProviderPromptPatches } from "./provider-prompt-patches.ts";
import {
  DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID,
  getResolvedExperimentValue,
} from "../lib/experiments/registry.ts";
import { isDeepSeekModel } from "./provider-compat.ts";
import {
  normalizePlainDescription,
  stripClosedInternalNarrationBlocks,
} from "../lib/text/internal-narration.ts";
import { prepareVisionInputForTextOnlyModel } from "./vision-prepare.ts";
import { prepareModelImageInputsForPrompt } from "./model-image-preprocess.ts";
import {
  pruneSessionInlineMediaHistory,
  repairSessionInlineMediaEntriesInFile,
} from "./session-inline-media-prune.ts";
import {
  flushSessionManagerSnapshot,
  repairOversizedSessionEntries,
  repairOversizedSessionEntriesInFile,
  schedulePreAssistantSessionManagerFlush,
} from "./session-jsonl-file.ts";
import { createVisionContextInjectionExtension } from "./vision-context-injector.ts";
import {
  createSessionTurnContextExtension,
  normalizeSessionTurnContext,
} from "./session-turn-context.ts";
import {
  modelSupportsDirectAudioInput,
  modelSupportsAudioInput,
  modelSupportsDirectVideoInput,
  modelSupportsVideoInput,
} from "../shared/model-capabilities.ts";
import {
  normalizeSessionThinkingLevel,
  normalizeThinkingLevelForModel,
  resolveModelDefaultThinkingLevel,
  resolveThinkingLevelForModel,
} from "./session-thinking-level.ts";
import {
  resolveSessionSkillsForRuntime,
  snapshotSkillsForSession,
} from "../lib/skills/session-skill-snapshot.ts";
import { SessionListProjectionCache } from "./session-list-projection-cache.ts";
import {
  buildLlmContextCachePrefixContract,
  diffCachePrefixContracts,
  summarizeCachePrefixContract,
} from "../lib/llm/cache-prefix-contract.ts";
import { buildSessionCacheSnapshot as buildSessionCacheSnapshotValue } from "./session-cache-snapshot.ts";
import { repairRestoredToolSnapshotDetailed, sameToolNames } from "./tool-snapshot-repair.ts";
import {
  SESSION_PROMPT_SNAPSHOT_VERSION,
  freezeAgentsFilesResult,
  freezeSkillsResult,
  normalizeSessionPromptSnapshot,
  normalizeStringArray,
} from "./session-prompt-snapshot.ts";

const log = createModuleLogger("session");
const SESSION_META_PAYLOAD_DIR = "session-meta-payloads";
const SESSION_META_PAYLOAD_FIELDS = ["promptSnapshot", "memoryReflectionSnapshot"];
const SESSION_META_PAYLOAD_INLINE_LIMIT_BYTES = 256 * 1024;
const SESSION_META_INDEX_MAX_BYTES = 1024 * 1024;

/** 巡检/定时任务默认工具白名单（"*" = 与 chat 一致，全部放行） */
export const PATROL_TOOLS_DEFAULT = "*";

function isPathInsideDir(parentDir: any, childPath: any) {
  if (!parentDir || !childPath) return false;
  const rel = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function cacheContractDebugEnabled() {
  return process.env.HANA_CACHE_CONTRACT_DEBUG === "1";
}

function assertVideoInputSupported(model: any, videos: any) {
  if (!videos?.length) return;
  if (!modelSupportsVideoInput(model)) {
    throw new Error("current model does not support video input");
  }
  if (!modelSupportsDirectVideoInput(model)) {
    throw new Error("current provider does not support direct video input");
  }
}

function assertAudioInputSupported(model: any, audios: any) {
  if (!audios?.length) return;
  if (!modelSupportsAudioInput(model)) {
    throw new Error("current model does not support audio input");
  }
  if (!modelSupportsDirectAudioInput(model)) {
    throw new Error("current provider does not support direct audio input");
  }
}

function buildPromptMediaOptions(opts: any) {
  const media = [
    ...(opts?.images || []),
    ...(opts?.videos || []),
    ...(opts?.audios || []),
  ];
  if (!media.length) return undefined;
  return {
    images: media,
    ...(opts.imageAttachmentPaths?.length ? { imageAttachmentPaths: opts.imageAttachmentPaths } : {}),
    ...(opts.videoAttachmentPaths?.length ? { videoAttachmentPaths: opts.videoAttachmentPaths } : {}),
    ...(opts.audioAttachmentPaths?.length ? { audioAttachmentPaths: opts.audioAttachmentPaths } : {}),
  };
}

function normalizePluginSessionMeta({ ownerPluginId, sessionKind, sessionVisibility }: any = {}) {
  const pluginId = typeof ownerPluginId === "string" && ownerPluginId.trim()
    ? ownerPluginId.trim()
    : null;
  const kind = typeof sessionKind === "string" && sessionKind.trim()
    ? sessionKind.trim()
    : null;
  const visibility = typeof sessionVisibility === "string" && sessionVisibility.trim()
    ? sessionVisibility.trim()
    : null;
  if (!pluginId && !kind && !visibility) return null;
  return {
    ownerPluginId: pluginId,
    kind,
    visibility: visibility || "public",
  };
}

function sessionMatchesListOptions(sessionLike, options: any = {}) {
  const ownerPluginId = typeof options.ownerPluginId === "string" && options.ownerPluginId.trim()
    ? options.ownerPluginId.trim()
    : null;
  const includePluginPrivate = options.includePluginPrivate === true;
  const sessionOwnerPluginId = sessionLike?.ownerPluginId || null;
  const visibility = sessionLike?.visibility || sessionLike?.sessionVisibility || "public";
  if (ownerPluginId && sessionOwnerPluginId !== ownerPluginId) return false;
  if (
    (visibility === "plugin_private" || visibility === "private")
    && !includePluginPrivate
    && sessionOwnerPluginId !== ownerPluginId
  ) {
    return false;
  }
  return true;
}

function extractPlainTextFromContent(content: any, { stripThink = false } = {}) {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(block => block?.type === "text" && typeof block.text === "string")
      .map(block => block.text)
      .join("");
  }
  if (!stripThink) return text;
  return text.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\n*/g, "");
}

function timestampFromHistoryMessage(message: any, fallback = Date.now()) {
  if (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  if (typeof message?.timestamp === "string") {
    const parsed = Date.parse(message.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function activeToolDefinitionsFromSnapshot(allToolObjects: any, snapshotToolNames: any) {
  const allowed = snapshotToolNames === null ? null : new Set(snapshotToolNames || []);
  return (allToolObjects || [])
    .filter((tool) => tool?.name && (allowed === null || allowed.has(tool.name)))
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? tool.input_schema ?? tool.schema ?? null,
    }));
}

function normalizeDeletedAgentTranscriptMessage(message: any) {
  if (!message || typeof message !== "object") return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  const text = extractPlainTextFromContent(message.content, { stripThink: message.role === "assistant" }).trim();
  if (!text) return null;
  return {
    role: message.role,
    content: [{ type: "text", text }],
    timestamp: timestampFromHistoryMessage(message),
  };
}

function readSessionBranchMessages(sessionPath: any) {
  const manager = SessionManager.open(sessionPath, path.dirname(sessionPath));
  const branch = manager.getBranch();
  return branch
    .filter(entry => entry?.type === "message" && (entry as any).message)
    .map(entry => ({
      ...(entry as any).message,
      timestamp: (entry as any).message.timestamp ?? entry.timestamp ?? null,
    }));
}

function textOrNull(value: any) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function modelIdFromModel(model: any) {
  return textOrNull(model?.id ?? model?.modelId);
}

function resolveAssistantUsageModel(modelMeta: any, fallbackModel: any, resolveModel: any) {
  if (!modelMeta?.provider || !modelMeta?.modelId) return fallbackModel || null;
  if (
    fallbackModel?.provider === modelMeta.provider
    && modelIdFromModel(fallbackModel) === modelMeta.modelId
  ) {
    return fallbackModel;
  }
  try {
    const resolved = resolveModel?.({ id: modelMeta.modelId, provider: modelMeta.provider });
    return resolved?.model || resolved || null;
  } catch {
    return null;
  }
}

function modelMetaForAssistantUsage(message: any, fallbackModel: any, resolvedModel: any) {
  return {
    provider: textOrNull(message?.provider) ?? textOrNull(fallbackModel?.provider),
    modelId: textOrNull(message?.model) ?? modelIdFromModel(fallbackModel),
    api: textOrNull(message?.api) ?? textOrNull(resolvedModel?.api) ?? textOrNull(fallbackModel?.api),
  };
}

function costRatesForAssistantUsage({ modelMeta, resolvedModel, fallbackModel }: any) {
  if (!modelMeta?.provider || !modelMeta?.modelId) return fallbackModel?.cost ?? null;
  return resolvedModel?.cost ?? null;
}

function recordAssistantUsage({ ledger, event, sessionPath, sessionId, agentId, model, source, attribution, resolveModel }: any) {
  if (!ledger || event?.type !== "message_end" || event.message?.role !== "assistant") return null;
  const initialModelMeta = {
    provider: textOrNull(event.message?.provider) ?? textOrNull(model?.provider),
    modelId: textOrNull(event.message?.model) ?? modelIdFromModel(model),
  };
  const resolvedModel = resolveAssistantUsageModel(initialModelMeta, model, resolveModel);
  const modelMeta = modelMetaForAssistantUsage(event.message, model, resolvedModel);
  const costRates = costRatesForAssistantUsage({ modelMeta, resolvedModel, fallbackModel: model });
  const usageContext = {
    source,
    attribution: attribution || {
      kind: "session",
      agentId: agentId || null,
      ...(sessionId ? { sessionId } : {}),
      sessionPath,
    },
  };
  if (event.message?.usage) {
    return ledger.record({
      model: modelMeta,
      usage: event.message.usage,
      usageContext,
      costRates,
    });
  }
  const errorMessage = event.message?.errorMessage || event.message?.error?.message || null;
  if (event.message?.stopReason === "error" || errorMessage) {
    const request = ledger.start({
      model: modelMeta,
      usageContext,
      costRates,
    });
    return ledger.recordError(request.requestId, new Error(errorMessage || "provider request failed"));
  }
  return null;
}

function logDeepSeekReasoningVisibility({ event, model, sessionPath, agentId }: any) {
  if (!isDeepSeekModel(model)) return;
  const provider = textOrNull(model?.provider) || "deepseek";
  const modelId = modelIdFromModel(model) || "unknown";
  const sessionName = sessionPath ? path.basename(sessionPath) : "unknown";
  if (event?.type === "message_update") {
    const sub = event.assistantMessageEvent || event.event || null;
    if (sub?.type !== "thinking_delta") return;
    const chars = String(sub.delta ?? sub.text ?? sub.thinking ?? "").length;
    log.log(`[deepseek reasoning] event=thinking_delta provider=${provider} model=${modelId} agent=${agentId || ""} session=${sessionName} chars=${chars}`);
    return;
  }
  if (event?.type !== "message_end" || event.message?.role !== "assistant") return;
  const stats = collectThinkingVisibilityStats(event.message);
  const usage = event.message?.usage || {};
  const reasoningTokens = firstFiniteNumber(
    usage.reasoningTokens,
    usage.reasoning_tokens,
    usage.output?.reasoningTokens,
    usage.completion_tokens_details?.reasoning_tokens,
  );
  log.log(`[deepseek reasoning] event=message_end provider=${provider} model=${modelId} agent=${agentId || ""} session=${sessionName} thinkingBlocks=${stats.blocks} thinkingChars=${stats.chars} reasoningTokens=${reasoningTokens ?? ""} stopReason=${event.message?.stopReason || ""}`);
}

function collectThinkingVisibilityStats(message: any) {
  const blocks = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    const type = typeof value.type === "string" ? value.type : "";
    if (type === "thinking" || type === "reasoning" || type === "reasoning_text") {
      blocks.push(value);
    }
    for (const key of ["content", "thinking", "reasoning", "reasoningText", "text"]) {
      if (key === "text" && type !== "thinking" && type !== "reasoning" && type !== "reasoning_text") continue;
      const child = value[key];
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(message?.content);
  const chars = blocks.reduce((total, block) => (
    total
      + String(block.thinking ?? block.reasoning ?? block.reasoningText ?? block.text ?? block.content ?? "").length
  ), 0);
  return { blocks: blocks.length, chars };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function collectAssistantTextFromMessage(message: any) {
  if (!message) return "";
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function addUniqueSessionFile(target: any[], file: any) {
  if (!file || typeof file !== "object") return;
  const key = file.id || file.fileId || file.filePath || file.path || file.realPath || JSON.stringify(file);
  if (target.some((existing) => (
    (existing.id || existing.fileId || existing.filePath || existing.path || existing.realPath || JSON.stringify(existing)) === key
  ))) {
    return;
  }
  target.push(file);
}

function collectSessionFilesFromToolResult(result: any) {
  const files = [];
  const details = result?.details;
  addUniqueSessionFile(files, details?.sessionFile);
  if (Array.isArray(details?.sessionFiles)) {
    for (const file of details.sessionFiles) addUniqueSessionFile(files, file);
  }
  return files;
}

function toolErrorSummary(event: any) {
  const toolName = event?.toolName || event?.name || "tool";
  const raw = event?.error || event?.result?.error || event?.result?.message || event?.message;
  const message = typeof raw === "string" ? raw : raw?.message || "";
  return message ? `${toolName}: ${message}` : `${toolName}: failed`;
}

function isolatedCompletionError(stopReason: any, errorMessage: any) {
  if (!stopReason || stopReason === "stop") return null;
  const message = typeof errorMessage === "string" ? errorMessage : errorMessage?.message;
  if (stopReason === "error") {
    return message || "assistant message ended with stopReason=error";
  }
  if (stopReason === "length") {
    return "assistant message ended with stopReason=length (output limit reached)";
  }
  return `assistant message ended with stopReason=${stopReason}`;
}

const MAX_CACHED_SESSIONS = 20;
const MiB = 1024 * 1024;
const DEFAULT_RUNTIME_PRESSURE_THRESHOLDS = Object.freeze({
  checkDelayMs: 1500,
  minRetainedBytes: 16 * MiB,
  highPayloadBytes: 64 * MiB,
  highRssBytes: 1536 * MiB,
  highExternalBytes: 512 * MiB,
});

function normalizeMemoryPressureOptions(raw: any) {
  if (raw === false || raw?.enabled === false) {
    return {
      enabled: false,
      getMemoryUsage: () => process.memoryUsage(),
      thresholds: DEFAULT_RUNTIME_PRESSURE_THRESHOLDS,
    };
  }
  return {
    enabled: true,
    getMemoryUsage: typeof raw?.getMemoryUsage === "function"
      ? raw.getMemoryUsage
      : () => process.memoryUsage(),
    thresholds: {
      ...DEFAULT_RUNTIME_PRESSURE_THRESHOLDS,
      ...(raw?.thresholds || {}),
    },
  };
}

function estimateSessionRuntimeRetainedBytes(session: any) {
  const seen = new WeakSet();
  const stateMessages = session?.agent?.state?.messages;
  const messages = Array.isArray(session?.messages)
    ? session.messages
    : Array.isArray(stateMessages)
      ? stateMessages
      : [];
  return estimateRetainedValueBytes(messages, seen, { count: 0 });
}

function estimateRetainedValueBytes(value: any, seen: WeakSet<any>, budget: any, depth = 0) {
  if (value == null || depth > 10 || budget.count > 20_000) return 0;
  budget.count += 1;

  if (typeof value === "string") {
    return value.length >= 8192 ? value.length : 0;
  }
  if (typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);

  let total = 0;
  if (Array.isArray(value)) {
    for (const item of value) total += estimateRetainedValueBytes(item, seen, budget, depth + 1);
    return total;
  }

  if ((value.type === "image" || value.type === "video") && typeof value.data === "string") {
    total += value.data.length;
  }
  if ((value.type === "image" || value.type === "video") && typeof value.source?.data === "string") {
    total += value.source.data.length;
  }

  for (const [key, child] of Object.entries(value)) {
    if ((value.type === "image" || value.type === "video") && (key === "data" || key === "source")) {
      continue;
    }
    total += estimateRetainedValueBytes(child, seen, budget, depth + 1);
  }
  return total;
}

function makeBackgroundTaskPrompt(locale: any) {
  const isZh = String(locale || "").startsWith("zh");
  return isZh
    ? `## 后台任务

派出 subagent 或其他后台任务后：

1. 先继续做手头还没做完的工作，不要立刻停下来等
2. 手头工作做完后，调 check_pending_tasks 查看后台任务状态
3. 如果还有任务未完成，不要轮询等待；告知用户任务仍在后台运行，完成后会自动处理
4. 只有需要你继续处理的后台任务，系统才会以 <hana-background-result> 消息送达结果；媒体生成成功由界面和 Bridge 自动处理，不要等待或主动追问。媒体生成失败可能会以 <hana-background-result> 送达：只说明失败原因，并询问用户是否要你新生成一张；原地重新生成只由用户在 UI 中操作`
    : `## Background Tasks

After dispatching subagent or other background tasks:

1. Continue with any remaining work first — do not stop immediately to wait
2. Once your other work is done, call check_pending_tasks to check status
3. If tasks are still pending, do not poll or wait; tell the user the task is still running and will be handled in the background
4. Only background tasks that need your follow-up are delivered via <hana-background-result> messages. Successful media generation is handled by the UI and Bridge automatically; do not wait for it or ask about it again. Failed media generation may be delivered via <hana-background-result>: explain only why it failed, then ask whether the user wants you to create a new image. In-place regeneration is a UI-only action for the user`;
}

function buildAppendSystemPromptSnapshot({
  baseAppend,
  providerPromptPatches,
  hasDeferredResultStore,
  locale,
  workspaceScope,
}: any) {
  const parts = [
    ...(Array.isArray(baseAppend) ? baseAppend : []),
    ...(Array.isArray(providerPromptPatches) ? providerPromptPatches : []),
  ];
  if (hasDeferredResultStore) {
    parts.push(makeBackgroundTaskPrompt(locale));
  }
  const workspacePrompt = formatWorkspaceScopePrompt({
    primaryCwd: workspaceScope.primaryCwd,
    workspaceFolders: workspaceScope.workspaceFolders,
    locale,
  });
  if (workspacePrompt) parts.push(workspacePrompt);
  return normalizeStringArray(parts);
}

function readDeepSeekRoleplayExperimentFlag(prefs: any) {
  return getResolvedExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID) === true;
}

function normalizeOptionalText(value: any) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDeepSeekRoleplayReasoningContext(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const locale = normalizeOptionalText(value.locale);
  const agentName = normalizeOptionalText(value.agentName);
  const agentDescription = normalizePlainDescription(value.agentDescription || "", 160);
  if (!locale && !agentName && !agentDescription) return null;
  return {
    ...(locale ? { locale } : {}),
    ...(agentName ? { agentName } : {}),
    ...(agentDescription ? { agentDescription } : {}),
  };
}

function readAgentRosterDescription(agent: any) {
  if (agent?.agentDir) {
    try {
      const raw = fs.readFileSync(path.join(agent.agentDir, "description.md"), "utf-8");
      const withoutHash = raw.split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("<!--"))
        .join("\n");
      const description = normalizePlainDescription(withoutHash, 160);
      if (description) return description;
    } catch {}
  }
  return "";
}

function buildDeepSeekRoleplayReasoningContext(agent: any) {
  return normalizeDeepSeekRoleplayReasoningContext({
    locale: agent?.config?.locale || getLocale(),
    agentName: agent?.agentName || agent?.name || agent?.config?.agent?.name || agent?.id,
    agentDescription: readAgentRosterDescription(agent),
  });
}

function normalizeSessionExperimentFlags(value: any) {
  const context = normalizeDeepSeekRoleplayReasoningContext(value?.deepseekRoleplayReasoningContext);
  return {
    deepseekRoleplayReasoningPatch: value?.deepseekRoleplayReasoningPatch === true,
    ...(context ? { deepseekRoleplayReasoningContext: context } : {}),
  };
}

function sessionExperimentFlagsForMeta(value: any) {
  const flags = normalizeSessionExperimentFlags(value);
  return flags.deepseekRoleplayReasoningPatch === true ? flags : null;
}

function hasSessionPermissionModeFields(value: any) {
  return !!value && typeof value === "object" && (
    typeof value.permissionMode === "string"
    || typeof value.accessMode === "string"
    || value.planMode === true
  );
}

function normalizeSessionWorkspaceMount(value: any) {
  const mountId = typeof value?.workspaceMountId === "string" && value.workspaceMountId.trim()
    ? value.workspaceMountId.trim()
    : (typeof value?.mountId === "string" && value.mountId.trim() ? value.mountId.trim() : null);
  if (!mountId) return null;
  const label = typeof value?.workspaceLabel === "string" && value.workspaceLabel.trim()
    ? value.workspaceLabel.trim()
    : (typeof value?.label === "string" && value.label.trim() ? value.label.trim() : null);
  return {
    mountId,
    label,
  };
}

export class SessionCoordinator {
  declare _d: any;
  declare _pendingModel: any;
  declare _session: any;
  declare _currentSessionPath: string;
  declare _sessionStarted: boolean;
  declare _sessions: Map<string, any>;
  declare _hibernatedSessionMeta: Map<string, any>;
  declare _runtimePressureTimers: Map<string, any>;
  declare _memoryPressure: any;
  declare _headlessOps: Set<string>;
  declare _titlesCache: Map<string, any>;
  declare _metaCache: Map<string, any>;
  declare _sessionListProjectionCache: SessionListProjectionCache;
  declare _pendingPermissionMode: any;
  declare _runtimePermissionModeDefault: any;
  declare _metaWriteQueue: Promise<any>;
  declare _prePromptAbortControllers: Map<string, AbortController>;
  declare _turnContextBySession: Map<string, any>;
  declare _sessionManifestStore: any;

  /**
   * @param {object} deps
   * @param {string} deps.agentsDir
   * @param {() => object} deps.getAgent - 当前焦点 agent
   * @param {() => string} deps.getActiveAgentId
   * @param {() => import('./model-manager.ts').ModelManager} deps.getModels
   * @param {() => object} deps.getResourceLoader
   * @param {() => import('./skill-manager.ts').SkillManager} deps.getSkills
   * @param {(cwd, customTools?, opts?) => object} deps.buildTools
   * @param {(event, sp) => void} deps.emitEvent
   * @param {() => string|null} deps.getHomeCwd
   * @param {(path) => string|null} deps.agentIdFromSessionPath
   * @param {(id) => Promise} deps.switchAgentOnly - 仅切换 agent 指针
   * @param {() => object} deps.getConfig
   * @param {() => Map} deps.getAgents
   * @param {(agentId) => object} deps.getActivityStore
   * @param {(agentId) => object|null} deps.getAgentById
   * @param {() => object} deps.listAgents - 列出所有 agent
   * @param {(cwd: string) => Promise<void>} [deps.onBeforeSessionCreate]
   * @param {(sessionPath: string, reason: string) => void|Promise<void>} [deps.onSessionRuntimeDiscarded]
   */
  constructor(deps: any) {
    this._d = deps;
    this._pendingModel = null;
    this._session = null;
    this._currentSessionPath = null;
    this._sessionStarted = false;
    this._sessions = new Map();
    this._hibernatedSessionMeta = new Map();
    this._runtimePressureTimers = new Map();
    this._memoryPressure = normalizeMemoryPressureOptions(deps.memoryPressure);
    this._headlessOps = new Set();
    this._titlesCache = new Map(); // sessionDir → { titles, ts }
    this._metaCache = new Map();   // metaPath → { data, ts }
    this._sessionListProjectionCache = deps.sessionListProjectionCache || new SessionListProjectionCache();
    this._pendingPermissionMode = null;
    this._runtimePermissionModeDefault = null;
    this._metaWriteQueue = Promise.resolve();
    this._prePromptAbortControllers = new Map();
    this._turnContextBySession = new Map();
    this._sessionManifestStore = deps.sessionManifestStore || null;
  }

  static _TITLES_TTL = 60_000; // 60 秒

  get session() { return this._session; }
  get sessionStarted() { return this._sessionStarted; }
  get sessions() { return this._sessions; }

  setPendingModel(model: any) { this._pendingModel = model; }
  get pendingModel() { return this._pendingModel; }

  _getDefaultThinkingLevelForModel(model = null) {
    const models = this._d.getModels();
    const fallback = normalizeSessionThinkingLevel(this._d.getPrefs().getThinkingLevel());
    const targetModel = model || this._pendingModel || models?.currentModel || null;
    if (typeof models?.getModelDefaultThinkingLevel === "function") {
      return models.getModelDefaultThinkingLevel(targetModel, fallback);
    }
    return resolveModelDefaultThinkingLevel(targetModel, fallback);
  }

  getDefaultThinkingLevel() {
    return this._getDefaultThinkingLevelForModel();
  }

  async setDefaultThinkingLevel(level: any) {
    const models = this._d.getModels();
    const fallback = normalizeSessionThinkingLevel(this._d.getPrefs().getThinkingLevel());
    const targetModel = this._pendingModel || models?.currentModel || null;
    if (!targetModel?.id || !targetModel.provider) {
      return { ok: false, error: "model not found", thinkingLevel: fallback };
    }
    if (typeof models.setModelDefaultThinkingLevel !== "function") {
      return { ok: false, error: "model thinking defaults unavailable", thinkingLevel: fallback };
    }
    const result = await models.setModelDefaultThinkingLevel(targetModel, level);
    if (
      this._pendingModel
      && result?.model?.id === this._pendingModel.id
      && result.model.provider === this._pendingModel.provider
    ) {
      this._pendingModel = result.model;
    }
    return {
      ok: true,
      thinkingLevel: normalizeSessionThinkingLevel(result?.thinkingLevel),
    };
  }

  get currentSessionPath() {
    return this._session?.sessionManager?.getSessionFile?.() ?? this._currentSessionPath ?? null;
  }

  _resolveSessionManifestForPath(sessionPath: any) {
    if (!this._sessionManifestStore || !sessionPath) return null;
    return this._sessionManifestStore.resolveByLocatorPath(sessionPath);
  }

  _resolveSessionManifestForId(sessionId: any) {
    if (!this._sessionManifestStore || !sessionId) return null;
    return this._sessionManifestStore.getBySessionId(sessionId);
  }

  _normalizeSessionRef(ref: any) {
    if (typeof ref === "string") return { sessionId: null, sessionPath: ref };
    if (!ref || typeof ref !== "object") return { sessionId: null, sessionPath: null };
    const sessionId = typeof ref.sessionId === "string" && ref.sessionId.trim()
      ? ref.sessionId.trim()
      : null;
    const sessionPath = typeof ref.sessionPath === "string" && ref.sessionPath.trim()
      ? ref.sessionPath
      : typeof ref.path === "string" && ref.path.trim()
        ? ref.path
        : null;
    return { sessionId, sessionPath };
  }

  _resolveSessionWriteRef(ref: any, operation: string) {
    const normalized = this._normalizeSessionRef(ref);
    if (normalized.sessionId) {
      const manifest = this._resolveSessionManifestForId(normalized.sessionId);
      const sessionPath = manifest?.currentLocator?.path || null;
      if (!sessionPath) {
        const error: any = new Error(`${operation}: session manifest not found for ${normalized.sessionId}`);
        error.code = "session_manifest_not_found";
        error.status = 404;
        throw error;
      }
      return {
        sessionId: normalized.sessionId,
        sessionPath,
        manifest,
      };
    }
    if (!normalized.sessionPath) {
      throw new Error(`${operation}: sessionPath is required`);
    }
    const manifest = this._resolveSessionManifestForPath(normalized.sessionPath);
    return {
      sessionId: manifest?.sessionId || null,
      sessionPath: normalized.sessionPath,
      manifest,
    };
  }

  _ensureSessionManifestForPath(sessionPath: any, input: any = {}) {
    if (!this._sessionManifestStore || !sessionPath) return null;
    const existing = this._sessionManifestStore.resolveByLocatorPath(sessionPath);
    if (existing) return existing;
    return this._sessionManifestStore.createForPath({
      sessionPath,
      ...input,
    });
  }

  _sessionIdForPath(sessionPath: any) {
    try {
      return this._resolveSessionManifestForPath(sessionPath)?.sessionId || null;
    } catch (err) {
      log.warn(`session manifest lookup failed for ${path.basename(sessionPath || "")}: ${err?.message || err}`);
      return null;
    }
  }

  _readSessionCapabilitySnapshot(sessionPath: any) {
    if (!this._sessionManifestStore || !sessionPath) return null;
    try {
      const manifest = this._resolveSessionManifestForPath(sessionPath);
      if (!manifest?.sessionId || typeof this._sessionManifestStore.getCapabilitySnapshot !== "function") return null;
      return this._sessionManifestStore.getCapabilitySnapshot(manifest.sessionId);
    } catch (err) {
      log.warn(`session capability snapshot read failed for ${path.basename(sessionPath || "")}: ${err?.message || err}`);
      return null;
    }
  }

  _writeSessionCapabilitySnapshot(sessionPath: any, partial: any, source = "session_meta_write") {
    if (!this._sessionManifestStore || !sessionPath || !partial || typeof partial !== "object") return;
    if (typeof this._sessionManifestStore.setCapabilitySnapshot !== "function") return;
    const snapshot: any = {};
    if (Object.prototype.hasOwnProperty.call(partial, "toolNames")) {
      snapshot.toolNames = partial.toolNames;
    }
    if (Object.prototype.hasOwnProperty.call(partial, "promptSnapshot")) {
      snapshot.promptSnapshot = partial.promptSnapshot;
    }
    if (Object.prototype.hasOwnProperty.call(partial, "capabilityDriftDismissedFingerprint")) {
      snapshot.capabilityDriftDismissedFingerprint = partial.capabilityDriftDismissedFingerprint;
    }
    if (Object.keys(snapshot).length === 0) return;
    try {
      const manifest = this._resolveSessionManifestForPath(sessionPath);
      if (!manifest?.sessionId) return;
      this._sessionManifestStore.setCapabilitySnapshot(manifest.sessionId, snapshot, { source });
    } catch (err) {
      log.warn(`session capability snapshot write failed for ${path.basename(sessionPath || "")}: ${err?.message || err}`);
    }
  }

  getSessionExecutorMetadata(ref: any) {
    if (!this._sessionManifestStore || typeof this._sessionManifestStore.getExecutorMetadata !== "function") return null;
    try {
      const normalized = this._normalizeSessionRef(ref);
      const sessionId = normalized.sessionId
        || (normalized.sessionPath ? this._resolveSessionManifestForPath(normalized.sessionPath)?.sessionId : null);
      return sessionId ? this._sessionManifestStore.getExecutorMetadata(sessionId) : null;
    } catch (err) {
      log.warn(`session executor metadata read failed: ${err?.message || err}`);
      return null;
    }
  }

  setSessionExecutorMetadata(ref: any, metadata: any, options: any = {}) {
    if (!this._sessionManifestStore || typeof this._sessionManifestStore.setExecutorMetadata !== "function") return null;
    const normalized = this._normalizeSessionRef(ref);
    let manifest = null;
    if (normalized.sessionId) {
      manifest = this._resolveSessionManifestForId(normalized.sessionId);
    } else if (normalized.sessionPath) {
      manifest = this._resolveSessionManifestForPath(normalized.sessionPath)
        || this._ensureSessionManifestForPath(normalized.sessionPath, {
          ownerAgentId: this._d.agentIdFromSessionPath?.(normalized.sessionPath) || null,
          domain: "desktop",
          kind: options.kind || "chat",
          provenance: { createdBy: options.provenance || "session_executor_metadata" },
          locatorReason: options.locatorReason || "session_executor_metadata",
          ...(options.manifestDefaults || {}),
        });
    }
    if (!manifest?.sessionId) return null;
    try {
      return this._sessionManifestStore.setExecutorMetadata(
        manifest.sessionId,
        metadata,
        { source: options.source || "subagent_runtime" },
      );
    } catch (err) {
      log.warn(`session executor metadata write failed: ${err?.message || err}`);
      return null;
    }
  }

  _sessionTitleKeyForPath(sessionPath: any) {
    return this._sessionIdForPath(sessionPath) || sessionPath;
  }

  _sessionTitleFromMap(titles: any, sessionPath: any, extraLegacyPaths: any[] = []) {
    if (!titles || !sessionPath) return null;
    const keys: string[] = [];
    const sessionId = this._sessionIdForPath(sessionPath);
    if (sessionId) keys.push(sessionId);
    for (const candidate of [sessionPath, ...extraLegacyPaths]) {
      if (!candidate) continue;
      keys.push(candidate);
      keys.push(path.basename(candidate));
    }
    for (const key of [...new Set(keys)]) {
      if (Object.prototype.hasOwnProperty.call(titles, key) && titles[key]) return titles[key];
    }
    return null;
  }

  _sessionRuntimeKeyForPath(sessionPath: any, opts: any = {}) {
    if (!sessionPath) return null;
    if (!this._sessionManifestStore) return sessionPath;
    try {
      const manifest = opts.create === true
        ? this._ensureSessionManifestForPath(sessionPath, opts.manifestDefaults || {})
        : this._resolveSessionManifestForPath(sessionPath);
      return manifest?.sessionId || sessionPath;
    } catch (err) {
      if (opts.warn !== false) {
        log.warn(`session runtime key lookup failed for ${path.basename(sessionPath || "")}: ${err?.message || err}`);
      }
      return sessionPath;
    }
  }

  _sessionPathForEntry(entry: any, fallbackKey: any = null) {
    return entry?.sessionPath
      || entry?.session?.sessionManager?.getSessionFile?.()
      || (typeof fallbackKey === "string" && fallbackKey.endsWith(".jsonl") ? fallbackKey : null);
  }

  _getSessionEntryByPath(sessionPath: any) {
    const key = this._sessionRuntimeKeyForPath(sessionPath, { warn: false });
    if (!key) return null;
    return this._sessions.get(key) || (key !== sessionPath ? this._sessions.get(sessionPath) : null) || null;
  }

  _setRuntimeValueForPath(map: Map<string, any>, sessionPath: any, value: any, opts: any = {}) {
    const key = this._sessionRuntimeKeyForPath(sessionPath, opts);
    if (!key) return null;
    map.set(key, value);
    if (key !== sessionPath) map.delete(sessionPath);
    return key;
  }

  _getRuntimeValueForPath(map: Map<string, any>, sessionPath: any) {
    const key = this._sessionRuntimeKeyForPath(sessionPath, { warn: false });
    if (!key) return null;
    return map.get(key) || (key !== sessionPath ? map.get(sessionPath) : null) || null;
  }

  _deleteRuntimeValueForPath(map: Map<string, any>, sessionPath: any) {
    const key = this._sessionRuntimeKeyForPath(sessionPath, { warn: false });
    if (!key) return false;
    const deleted = map.delete(key);
    const legacyDeleted = key !== sessionPath ? map.delete(sessionPath) : false;
    return deleted || legacyDeleted;
  }

  _hasRuntimeValueForPath(map: Map<string, any>, sessionPath: any) {
    const key = this._sessionRuntimeKeyForPath(sessionPath, { warn: false });
    if (!key) return false;
    return map.has(key) || (key !== sessionPath && map.has(sessionPath));
  }

  buildSessionCacheSnapshot(sessionPath: any, { reason = "unknown", messages = null }: any = {}) {
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry?.session) {
      throw new Error(`Session cache snapshot unavailable: unknown session ${sessionPath || "(empty)"}`);
    }
    const session = entry.session;
    const state = session.agent?.state || {};
    return buildSessionCacheSnapshotValue({
      sessionPath,
      reason,
      model: session.model || state.model || null,
      cacheKeyParams: {
        thinkingLevel: entry.thinkingLevel || state.thinkingLevel || session.thinkingLevel || "off",
      },
      systemPrompt: this._getFinalSystemPrompt(session) ?? state.systemPrompt ?? "",
      tools: entry.activeToolDefinitions || [],
      messages: Array.isArray(messages) ? messages : (Array.isArray(state.messages) ? state.messages : []),
    });
  }

  getSessionStreamFn(sessionPath: any) {
    const entry = this._getSessionEntryByPath(sessionPath);
    return entry?.session?.agent?.streamFn || null;
  }

  async reloadExtensionRunners(reason = "extension_factories_changed") {
    const summary = { reloaded: 0, skipped: 0, failed: 0 };
    for (const [sessionKey, entry] of this._sessions) {
      const sessionPath = this._sessionPathForEntry(entry, sessionKey);
      const session = entry?.session;
      if (!session || typeof session.reload !== "function") {
        summary.skipped += 1;
        continue;
      }
      if (session.isStreaming || session.isCompacting || entry._switching) {
        summary.skipped += 1;
        continue;
      }
      try {
        await session.reload();
        entry.lastTouchedAt = Date.now();
        summary.reloaded += 1;
      } catch (err) {
        summary.failed += 1;
        log.warn(`reload extensions failed for ${path.basename(sessionPath)} (${reason}): ${err?.message || err}`);
      }
    }
    return summary;
  }

  // ── Session 创建 / 切换 ──

  async createSession(sessionMgr: any, cwd: any, memoryEnabled = true, model: any = null, {
    restore = false,
    agent: explicitAgent = null,
    agentId: explicitAgentId = null,
    preserveAgentMemoryState = false,
    workspaceFolders = [],
    authorizedFolders = [],
    visibleInSessionList = false,
    thinkingLevel = null,
    workspaceMountId = null,
    workspaceLabel = null,
    ownerPluginId = null,
    sessionKind = null,
    sessionVisibility = null,
    // #1624 显式刷新（fresh compact）：restore 时忽略冻结的 promptSnapshot/toolNames，
    // 按当前 agent 配置重建两份快照并持久化。只在用户显式触发时为 true。
    refreshCapabilitySnapshots = false,
  }: any = {}) {
    const t0 = Date.now();
    const agent = explicitAgent
      || (explicitAgentId ? this._d.getAgentById?.(explicitAgentId) : null)
      || this._d.getAgent();
    if (!agent) {
      throw new Error("createSession: target agent unavailable");
    }
    const ownerAgentId = explicitAgentId || agent.id || this._d.getActiveAgentId();
    const effectiveCwd = cwd || this._d.getHomeCwd(agent.id) || process.cwd();
    restoreDefaultWorkspaceIfMissing(effectiveCwd);
    const models = this._d.getModels();
    // restore 模式：不指定 model，让 PI SDK 从 JSONL 恢复（session model 单一数据源）
    const effectiveModel = restore ? null : (model || this._pendingModel || models.currentModel);
    this._pendingModel = null;
    log.log(`createSession cwd=${effectiveCwd} restore=${restore} (传入: ${cwd || "未指定"})`);

    await this._d.onBeforeSessionCreate?.(effectiveCwd);

    if (!restore && !effectiveModel) {
      throw new Error(t("error.noAvailableModel"));
    }
    if (!sessionMgr) {
      sessionMgr = SessionManager.create(effectiveCwd, agent.sessionDir);
    }
    const sessionPathForMeta = sessionMgr.getSessionFile?.() || null;
    let restoredCapabilitySnapshot = restore && sessionPathForMeta
      ? this._readSessionCapabilitySnapshot(sessionPathForMeta)
      : null;
    let restoredThinkingLevel = null;
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        if (typeof metaEntry?.thinkingLevel === "string") {
          restoredThinkingLevel = metaEntry.thinkingLevel;
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session thinking level restore failed: ${err.message}`);
        }
      }
    }
    // #1624 refreshCapabilitySnapshots：跳过冻结 promptSnapshot，下游 fresh-build
    // 路径会按当前配置重建并在 metaPatch 持久化（与 !restoredPromptSnapshot 同一条路）。
    const restoredPromptSnapshot = restore && sessionPathForMeta && !refreshCapabilitySnapshots
      ? (
        normalizeSessionPromptSnapshot(restoredCapabilitySnapshot?.promptSnapshot)
        || await this._readSessionPromptSnapshot(agent, sessionPathForMeta)
      )
      : null;
    const restoredPromptModel = restore && !restoredPromptSnapshot
      ? this._resolvePromptModelFromSessionManager(sessionMgr, models)
      : null;
    const promptPatchModel = restoredPromptSnapshot ? null : (effectiveModel || restoredPromptModel);
    const requestedThinkingLevel = normalizeSessionThinkingLevel(
      restore
        ? (restoredThinkingLevel || this._getDefaultThinkingLevelForModel(promptPatchModel))
        : (thinkingLevel ?? this._getDefaultThinkingLevelForModel(effectiveModel)),
    );
    let initialThinkingLevel = normalizeThinkingLevelForModel(requestedThinkingLevel, promptPatchModel);
    let resolvedThinkingLevel = models.resolveThinkingLevel(initialThinkingLevel);
    const providerPromptPatches = promptPatchModel
      ? getProviderPromptPatches(promptPatchModel, {
        reasoningLevel: resolvedThinkingLevel,
        locale: agent.config?.locale || getLocale(),
      })
      : [];
    let workspaceMount = normalizeSessionWorkspaceMount({ workspaceMountId, workspaceLabel });
    let workspaceScope = normalizeWorkspaceScope({
      primaryCwd: effectiveCwd,
      workspaceFolders,
    });
    let folderScope = normalizeSessionFolderScope({
      primaryCwd: effectiveCwd,
      workspaceFolders: workspaceScope.workspaceFolders,
      authorizedFolders,
    });
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        const restoredFolders = metaEntry?.workspaceFolders;
        const restoredAuthorizedFolders = metaEntry?.authorizedFolders;
        workspaceMount = normalizeSessionWorkspaceMount(metaEntry);
        workspaceScope = normalizeWorkspaceScope({
          primaryCwd: effectiveCwd,
          workspaceFolders: restoredFolders,
        });
        folderScope = normalizeSessionFolderScope({
          primaryCwd: effectiveCwd,
          workspaceFolders: workspaceScope.workspaceFolders,
          authorizedFolders: restoredAuthorizedFolders,
        });
      } catch {
        // session-meta 可选：读取或解析失败时沿用上面 fresh 算出的 workspaceScope。
      }
    }
    // 冻结当前 session 的有效记忆参与态。
    // fresh create: 以"创建当下实际会进入 prompt 前缀的状态"为准（master && session）
    // restore: 以 session-meta 里冻结下来的 memoryEnabled 为准。
    // 这样已有 session 的 prefix 身份不会被后续 master 开关漂移打穿。
    const restoredMemoryEnabled = restore && sessionPathForMeta
      ? this._readSessionMemoryEnabledFromMeta(sessionPathForMeta)
      : null;
    const frozenMemoryEnabled = restore
      ? (typeof restoredMemoryEnabled === "boolean" ? restoredMemoryEnabled : !!memoryEnabled)
      : (agent.memoryMasterEnabled !== false && !!memoryEnabled);
    let restoredExperienceEnabled = false;
    let restoredExperimentFlags = null;
    if (restore && sessionPathForMeta) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        restoredExperienceEnabled = metaEntry?.experienceEnabled === true;
        restoredExperimentFlags = normalizeSessionExperimentFlags(metaEntry?.experiments);
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session-meta.json 读取 experienceEnabled 失败: ${err.message}`);
        }
      }
    }
    const agentHasExperienceSwitch = typeof agent.experienceEnabled === "boolean";
    const frozenExperienceEnabled = restore
      ? restoredExperienceEnabled
      : (agentHasExperienceSwitch ? agent.experienceEnabled === true : false);
    const freshDeepSeekRoleplayEnabled = !restore
      && readDeepSeekRoleplayExperimentFlag(this._d.getPrefs?.());
    const frozenExperimentFlags = restore
      ? normalizeSessionExperimentFlags(restoredExperimentFlags)
      : normalizeSessionExperimentFlags({
        deepseekRoleplayReasoningPatch: freshDeepSeekRoleplayEnabled,
        deepseekRoleplayReasoningContext: freshDeepSeekRoleplayEnabled
          ? buildDeepSeekRoleplayReasoningContext(agent)
          : null,
      });

    const baseResourceLoader = this._d.getResourceLoader();
    let restoredPermissionMode = null;
    if (restore && sessionPathForMeta) {
      const manifest = this._resolveSessionManifestForPath(sessionPathForMeta);
      if (manifest?.permissionModeSnapshot?.mode) {
        restoredPermissionMode = normalizeSessionPermissionMode(manifest.permissionModeSnapshot.mode);
      }
    }
    if (restore && sessionPathForMeta && restoredPermissionMode === null) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPathForMeta)];
        if (hasSessionPermissionModeFields(metaEntry)) {
          restoredPermissionMode = normalizeSessionPermissionMode(metaEntry);
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session permission mode restore failed: ${err.message}`);
        }
      }
    }
    let initialPermissionMode = restore
      ? normalizeSessionPermissionMode(restoredPermissionMode)
      : normalizeSessionPermissionMode(this._pendingPermissionMode || this._getDefaultPermissionMode());
    this._pendingPermissionMode = null;
    let initialAccessMode = legacyAccessModeFromPermissionMode(initialPermissionMode);
    let initialPlanMode = isReadOnlyPermissionMode(initialPermissionMode);
    const sessionEntry = {
      permissionMode: initialPermissionMode,
      accessMode: initialAccessMode,
      planMode: initialPlanMode,
      thinkingLevel: initialThinkingLevel,
      experiments: frozenExperimentFlags,
      visibleInSessionList: visibleInSessionList === true && !restore,
      sessionId: null as string | null,
    }; // pre-populated for resourceLoader proxy
    const pluginSessionMeta = normalizePluginSessionMeta({ ownerPluginId, sessionKind, sessionVisibility });

    // 快照当前 system prompt，per-session 隔离。
    // 后续记忆编译、技能变更只影响新对话，已有对话的 prompt 不变（保护 prefix cache）。
    const systemPromptSnapshot = restoredPromptSnapshot?.systemPrompt
      ?? agent.buildSystemPrompt({
        forceMemoryEnabled: frozenMemoryEnabled,
        forceExperienceEnabled: frozenExperienceEnabled,
        cwdOverride: effectiveCwd,
        targetModel: promptPatchModel,
      });
    const memoryReflectionSnapshot = (!restore && typeof agent.buildMemoryReflectionSnapshot === "function")
      ? agent.buildMemoryReflectionSnapshot({ forceMemoryEnabled: frozenMemoryEnabled })
      : null;

    const localeSnapshot = agent.config?.locale || getLocale();
    const skills = this._d.getSkills?.();
    const appendSystemPromptSnapshot = restoredPromptSnapshot?.appendSystemPrompt
      ?? buildAppendSystemPromptSnapshot({
        baseAppend: baseResourceLoader.getAppendSystemPrompt?.() || [],
        providerPromptPatches,
        hasDeferredResultStore: !!this._d.getDeferredResultStore?.(),
        locale: localeSnapshot,
        workspaceScope,
      });
    const rawSkillsResultSnapshot = restoredPromptSnapshot?.skillsResult
      ?? (
        skills?.getSkillsForAgent
          ? freezeSkillsResult(skills.getSkillsForAgent(agent))
          : freezeSkillsResult(baseResourceLoader.getSkills?.())
      );
    const skillsResultSnapshot = restoredPromptSnapshot?.skillsResult
      ? freezeSkillsResult(restoredPromptSnapshot.skillsResult)
      : freezeSkillsResult(await snapshotSkillsForSession(rawSkillsResultSnapshot, sessionPathForMeta));
    const agentsFilesResultSnapshot = restoredPromptSnapshot?.agentsFilesResult
      ?? freezeAgentsFilesResult(baseResourceLoader.getAgentsFiles?.());
    const promptSnapshotForPersist = restoredPromptSnapshot || {
      version: SESSION_PROMPT_SNAPSHOT_VERSION,
      systemPrompt: systemPromptSnapshot,
      appendSystemPrompt: appendSystemPromptSnapshot,
      skillsResult: skillsResultSnapshot,
      agentsFilesResult: agentsFilesResultSnapshot,
    };

    const sessionPathRef = { current: sessionPathForMeta };
    const targetModelRef = { current: promptPatchModel || effectiveModel || null };
    const warnVisionContextInjection = (entry) => {
      if (typeof entry === "string") {
        log.warn(entry);
        return;
      }
      log.warn(`vision context injection diagnostic: ${JSON.stringify(entry)}`);
    };

    // Vision 辅助注入扩展：只在目标模型需要图片辅助笔记时注入视觉上下文。
    // 注入器由 Hana 持有 session/model 引用，不读取 Pi SDK ctx，避免 restore 后 stale ctx 丢失 sidecar 笔记。
    // 用户当前 UI 视野不再自动注入；需要时由 current_status(ui_context) 显式查询。
    const getEngine = this._d.getEngine;
    const visionAuxiliaryExtension = createVisionContextInjectionExtension({
      path: "hana-desktop-vision-context-injection",
      sessionPathRef,
      targetModelRef,
      getVisionBridge: () => getEngine?.()?.getVisionBridge?.(),
      isVisionAuxiliaryEnabled: () => getEngine?.()?.isVisionAuxiliaryEnabled?.() === true,
      resolveSessionFile: ({ fileId, filePath, sessionPath }) => {
        const engine = getEngine?.();
        const lookupSessionPath = sessionPath || sessionPathRef.current || null;
        if (fileId) return engine?.getSessionFile?.(fileId, { sessionPath: lookupSessionPath });
        if (filePath) return engine?.getSessionFileByPath?.(filePath, { sessionPath: lookupSessionPath });
        return null;
      },
      warn: warnVisionContextInjection,
    });
    const turnContextExtension = createSessionTurnContextExtension({
      path: "hana-desktop-session-turn-context",
      sessionPathRef,
      getTurnContext: (sessionPath) => sessionPath
        ? this._getRuntimeValueForPath(this._turnContextBySession, sessionPath) || null
        : null,
    });

    // Wrap resourceLoader: per-session prompt snapshot + plan mode injection + vision auxiliary extension
    const resourceLoaderProps = {
      getSystemPrompt: {
        value: () => systemPromptSnapshot,
      },
      getExtensions: {
        value: () => {
          const base = baseResourceLoader.getExtensions?.() ?? { extensions: [], errors: [] };
          return {
            ...base,
            extensions: [turnContextExtension, visionAuxiliaryExtension, ...(base.extensions || [])],
          };
        },
      },
      getAppendSystemPrompt: {
        value: () => [...appendSystemPromptSnapshot],
      },
      getSkills: {
        value: () => resolveSessionSkillsForRuntime(skillsResultSnapshot),
      },
      getAgentsFiles: {
        value: () => freezeAgentsFilesResult(agentsFilesResultSnapshot),
      },
    };
    const resourceLoader = Object.create(baseResourceLoader, resourceLoaderProps);

    const toolSnapshotOptions: any = { forceMemoryEnabled: frozenMemoryEnabled, model: effectiveModel };
    if (agentHasExperienceSwitch) {
      toolSnapshotOptions.forceExperienceEnabled = frozenExperienceEnabled;
    }
    const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
      ? agent.getToolsSnapshot(toolSnapshotOptions)
      : agent.tools;
    const { tools: sessionTools, customTools: sessionCustomTools } = this._d.buildTools(
      effectiveCwd,
      agentToolsSnapshot,
      {
        workspace: effectiveCwd,
        workspaceFolders: workspaceScope.workspaceFolders,
        authorizedFolders: folderScope.authorizedFolders,
        getAuthorizedFolders: () => this.getSessionAuthorizedFolders(sessionPathRef.current || sessionPathForMeta),
        agentDir: agent.agentDir,
      },
    );
    const sessionOpts: any = {
      cwd: effectiveCwd,
      sessionManager: sessionMgr,
      settingsManager: this._createSettings(effectiveModel),
      authStorage: models.authStorage,
      modelRegistry: models.modelRegistry,
      thinkingLevel: resolvedThinkingLevel,
      resourceLoader,
      tools: sessionTools,
      customTools: sessionCustomTools,
    };
    // 新建 session 传 model；恢复 session 不传，让 PI SDK 从 JSONL 读取（单一数据源）
    if (effectiveModel) sessionOpts.model = effectiveModel;
    const { session, modelFallbackMessage } = await createAgentSession(sessionOpts);
    if (modelFallbackMessage) {
      log.warn(`session model fallback: ${modelFallbackMessage}`);
    }
    const resolvedModel = session.model;
    const actualThinkingLevel = normalizeThinkingLevelForModel(initialThinkingLevel, resolvedModel);
    if (actualThinkingLevel !== initialThinkingLevel) {
      initialThinkingLevel = actualThinkingLevel;
      resolvedThinkingLevel = models.resolveThinkingLevel(initialThinkingLevel);
      session.setThinkingLevel?.(resolvedThinkingLevel);
    }
    const elapsed = Date.now() - t0;
    log.log(`session created (${elapsed}ms), model=${resolvedModel?.name || effectiveModel?.name || "?"}`);

    // 事件转发（附带 agentId，供订阅者按 agent 过滤）
    const sessionPath = session.sessionManager?.getSessionFile?.();
    sessionPathRef.current = sessionPath || sessionPathRef.current || null;
    targetModelRef.current = resolvedModel || targetModelRef.current || null;
    flushSessionManagerSnapshot(session.sessionManager);
    this._session = session;
    this._currentSessionPath = sessionPath || null;
    this._sessionStarted = false;
    if (restore && sessionPath && !restoredCapabilitySnapshot) {
      restoredCapabilitySnapshot = this._readSessionCapabilitySnapshot(sessionPath);
    }
    if (restore && sessionPath && restoredPermissionMode === null) {
      const manifest = this._resolveSessionManifestForPath(sessionPath);
      if (manifest?.permissionModeSnapshot?.mode) {
        restoredPermissionMode = normalizeSessionPermissionMode(manifest.permissionModeSnapshot.mode);
        initialPermissionMode = restoredPermissionMode;
        initialAccessMode = legacyAccessModeFromPermissionMode(initialPermissionMode);
        initialPlanMode = isReadOnlyPermissionMode(initialPermissionMode);
        sessionEntry.permissionMode = initialPermissionMode;
        sessionEntry.accessMode = initialAccessMode;
        sessionEntry.planMode = initialPlanMode;
      }
    }
    if (restore && sessionPath && restoredPermissionMode === null) {
      try {
        const metaPath = path.join(agent.sessionDir, "session-meta.json");
        const meta = await this._readMetaCached(metaPath);
        const metaEntry = meta[path.basename(sessionPath)];
        if (hasSessionPermissionModeFields(metaEntry)) {
          initialPermissionMode = normalizeSessionPermissionMode(metaEntry);
          initialAccessMode = legacyAccessModeFromPermissionMode(initialPermissionMode);
          initialPlanMode = isReadOnlyPermissionMode(initialPermissionMode);
          sessionEntry.permissionMode = initialPermissionMode;
          sessionEntry.accessMode = initialAccessMode;
          sessionEntry.planMode = initialPlanMode;
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          log.warn(`session permission mode restore failed: ${err.message}`);
        }
      }
    }
    const creatingAgentId = ownerAgentId;
    const unsub = session.subscribe((event) => {
      if (
        event?.type === "message_end"
        && event.message?.role !== "assistant"
      ) {
        schedulePreAssistantSessionManagerFlush(session.sessionManager);
      }
      recordAssistantUsage({
        ledger: this._d.getUsageLedger?.(),
        event,
        sessionPath,
        sessionId: this._sessionIdForPath(sessionPath),
        agentId: creatingAgentId,
        model: resolvedModel,
        resolveModel: (ref) => findModel(this._d.getModels?.()?.availableModels, ref.id, ref.provider),
        source: {
          subsystem: "session",
          operation: "reply",
          surface: "desktop",
          trigger: "user",
        },
      });
      logDeepSeekReasoningVisibility({
        event,
        model: resolvedModel,
        sessionPath,
        agentId: creatingAgentId,
      });
      this._d.emitEvent(
        (event as any).agentId ? event : { ...event, agentId: creatingAgentId },
        sessionPath,
      );
    });

    // ── Tool snapshot for session-tool-isolation (parallels session-model-isolation) ──
    // Three branches:
    //   A. restore=true + meta has toolNames  → replay the snapshot (applied below)
    //   B. restore=true + meta missing        → legacy session, keep all tools
    //   C. restore=false                       → fresh compute from agent config
    //
    // allToolNames must cover the COMPLETE active set: Pi SDK built-ins
    // (read/bash/edit/write/grep/find/ls) from sessionTools + HanaIDE
    // customs + plugin tools from sessionCustomTools. Using only agent.tools
    // would silently drop SDK built-ins and plugin tools when
    // setActiveToolsByName is applied.
    const allToolObjects = [
      ...(sessionTools || []),
      ...(sessionCustomTools || []),
    ];
    const allToolNames = toolNamesFromObjects(allToolObjects);
    const stableRestoreToolNames = toolNamesFromObjects(allToolObjects, {
      includePluginTools: false,
    });
    const channelsEnabled = this._d.getPrefs?.()?.getChannelsEnabled?.();
    const stableFeatureDisabledToolNames = getStableFeatureDisabledToolNames({
      channelsEnabled,
    });
    const runtimeDisabledToolNames = computeRuntimeDisabledToolNames(
      allToolObjects,
      agent.config,
      { agentId: creatingAgentId, restore, channelsEnabled },
      { warn: (msg) => log.warn(msg) },
    );
    const extraDisabledToolNames = [
      ...stableFeatureDisabledToolNames,
      ...runtimeDisabledToolNames,
    ];
    let snapshotToolNames = null;  // null signals "do not call setActiveToolsByName"
    let shouldPersistRestoredToolNames = false;
    // #1624：dismissed fingerprint 仍从 session-meta 读出，保留未来手动提示链路。
    let restoredDriftDismissedFingerprint: string | null = null;
    const restoredCapabilityToolNames = Array.isArray(restoredCapabilitySnapshot?.toolNames)
      ? uniqueToolNames(restoredCapabilitySnapshot.toolNames)
      : null;

    if (restore) {
      if (sessionPath) {
        const metaPathForRestore = path.join(agent.sessionDir, "session-meta.json");
        let metaEntry = null;
        try {
          const meta = await this._readMetaCached(metaPathForRestore);
          metaEntry = meta[path.basename(sessionPath)];
        } catch (err) {
          if (err.code !== "ENOENT") {
            log.warn(`session-meta read for tool-snapshot restore failed, recomputing from current agent config: ${err.message}`);
          }
        }
        restoredDriftDismissedFingerprint =
          typeof restoredCapabilitySnapshot?.capabilityDriftDismissedFingerprint === "string"
            ? restoredCapabilitySnapshot.capabilityDriftDismissedFingerprint
            : typeof metaEntry?.capabilityDriftDismissedFingerprint === "string"
            ? metaEntry.capabilityDriftDismissedFingerprint
            : null;
        if (refreshCapabilitySnapshots) {
          // #1624 显式刷新：Case C 语义重算（含插件工具），强制持久化，
          // 并清空 dismissed 状态（旧 fingerprint 对新快照没有意义）。
          const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
          snapshotToolNames = computeToolSnapshot(allToolNames, disabled, {
            extraDisabled: extraDisabledToolNames,
          });
          shouldPersistRestoredToolNames = true;
          restoredDriftDismissedFingerprint = null;
        } else if (restoredCapabilityToolNames) {
          const gatedRestoredToolNames = computeToolSnapshot(restoredCapabilityToolNames, [], {
            extraDisabled: stableFeatureDisabledToolNames,
          });
          const repair = repairRestoredToolSnapshotDetailed(gatedRestoredToolNames, allToolNames);
          snapshotToolNames = repair.toolNames;
          shouldPersistRestoredToolNames = !sameToolNames(snapshotToolNames, restoredCapabilityToolNames);
        } else if (metaEntry && Array.isArray(metaEntry.toolNames)) {
          const restoredToolNames = uniqueToolNames(metaEntry.toolNames);
          const gatedRestoredToolNames = computeToolSnapshot(restoredToolNames, [], {
            extraDisabled: stableFeatureDisabledToolNames,
          });  // Case A, with current global feature gates enforced
          const repair = repairRestoredToolSnapshotDetailed(gatedRestoredToolNames, allToolNames);
          snapshotToolNames = repair.toolNames;
          shouldPersistRestoredToolNames = !sameToolNames(snapshotToolNames, metaEntry.toolNames);
        } else {
          // Legacy sessions created before tool snapshots had no stable tool
          // identity boundary. Establish one on first restore so future plugin
          // or dynamic tool registrations only affect newly created sessions.
          const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
          snapshotToolNames = computeToolSnapshot(stableRestoreToolNames, disabled, {
            extraDisabled: extraDisabledToolNames,
          });
          shouldPersistRestoredToolNames = true;
        }
      }
    } else {
      // Case C. Fresh agents (and agents upgrading from a pre-feature version)
      // have no tools.disabled field — apply DEFAULT_DISABLED_TOOL_NAMES so
      // dm is off by default. Explicit `[]` means "all on"
      // and is preserved via nullish-coalescing rather than `||`.
      const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
      snapshotToolNames = computeToolSnapshot(allToolNames, disabled, {
        extraDisabled: extraDisabledToolNames,
      });
    }

    // #1624 的能力漂移提示模板保留，但 restore 不再主动计算/唤醒。
    // 这里刻意不构造 live prompt / tool diff，避免切换旧会话时为隐藏提醒付出额外成本。
    let capabilityDrift = null;

    Object.assign(sessionEntry, {
      session,
      agentId: creatingAgentId,
      memoryEnabled: frozenMemoryEnabled,
      experienceEnabled: frozenExperienceEnabled,
      modelId: resolvedModel?.id || effectiveModel?.id || null,
      modelProvider: resolvedModel?.provider || effectiveModel?.provider || null,
      cwd: effectiveCwd,
      workspaceFolders: workspaceScope.workspaceFolders,
      workspaceMountId: workspaceMount?.mountId || null,
      workspaceLabel: workspaceMount?.label || null,
      authorizedFolders: folderScope.authorizedFolders,
      permissionMode: initialPermissionMode,
      accessMode: initialAccessMode,
      planMode: initialPlanMode,
      thinkingLevel: initialThinkingLevel,
      experiments: frozenExperimentFlags,
      toolNames: snapshotToolNames,  // null for legacy sessions (Case B), array otherwise
      activeToolDefinitions: activeToolDefinitionsFromSnapshot(allToolObjects, snapshotToolNames),
      ownerPluginId: pluginSessionMeta?.ownerPluginId || null,
      sessionKind: pluginSessionMeta?.kind || null,
      sessionVisibility: pluginSessionMeta?.visibility || "public",
      memoryReflectionSnapshot,
      // #1624：session 级提示数据，归属 sessionEntry（keyed by sessionPath），不挂 agent/engine
      capabilityDrift,
      capabilityDriftDismissedFingerprint: restoredDriftDismissedFingerprint,
      lastTouchedAt: Date.now(),
      unsub,
      sessionPath,
    });
    const manifestDefaults = {
      ownerAgentId: creatingAgentId,
      domain: "desktop",
      kind: pluginSessionMeta?.kind || "chat",
      lifecycle: "active",
      memoryPolicy: {
        mode: frozenMemoryEnabled ? "enabled" : "disabled",
        inheritedFrom: restore ? "session_restore" : "session_create",
      },
      permissionModeSnapshot: {
        mode: initialPermissionMode,
        source: restore ? "session_restore" : "session_create",
        capturedAt: new Date().toISOString(),
      },
      thinkingLevel: initialThinkingLevel,
      workspaceScope: {
        primaryCwd: effectiveCwd,
        workspaceFolders: workspaceScope.workspaceFolders,
        authorizedFolders: folderScope.authorizedFolders,
        ...(workspaceMount?.mountId ? { workspaceMount } : {}),
      },
      plugin: pluginSessionMeta,
      provenance: {
        createdBy: restore ? "session_restore" : "session_create",
      },
      migration: {},
      locatorReason: restore ? "session_restore" : "session_create",
    };
    const manifest = this._ensureSessionManifestForPath(sessionPath, manifestDefaults);
    if (manifest) {
      sessionEntry.sessionId = manifest.sessionId;
    }
    // 存入 map（SessionEntry）— sessionEntry is the same object the resourceLoader proxy references.
    // Runtime ownership is keyed by sessionId when the manifest layer is available;
    // sessionPath remains only a locator resolved at method boundaries.
    const mapKey = manifest?.sessionId || sessionPath || `_anon_${Date.now()}`;
    const old = this._sessions.get(mapKey);
    if (old) old.unsub();
    this._sessions.set(mapKey, sessionEntry);
    if (sessionPath && mapKey !== sessionPath) this._sessions.delete(sessionPath);
    this._deleteRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);

    // Apply tool snapshot (Case A / Case C). Permission mode is a runtime
    // policy and does not change the stable tool schema.
    if (snapshotToolNames !== null) {
      session.setActiveToolsByName(snapshotToolNames);
    }

    if (restoredPromptSnapshot?.finalSystemPrompt) {
      this._applyFinalPromptSnapshot(session, restoredPromptSnapshot.finalSystemPrompt);
    }
    const finalSystemPrompt = this._getFinalSystemPrompt(session);
    const promptSnapshotToWrite = finalSystemPrompt
      ? { ...promptSnapshotForPersist, finalSystemPrompt }
      : promptSnapshotForPersist;
    this._renewCachePrefixContract(mapKey, sessionEntry, restore ? "session_restore" : "new_session");
    this._installCachePrefixGuard(mapKey, sessionEntry);

    // Persist fresh snapshots and repair/establish restored snapshots. Restored
    // legacy sessions with missing toolNames get a baseline on first restore,
    // so later plugin/dynamic tool registrations do not drift into old history.
    // writeSessionMeta is serialized and never rejects; awaiting gives
    // createSession a clean post-return state.
    if (!restore && sessionPath) {
      const metaPatch: any = {
        memoryEnabled: frozenMemoryEnabled,
        experienceEnabled: frozenExperienceEnabled,
        workspaceFolders: workspaceScope.workspaceFolders,
        authorizedFolders: folderScope.authorizedFolders,
        permissionMode: initialPermissionMode,
        accessMode: initialAccessMode,
        planMode: initialPlanMode,
        thinkingLevel: initialThinkingLevel,
        promptSnapshot: promptSnapshotToWrite,
      };
      if (workspaceMount?.mountId) {
        metaPatch.workspaceMountId = workspaceMount.mountId;
        metaPatch.workspaceLabel = workspaceMount.label || null;
      }
      const experimentsForMeta = sessionExperimentFlagsForMeta(frozenExperimentFlags);
      if (experimentsForMeta) {
        metaPatch.experiments = experimentsForMeta;
      }
      if (memoryReflectionSnapshot) {
        metaPatch.memoryReflectionSnapshot = memoryReflectionSnapshot;
      }
      if (pluginSessionMeta) {
        metaPatch.plugin = pluginSessionMeta;
      }
      if (snapshotToolNames !== null) metaPatch.toolNames = snapshotToolNames;
      await this.writeSessionMeta(sessionPath, metaPatch);
    } else if (restore && sessionPath) {
      const metaPatch: any = {};
      if (!restoredPromptSnapshot) metaPatch.promptSnapshot = promptSnapshotToWrite;
      if (shouldPersistRestoredToolNames && snapshotToolNames !== null) {
        metaPatch.toolNames = snapshotToolNames;
      }
      if (refreshCapabilitySnapshots) {
        // #1624 显式刷新：dismissed 状态随旧快照一并失效
        metaPatch.capabilityDriftDismissedFingerprint = null;
      }
      if (Object.keys(metaPatch).length > 0) {
        await this.writeSessionMeta(sessionPath, metaPatch);
      }
    }

    // LRU 淘汰：按 lastTouchedAt 排序，跳过 streaming 和焦点 session
    if (this._sessions.size > MAX_CACHED_SESSIONS) {
      const focusPath = this.currentSessionPath;
      const candidates = [...this._sessions.entries()]
        .filter(([key, e]) => key !== mapKey && key !== focusPath && !e.session.isStreaming)
        .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
      for (const [key, entry] of candidates) {
        // 记忆收尾（fire-and-forget，淘汰场景不阻塞）
        const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
        agent?._memoryTicker?.notifySessionEnd(key).catch((err) =>
          log.warn(`LRU 淘汰 ${path.basename(key)}: notifySessionEnd failed: ${err.message}`),
        );
        await this._teardownSessionEntry(entry, key, "lru");
        this._sessions.delete(key);
        if (this._sessions.size <= MAX_CACHED_SESSIONS) break;
      }
    }

    if (!restore) {
      this._refreshAgentAppearanceSummaryAfterCreate(agent, resolvedModel || effectiveModel || null);
    }

    return { session, sessionPath: sessionPath || mapKey, sessionId: manifest?.sessionId || null, agentId: creatingAgentId };
  }

  _refreshAgentAppearanceSummaryAfterCreate(agent: any, targetModel: any) {
    if (!agent || typeof agent.refreshAppearanceSummary !== "function") return;
    setTimeout(() => {
      void Promise.resolve()
        .then(() => agent.refreshAppearanceSummary({ targetModel, rebuildSystemPrompt: true }))
        .catch((err) => {
          log.warn(`agent appearance summary refresh failed: ${err?.message || err}`);
        });
    }, 0);
  }

  async createDetachedSession({
    sessionMgr = null,
    cwd = undefined,
    memoryEnabled = true,
    model = null,
    agent = null,
    agentId = null,
    preserveAgentMemoryState = false,
    workspaceFolders = [],
    authorizedFolders = [],
    visibleInSessionList = true,
    permissionMode = null,
    thinkingLevel = null,
    workspaceMountId = null,
    workspaceLabel = null,
    ownerPluginId = null,
    sessionKind = null,
    sessionVisibility = null,
  }: any = {}) {
    const prevFocus = this._session;
    const prevCurrentSessionPath = this._currentSessionPath;
    const prevSessionStarted = this._sessionStarted;
    const prevPendingPermissionMode = this._pendingPermissionMode;

    if (permissionMode !== null && permissionMode !== undefined) {
      this._pendingPermissionMode = normalizeSessionPermissionMode(permissionMode);
    }

    try {
      return await this.createSession(sessionMgr, cwd, memoryEnabled, model, {
        agent,
        agentId,
        preserveAgentMemoryState,
        workspaceFolders,
        authorizedFolders,
        visibleInSessionList,
        thinkingLevel,
        workspaceMountId,
        workspaceLabel,
        ownerPluginId,
        sessionKind,
        sessionVisibility,
      });
    } finally {
      this._session = prevFocus;
      this._currentSessionPath = prevCurrentSessionPath;
      this._sessionStarted = prevSessionStarted;
      this._pendingPermissionMode = prevPendingPermissionMode;
    }
  }

  async continueDeletedAgentSession(sourceSessionPath: any) {
    this._assertActiveDesktopSessionPath(sourceSessionPath, "continueDeletedAgentSession");
    const sourceAgentId = this._d.agentIdFromSessionPath(sourceSessionPath);
    if (!sourceAgentId) {
      throw new Error(`continueDeletedAgentSession: cannot resolve source agentId for ${sourceSessionPath}`);
    }
    if (!this._d.isAgentDeleted?.(sourceAgentId)) {
      throw new Error(`continueDeletedAgentSession: source agent "${sourceAgentId}" is not deleted`);
    }
    try {
      await fsp.access(sourceSessionPath);
    } catch {
      throw new Error(`continueDeletedAgentSession: source session not found`);
    }

    const primaryAgentId = this._d.getPrefs?.()?.getPrimaryAgent?.() || this._d.getActiveAgentId?.();
    const targetAgent = primaryAgentId ? this._d.getAgentById?.(primaryAgentId) : this._d.getAgent();
    if (!targetAgent) {
      throw new Error(`continueDeletedAgentSession: primary agent "${primaryAgentId || "(missing)"}" not found`);
    }
    if (this._d.isAgentDeleted?.(targetAgent.id)) {
      throw new Error(`continueDeletedAgentSession: primary agent "${targetAgent.id}" has been deleted`);
    }

    const sourceManager = SessionManager.open(sourceSessionPath, path.dirname(sourceSessionPath));
    const sourceCwd = sourceManager.getCwd?.() || null;
    const targetCwd = sourceCwd || this._d.getHomeCwd(targetAgent.id) || process.cwd();
    const sourceMessages = readSessionBranchMessages(sourceSessionPath);
    const transcriptMessages = sourceMessages
      .map(normalizeDeletedAgentTranscriptMessage)
      .filter(Boolean);
    if (transcriptMessages.length === 0) {
      throw new Error("continueDeletedAgentSession: source session has no displayable transcript");
    }

    let createdSessionPath = null;
    try {
      const result = await this.createSession(null, targetCwd, true, null, {
        agent: targetAgent,
        agentId: targetAgent.id,
        visibleInSessionList: true,
      });
      const session = result.session;
      createdSessionPath = result.sessionPath;
      const manager = session.sessionManager;
      for (const message of transcriptMessages) {
        manager.appendMessage(message as any);
      }
      if (session.model?.provider && session.model?.id) {
        manager.appendModelChange(session.model.provider, session.model.id);
      }
      (manager as any)._rewriteFile?.();

      await this.writeSessionMeta(createdSessionPath, {
        continuedFrom: {
          sourceSessionPath,
          sourceAgentId,
          sourceAgentDeleted: true,
          migratedAt: new Date().toISOString(),
        },
      });
      let compacted = false;
      let compactionError = null;
      try {
        await this._freshCompactDeletedAgentContinuation(session, transcriptMessages, {
          sourceSessionPath,
          sourceAgentId,
        });
        compacted = true;
      } catch (error) {
        compactionError = error?.message || String(error);
      }
      (manager as any)._rewriteFile?.();
      return {
        session,
        sessionPath: createdSessionPath,
        agentId: targetAgent.id,
        agentName: targetAgent.agentName || targetAgent.name || targetAgent.id,
        cwd: manager.getCwd?.() || targetCwd,
        workspaceFolders: this.getSessionWorkspaceFolders(createdSessionPath),
        compacted,
        compactionError,
      };
    } catch (err) {
      if (createdSessionPath) {
        try { await this.discardSessionRuntime(createdSessionPath, "deleted agent continuation failed"); } catch {}
        try { await fsp.rm(createdSessionPath, { force: true }); } catch {}
      }
      throw err;
    }
  }

  async _freshCompactDeletedAgentContinuation(session: any, transcriptMessages: any[], { sourceSessionPath, sourceAgentId }: any) {
    if (!session?.sessionManager) throw new Error("deleted-agent continuation compaction requires a session manager");
    const model = session.model;
    if (!model) throw new Error("deleted-agent continuation compaction requires a model");
    const settings = session.settingsManager?.getCompactionSettings?.() || this._createSettings(model)?.getCompactionSettings?.();
    const tokensBefore = transcriptMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
    const preparation = {
      messagesToSummarize: transcriptMessages,
      turnPrefixMessages: [],
      previousSummary: null,
      isSplitTurn: false,
      firstKeptEntryId: null,
      tokensBefore,
      settings,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    };
    session?._emit?.({ type: "compaction_start", reason: "deleted_agent_continue" });
    const targetSessionPath = session.sessionManager?.getSessionFile?.() || null;
    const targetSessionId = targetSessionPath ? this._sessionIdForPath(targetSessionPath) : null;
    try {
      const result = await createCachePreservingCompactionResult({
        preparation,
        model,
        systemPrompt: session.agent?.state?.systemPrompt ?? session.systemPrompt,
        customInstructions: [
          "This is a fresh continuation summary created from a read-only session whose Agent was deleted.",
          `Source agent id: ${sourceAgentId}.`,
          `Source session path: ${sourceSessionPath}.`,
          "Summarize the old transcript so the new primary Agent can continue without depending on the deleted Agent runtime.",
        ].join(" "),
        thinkingLevel: session.thinkingLevel ?? session.agent?.state?.thinkingLevel,
        streamFn: session.agent?.streamFn,
        streamOptions: {
          sessionId: session.agent?.sessionId,
          onPayload: session.agent?.onPayload,
          onResponse: session.agent?.onResponse,
          transport: session.agent?.transport,
          thinkingBudgets: session.agent?.thinkingBudgets,
          maxRetryDelayMs: session.agent?.maxRetryDelayMs,
        },
        convertToLlm: session.agent?.convertToLlm,
        usageLedger: this._d.getUsageLedger?.(),
        usageContext: {
          source: {
            subsystem: "compaction",
            operation: "deleted_agent_continue",
            surface: "desktop",
            trigger: "user",
          },
          attribution: {
            kind: "session",
            agentId: session.agentId || session.agent?.id || null,
            ...(targetSessionId ? { sessionId: targetSessionId } : {}),
            sessionPath: targetSessionPath,
          },
        },
      } as any);
      const saved = await appendCompactionResultToSession(session, result, { fromExtension: false });
      session?._emit?.({
        type: "compaction_end",
        reason: "deleted_agent_continue",
        result: saved,
        aborted: false,
        willRetry: false,
      });
      return saved;
    } catch (error) {
      session?._emit?.({
        type: "compaction_end",
        reason: "deleted_agent_continue",
        aborted: false,
        willRetry: false,
        errorMessage: `Compaction failed: ${error.message || error}`,
      });
      throw error;
    }
  }

  getSessionWorkspaceFolders(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return [];
    const entry = this._sessionFolderEntry(sessionPath);
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    let folders = null;
    if (Array.isArray(entry?.workspaceFolders)) {
      folders = entry.workspaceFolders;
    } else if (Array.isArray(manifest?.workspaceScope?.workspaceFolders)) {
      folders = manifest.workspaceScope.workspaceFolders;
    } else {
      folders = this._readSessionMetaEntrySync(sessionPath)?.workspaceFolders;
    }
    return Array.isArray(folders) ? [...folders] : [];
  }

  getSessionWorkspaceMount(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return null;
    const entry = this._sessionFolderEntry(sessionPath);
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    const metaEntry = entry ? null : this._readSessionMetaEntrySync(sessionPath);
    return normalizeSessionWorkspaceMount({
      workspaceMountId: entry?.workspaceMountId
        ?? manifest?.workspaceScope?.workspaceMount?.mountId
        ?? metaEntry?.workspaceMountId,
      workspaceLabel: entry?.workspaceLabel
        ?? manifest?.workspaceScope?.workspaceMount?.label
        ?? metaEntry?.workspaceLabel,
    });
  }

  getSessionAuthorizedFolders(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return [];
    const entry = this._sessionFolderEntry(sessionPath);
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    let folders = null;
    if (Array.isArray(entry?.authorizedFolders)) {
      folders = entry.authorizedFolders;
    } else if (Array.isArray(manifest?.workspaceScope?.authorizedFolders)) {
      folders = manifest.workspaceScope.authorizedFolders;
    } else {
      folders = this._readSessionMetaEntrySync(sessionPath)?.authorizedFolders;
    }
    return Array.isArray(folders) ? [...folders] : [];
  }

  isDeepSeekRoleplayReasoningPatchEnabled(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return false;
    const entry = this._getSessionEntryByPath(sessionPath);
    const flags = entry?.experiments
      || this._readSessionMetaEntrySync(sessionPath)?.experiments;
    return normalizeSessionExperimentFlags(flags).deepseekRoleplayReasoningPatch === true;
  }

  getDeepSeekRoleplayReasoningContext(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return null;
    const entry = this._getSessionEntryByPath(sessionPath);
    const flags = entry?.experiments
      || this._readSessionMetaEntrySync(sessionPath)?.experiments;
    const normalized = normalizeSessionExperimentFlags(flags);
    return normalized.deepseekRoleplayReasoningPatch === true
      ? normalized.deepseekRoleplayReasoningContext || null
      : null;
  }

  getSessionFolderScope(sessionPath = this.currentSessionPath) {
    const entry = sessionPath ? this._sessionFolderEntry(sessionPath) : null;
    const manifest = sessionPath ? this._resolveSessionManifestForPath(sessionPath) : null;
    const metaEntry = sessionPath && !entry ? this._readSessionMetaEntrySync(sessionPath) : null;
    const cwd = this._sessionCwdFor(sessionPath, entry) || manifest?.workspaceScope?.primaryCwd || null;
    const scope = normalizeSessionFolderScope({
      primaryCwd: cwd,
      workspaceFolders: Array.isArray(entry?.workspaceFolders)
        ? entry.workspaceFolders
        : (Array.isArray(manifest?.workspaceScope?.workspaceFolders)
          ? manifest.workspaceScope.workspaceFolders
          : metaEntry?.workspaceFolders),
      authorizedFolders: Array.isArray(entry?.authorizedFolders)
        ? entry.authorizedFolders
        : (Array.isArray(manifest?.workspaceScope?.authorizedFolders)
          ? manifest.workspaceScope.authorizedFolders
          : metaEntry?.authorizedFolders),
    });
    return {
      sessionPath: sessionPath || null,
      cwd: scope.primaryCwd,
      workspaceFolders: scope.workspaceFolders,
      authorizedFolders: scope.authorizedFolders,
      sandboxFolders: scope.sandboxFolders,
    };
  }

  async setSessionAuthorizedFolders(sessionPath: any, folders: any) {
    this._assertActiveDesktopSessionPath(sessionPath, "setSessionAuthorizedFolders");
    if (this._isDeletedAgentSessionPath(sessionPath)) {
      throw new Error("setSessionAuthorizedFolders: session belongs to a deleted agent");
    }
    const current = this.getSessionFolderScope(sessionPath);
    const scope = normalizeSessionFolderScope({
      primaryCwd: current.cwd,
      workspaceFolders: current.workspaceFolders,
      authorizedFolders: folders,
    });
    this._updateSessionFolderRuntimeMeta(sessionPath, {
      cwd: current.cwd,
      workspaceFolders: scope.workspaceFolders,
      authorizedFolders: scope.authorizedFolders,
    });
    await this.writeSessionMeta(sessionPath, {
      workspaceFolders: scope.workspaceFolders,
      authorizedFolders: scope.authorizedFolders,
    });
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest) {
      this._sessionManifestStore.setWorkspaceScope(manifest.sessionId, {
        ...(manifest.workspaceScope || {}),
        primaryCwd: current.cwd,
        workspaceFolders: scope.workspaceFolders,
        authorizedFolders: scope.authorizedFolders,
      });
    }
    this._d.emitEvent?.({
      type: "app_event",
      event: {
        type: "session-authorized-folders-updated",
        payload: {
          sessionPath,
          authorizedFolders: scope.authorizedFolders,
          workspaceFolders: scope.workspaceFolders,
          sandboxFolders: scope.sandboxFolders,
        },
        source: "server",
      },
    }, sessionPath);
    return this.getSessionFolderScope(sessionPath);
  }

  async addSessionAuthorizedFolder(sessionPath: any, folder: any) {
    const current = this.getSessionAuthorizedFolders(sessionPath);
    return this.setSessionAuthorizedFolders(sessionPath, [...current, folder]);
  }

  async removeSessionAuthorizedFolder(sessionPath: any, folder: any) {
    const target = normalizeSessionFolderScope({ authorizedFolders: [folder] }).authorizedFolders[0];
    const current = this.getSessionAuthorizedFolders(sessionPath);
    const next = target
      ? current.filter((item) => item !== target)
      : current;
    return this.setSessionAuthorizedFolders(sessionPath, next);
  }

  _sessionFolderEntry(sessionPath: any) {
    if (!sessionPath) return null;
    return this._getSessionEntryByPath(sessionPath)
      || this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath)
      || null;
  }

  _sessionCwdFor(sessionPath: any, entry: any = null) {
    if (entry?.cwd) return entry.cwd;
    const liveCwd = entry?.session?.sessionManager?.getCwd?.();
    if (liveCwd) return liveCwd;
    if (sessionPath && this._session?.sessionManager?.getSessionFile?.() === sessionPath) {
      return this._session.sessionManager?.getCwd?.() || null;
    }
    if (!sessionPath) return null;
    try {
      return SessionManager.open(sessionPath, path.dirname(sessionPath)).getCwd?.() || null;
    } catch {
      return null;
    }
  }

  _readSessionMetaEntrySync(sessionPath: any) {
    if (!sessionPath) return null;
    try {
      const metaPath = this._sessionMetaPathFor(sessionPath);
      const stat = fs.statSync(metaPath);
      if (stat.size > SESSION_META_INDEX_MAX_BYTES) {
        log.warn(`session-meta is too large to parse safely (${stat.size} bytes): ${metaPath}`);
        return null;
      }
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const entry = meta[path.basename(sessionPath)];
      return entry && typeof entry === "object" ? entry : null;
    } catch {
      return null;
    }
  }

  _readSessionMemoryEnabledFromMeta(sessionPath: any) {
    const metaEntry = this._readSessionMetaEntrySync(sessionPath);
    return typeof metaEntry?.memoryEnabled === "boolean" ? metaEntry.memoryEnabled : null;
  }

  getSessionMemoryReflectionSnapshot(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return null;
    const entry = this._sessionFolderEntry(sessionPath);
    const liveSnapshot = entry?.memoryReflectionSnapshot;
    if (liveSnapshot && typeof liveSnapshot === "object" && !Array.isArray(liveSnapshot)) {
      return liveSnapshot;
    }
    const metaSnapshot = this._readSessionMetaEntrySync(sessionPath)?.memoryReflectionSnapshot;
    return metaSnapshot && typeof metaSnapshot === "object" && !Array.isArray(metaSnapshot)
      ? metaSnapshot
      : null;
  }

  getSessionMemoryEnabled(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return true;
    const liveEntry = this._getSessionEntryByPath(sessionPath);
    if (typeof liveEntry?.memoryEnabled === "boolean") return liveEntry.memoryEnabled;
    const hibernatedEntry = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
    if (typeof hibernatedEntry?.memoryEnabled === "boolean") return hibernatedEntry.memoryEnabled;
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest?.memoryPolicy?.mode === "enabled") return true;
    if (manifest?.memoryPolicy?.mode === "disabled") return false;
    const stored = this._readSessionMemoryEnabledFromMeta(sessionPath);
    return typeof stored === "boolean" ? stored : true;
  }

  async setSessionMemoryEnabled(sessionPath: any, enabled: any) {
    if (!sessionPath) {
      return { ok: false, error: "session memory requires sessionPath", memoryEnabled: true };
    }
    this._assertActiveDesktopSessionPath(sessionPath, "setSessionMemoryEnabled");
    if (this._isDeletedAgentSessionPath(sessionPath)) {
      throw new Error("setSessionMemoryEnabled: session belongs to a deleted agent");
    }
    const next = enabled !== false;
    const liveEntry = this._getSessionEntryByPath(sessionPath);
    if (liveEntry) liveEntry.memoryEnabled = next;
    const hibernatedEntry = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
    if (hibernatedEntry) hibernatedEntry.memoryEnabled = next;
    await this.writeSessionMeta(sessionPath, { memoryEnabled: next });
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest) {
      this._sessionManifestStore.setMemoryPolicy(manifest.sessionId, {
        mode: next ? "enabled" : "disabled",
        inheritedFrom: "session_override",
      });
    }
    this._emitSessionMetadataUpdated(sessionPath, { memoryEnabled: next });
    return { ok: true, memoryEnabled: next };
  }

  _updateSessionFolderRuntimeMeta(sessionPath: any, patch: any) {
    const liveEntry = this._getSessionEntryByPath(sessionPath);
    if (liveEntry) {
      if (patch.cwd) liveEntry.cwd = patch.cwd;
      liveEntry.workspaceFolders = [...(patch.workspaceFolders || [])];
      liveEntry.authorizedFolders = [...(patch.authorizedFolders || [])];
    }
    const hibernated = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
    if (hibernated) {
      if (patch.cwd) hibernated.cwd = patch.cwd;
      hibernated.workspaceFolders = [...(patch.workspaceFolders || [])];
      hibernated.authorizedFolders = [...(patch.authorizedFolders || [])];
    }
  }

  async switchSession(sessionPath: any) {
    // 只接受"对话焦点"路径，拒绝 subagent-sessions/、activity/、.ephemeral/ 等旁路
    // 目录下的 session 文件。一旦这类路径混入焦点指针，listSessions 的占位逻辑会把
    // 它伪造成"新对话"幻影条目（不能归档、重启即消失）。
    if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) {
      throw new Error(`switchSession: path must be in active desktop session agents/{id}/sessions/*.jsonl; got ${sessionPath}`);
    }
    if (this._isDeletedAgentSessionPath(sessionPath)) {
      throw new Error("switchSession: session belongs to a deleted agent");
    }

    // 切到已有 session 时清空 pendingModel（用户的临时选择不应跟到别的 session）
    this._pendingModel = null;

    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (targetAgentId && targetAgentId !== this._d.getActiveAgentId()) {
      // Phase 1: 跨 agent 切换只切指针，不清旧 session
      await this._d.switchAgentOnly(targetAgentId);
    }

    // 从 session-owned state 恢复记忆开关（model 由 PI SDK 从 JSONL 恢复，不在此处读取）
    const memoryEnabled = this.getSessionMemoryEnabled(sessionPath);

    // 如果已在 map 中，切指针
    const existing = this._getSessionEntryByPath(sessionPath);
    if (existing) {
      if (this._session && this._session !== existing.session) {
        const oldSp = this._session.sessionManager?.getSessionFile?.();
        if (oldSp) {
          const oldEntry = this._getSessionEntryByPath(oldSp);
          const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
          // fire-and-forget：memory flush 不阻塞 switch。memory.md 由 onCompiled 回调
          // 刷到 agent._systemPrompt，只影响下次新建 session；老 session 用自己创建时的
          // 快照，对后台异步刷新完全透明。
          oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch((err) =>
            log.warn(`switchSession ${path.basename(oldSp)}: notifySessionEnd failed: ${err.message}`),
          );
        }
      }
      this._session = existing.session;
      this._currentSessionPath = sessionPath;
      existing.lastTouchedAt = Date.now();
      return existing.session;
    }

    // 不在 map 中，先触发旧 session 的 memory flush（后台跑），再新建
    if (this._session) {
      const oldSp = this._session.sessionManager?.getSessionFile?.();
      if (oldSp) {
        const oldEntry = this._getSessionEntryByPath(oldSp);
        const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
        oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch((err) =>
          log.warn(`switchSession ${path.basename(oldSp)}: notifySessionEnd failed: ${err.message}`),
        );
      }
    }
    // #521: 在恢复前扫描会话尾部，若最近 N 条 assistant 大量 stopReason=error
    // 说明用户已经撞到了"反复 empty_stream"循环，给前端发警告事件让 UI 提示用户
    // 新建会话或修复。restore 本身仍然继续，避免破坏用户预期。
    this._emitSessionHealthWarning(sessionPath);
    // 在 open 前修复巨型/坏 JSONL 行，避免 SessionManager.open 整文件 parse 卡住。
    this._repairOversizedSessionHistory(sessionPath);
    // #1285: 在 open 前修复坏会话的孤儿 toolResult（必须早于 SessionManager.open）
    this._repairOrphanToolHistory(sessionPath);
    this._repairInlineMediaHistory(sessionPath);

    // 冷启动恢复：model 由 PI SDK 从 session JSONL 恢复（单一数据源），不从 session-meta.json 读
    const sessionMgr = SessionManager.open(sessionPath, this._d.getAgent().sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    const result = await this.createSession(sessionMgr, cwd, memoryEnabled, null, {
      restore: true,
      agent: this._d.getAgent(),
      agentId: targetAgentId || this._d.getActiveAgentId(),
    });
    return result.session;
  }

  /** @private 检查 session 健康度并在 unhealthy 时 log + emit 事件，不抛错 */
  _emitSessionHealthWarning(sessionPath: any) {
    try {
      const health = evaluateSessionHealth(sessionPath);
      if (health.healthy) return;
      log.warn(
        `session restore: ${path.basename(sessionPath)} unhealthy (`
        + `${health.recentErrors}/${health.totalChecked} recent assistant messages had stopReason=error). `
        + `User may need to start a new session — see #521.`
      );
      this._d.emitEvent?.({
        type: "session_unhealthy_warning",
        recentErrors: health.recentErrors,
        totalChecked: health.totalChecked,
      }, sessionPath);
    } catch (err) {
      // 健康度检查不能阻塞 restore，吃掉所有错误
      log.warn(`session health check failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  /**
   * @private #1285 读时结构修复：在 SessionManager.open 之前清理已落盘坏会话里的孤儿
   * toolResult entry（父 toolCall 属于会被 SDK 丢弃的 error/aborted assistant），避免
   * 重放时序列化出无前驱 tool_calls 的 role:"tool" → OpenAI-compatible provider 400。
   *
   * 必须在 open 之前调用：修复发生在文件层，open 之后 SessionManager 从已清理文件加载。
   * 容错不阻塞 restore（异常吃掉；运行时 provider-compat 兜底仍会防 400）。
   */
  _repairOrphanToolHistory(sessionPath: any) {
    try {
      const { repaired, removed } = repairOrphanToolResultEntriesInFile(sessionPath);
      if (repaired) {
        log.warn(
          `session restore: ${path.basename(sessionPath)} 清理 ${removed} 条孤儿 toolResult `
          + `(父 tool_calls 属于 error/aborted assistant，会被 SDK 丢弃) — see #1285.`
        );
      }
    } catch (err) {
      log.warn(`orphan tool history repair failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  _repairOversizedSessionHistory(sessionPath: any) {
    try {
      const result = repairOversizedSessionEntriesInFile(sessionPath);
      if (result.repaired) {
        log.warn(
          `session restore: ${path.basename(sessionPath)} repaired oversized JSONL lines `
          + `(projected=${result.projected}, skipped=${result.skipped})`
        );
      }
    } catch (err) {
      log.warn(`oversized session history repair failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  _projectOversizedSessionHistory(session: any, sessionPath: any) {
    try {
      const manager = session?.sessionManager;
      if (!Array.isArray(manager?.fileEntries)) return;
      const result = repairOversizedSessionEntries(manager.fileEntries);
      if (result.projected === 0) return;
      manager.fileEntries = result.entries;
      manager._buildIndex?.();
      manager._rewriteFile?.();
      log.warn(
        `session turn: ${path.basename(sessionPath || manager.getSessionFile?.() || "session")} `
        + `projected ${result.projected} oversized JSONL entries`
      );
    } catch (err) {
      log.warn(`oversized session projection failed: ${err.message}`);
    }
  }

  _repairInlineMediaHistory(sessionPath: any) {
    try {
      const result = repairSessionInlineMediaEntriesInFile(sessionPath);
      if (result.repaired) {
        log.warn(
          `session restore: ${path.basename(sessionPath)} 清理 ${result.stripped} 个 inline media `
          + `(image=${result.strippedImages}, video=${result.strippedVideos}, audio=${result.strippedAudios})`
        );
      }
    } catch (err) {
      log.warn(`inline media history repair failed for ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  async prompt(text: any, opts: any) {
    const turnContext = normalizeSessionTurnContext(opts?.context);
    if (!this._session) {
      const currentPath = this.currentSessionPath;
      if (!currentPath) throw new Error(t("error.noActiveSessionPrompt"));
      this._session = await this.ensureSessionLoaded(currentPath);
    }
    this._sessionStarted = true;
    const sp = this._session.sessionManager?.getSessionFile?.();
    if (sp) {
      const entry = this._getSessionEntryByPath(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }
    const engine = this._d.getEngine?.();
    ({ text, opts } = await prepareVisionInputForTextOnlyModel({
      targetModel: this._session.model,
      text,
      opts,
      sessionPath: sp,
      getVisionBridge: () => engine?.getVisionBridge?.(),
      visionPolicyTarget: engine,
      warn: (msg) => (engine?.log || console).warn?.(`[session] ${msg}`),
      signal: null,
    } as any));
    ({ text, opts } = await prepareModelImageInputsForPrompt({ text, opts }));
    assertVideoInputSupported(this._session.model, opts?.videos);
    assertAudioInputSupported(this._session.model, opts?.audios);
    const promptOpts = buildPromptMediaOptions(opts);
    const nativeMediaTurn = engine?.beginCurrentTurnNativeMedia?.(sp, opts);
    if (sp && turnContext) this._setRuntimeValueForPath(this._turnContextBySession, sp, turnContext);
    try {
      await this._session.prompt(text, promptOpts);
    } finally {
      if (sp && turnContext) this._deleteRuntimeValueForPath(this._turnContextBySession, sp);
      engine?.endCurrentTurnNativeMedia?.(nativeMediaTurn);
      pruneSessionInlineMediaHistory(this._session);
      this._projectOversizedSessionHistory(this._session, sp);
      if (sp) this._scheduleRuntimePressureCheck(sp, "prompt");
    }
    if (sp) {
      const entry = this._getSessionEntryByPath(sp);
      const agent = entry ? this._d.getAgentById(entry.agentId) : this._d.getAgent();
      agent?._memoryTicker?.notifyTurn(sp);
    }
  }

  _normalizeAbortReason(options: any, fallback = "abort") {
    const raw = typeof options === "string" ? options : options?.reason;
    return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  }

  async abort(options: any = {}) {
    const reason = this._normalizeAbortReason(options, "abort");
    const sessionPath = this.currentSessionPath;
    if (sessionPath) return this.abortSession(sessionPath, { reason });
    if (!this._session?.isStreaming) return false;

    try {
      this._session.abort()?.catch?.((err) =>
        log.warn(`abort focus session: abort failed: ${err.message}`),
      );
    } catch (err) {
      log.warn(`abort focus session: abort failed: ${err.message}`);
    }
    this._session = null;
    this._currentSessionPath = null;
    this._sessionStarted = false;
    return true;
  }

  steer(text: any) {
    if (!this._session?.isStreaming) return false;
    const sp = this._session.sessionManager?.getSessionFile?.();
    if (sp) {
      const entry = this._getSessionEntryByPath(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }
    this._session.steer(text);
    return true;
  }

  // ── Path 感知 API（Phase 2） ──

  async promptSession(sessionPath: any, text: any, opts: any) {
    const turnContext = normalizeSessionTurnContext(opts?.context);
    this._assertActiveDesktopSessionPath(sessionPath, "promptSession");
    let entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) {
      await this.ensureSessionLoaded(sessionPath);
      entry = this._getSessionEntryByPath(sessionPath);
    }
    if (!entry) throw new Error(t("error.sessionNotInCache", { path: sessionPath }));
    if (sessionPath === this.currentSessionPath && this._session !== entry.session) {
      this._session = entry.session;
    }
    entry.lastTouchedAt = Date.now();
    if (entry.sessionVisibility !== "plugin_private" && entry.sessionVisibility !== "private") {
      entry.visibleInSessionList = true;
    }
    if (sessionPath === this.currentSessionPath) this._sessionStarted = true;
    const engine = this._d.getEngine?.();
    const abortController = new AbortController();
    this._setRuntimeValueForPath(this._prePromptAbortControllers, sessionPath, abortController);
    try {
      ({ text, opts } = await prepareVisionInputForTextOnlyModel({
        targetModel: entry.session.model,
        text,
        opts,
        sessionPath,
        getVisionBridge: () => engine?.getVisionBridge?.(),
        visionPolicyTarget: engine,
        warn: (msg) => (engine?.log || console).warn?.(`[session] ${msg}`),
        signal: abortController.signal,
      }));
      ({ text, opts } = await prepareModelImageInputsForPrompt({
        text,
        opts,
        signal: abortController.signal,
      }));
    } finally {
      if (this._getRuntimeValueForPath(this._prePromptAbortControllers, sessionPath) === abortController) {
        this._deleteRuntimeValueForPath(this._prePromptAbortControllers, sessionPath);
      }
    }
    assertVideoInputSupported(entry.session.model, opts?.videos);
    assertAudioInputSupported(entry.session.model, opts?.audios);
    const promptOpts = buildPromptMediaOptions(opts);
    const nativeMediaTurn = engine?.beginCurrentTurnNativeMedia?.(sessionPath, opts);
    if (turnContext) this._setRuntimeValueForPath(this._turnContextBySession, sessionPath, turnContext);
    try {
      await entry.session.prompt(text, promptOpts);
    } finally {
      if (turnContext) this._deleteRuntimeValueForPath(this._turnContextBySession, sessionPath);
      engine?.endCurrentTurnNativeMedia?.(nativeMediaTurn);
      pruneSessionInlineMediaHistory(entry.session);
      this._projectOversizedSessionHistory(entry.session, sessionPath);
      this._scheduleRuntimePressureCheck(sessionPath, "prompt_session");
    }
    const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
    agent?._memoryTicker?.notifyTurn(sessionPath);
  }

  steerSession(sessionPath: any, text: any) {
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry?.session.isStreaming) return false;
    entry.lastTouchedAt = Date.now();
    entry.session.steer(text);
    return true;
  }

  async deliverCustomMessage(sessionPath: any, message: any, options: any = {}) {
    if (!sessionPath) throw new Error("deliverCustomMessage: sessionPath is required");
    this._assertActiveDesktopSessionPath(sessionPath, "deliverCustomMessage");
    let entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) {
      await this.ensureSessionLoaded(sessionPath);
      entry = this._getSessionEntryByPath(sessionPath);
    }
    if (!entry?.session) {
      throw new Error(`deliverCustomMessage: session not loaded for ${sessionPath}`);
    }
    if (typeof entry.session.sendCustomMessage !== "function") {
      throw new Error("deliverCustomMessage: session does not support custom messages");
    }

    entry.lastTouchedAt = Date.now();
    if (entry.session.isStreaming) {
      await entry.session.sendCustomMessage(message, { deliverAs: "followUp" });
      return { ok: true, mode: "followUp" };
    }

    const triggerTurn = options?.triggerTurn !== false;
    await entry.session.sendCustomMessage(message, { triggerTurn });
    return { ok: true, mode: triggerTurn ? "triggerTurn" : "notifyOnly" };
  }

  recordCustomEntry(sessionPath: any, customType: any, data: any) {
    if (!sessionPath) throw new Error("recordCustomEntry: sessionPath is required");
    if (!customType) throw new Error("recordCustomEntry: customType is required");
    this._assertActiveDesktopSessionPath(sessionPath, "recordCustomEntry");

    const liveManager = this._getSessionEntryByPath(sessionPath)?.session?.sessionManager;
    if (typeof liveManager?.appendCustomEntry === "function") {
      liveManager.appendCustomEntry(customType, data);
      return { ok: true, mode: "live" };
    }

    const manager = SessionManager.open(sessionPath, path.dirname(sessionPath));
    manager.appendCustomEntry(customType, data);
    return { ok: true, mode: "file" };
  }

  _cleanupAbortedSessionSidecars(sessionPath: any, reason: any) {
    if (!sessionPath) return;
    const shortPath = path.basename(sessionPath);
    const taskRegistry = this._d.getTaskRegistry?.() || this._d.taskRegistry || this._d.getEngine?.()?.taskRegistry;
    const subagentRuns = this._d.getSubagentRunStore?.() || this._d.subagentRuns || this._d.getEngine?.()?.subagentRuns;
    const subagentThreads = this._d.getSubagentThreadStore?.() || this._d.subagentThreads || this._d.getEngine?.()?.subagentThreads;
    const deferredResults = this._d.getDeferredResultStore?.() || this._d.deferredResults || this._d.getEngine?.()?.deferredResults;
    const confirmStore = this._d.getConfirmStore?.() || this._d.confirmStore || this._d.getEngine?.()?.confirmStore;

    try {
      taskRegistry?.abortByParentSession?.(sessionPath, reason);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: task cleanup failed: ${err.message}`);
    }
    try {
      subagentRuns?.abortByParentSession?.(sessionPath, reason);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: subagent run cleanup failed: ${err.message}`);
    }
    try {
      subagentThreads?.removeBySession?.(sessionPath);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: subagent thread cleanup failed: ${err.message}`);
    }
    try {
      deferredResults?.suppressBySession?.(sessionPath, reason);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: deferred cleanup failed: ${err.message}`);
    }
    try {
      confirmStore?.abortBySession?.(sessionPath);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: confirm cleanup failed: ${err.message}`);
    }
    try {
      this._d.closeTerminalsForSession?.(sessionPath);
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: terminal cleanup failed: ${err.message}`);
    }
    try {
      const closeBrowser = BrowserManager.instance().closeBrowserForSession(sessionPath);
      Promise.resolve(closeBrowser).catch((err) =>
        log.warn(`abort cleanup ${shortPath}: browser cleanup failed: ${err.message}`),
      );
    } catch (err) {
      log.warn(`abort cleanup ${shortPath}: browser cleanup failed: ${err.message}`);
    }
  }

  async abortSession(sessionPath: any, options: any = {}) {
    const reason = this._normalizeAbortReason(options, "abort");
    const pending = this._getRuntimeValueForPath(this._prePromptAbortControllers, sessionPath);
    if (pending) {
      pending.abort();
      this._deleteRuntimeValueForPath(this._prePromptAbortControllers, sessionPath);
      this._cleanupAbortedSessionSidecars(sessionPath, reason);
      return true;
    }
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry?.session.isStreaming) return false;
    this._cleanupAbortedSessionSidecars(sessionPath, reason);
    return this._forceReleaseStreamingSession(entry, sessionPath, reason);
  }

  // ── Mid-session model switch ──

  /**
   * 在已有 session 上切换模型（不创建新 session）。
   * 如果新模型的上下文窗口容不下当前对话，先压缩/截断。
   *
   * @param {string} sessionPath
   * @param {object} newModel - Pi SDK Model 对象
   * @returns {Promise<{ adaptations: string[] }>}
   */
  async switchSessionModel(sessionPath: any, newModel: any) {
    this._assertActiveDesktopSessionPath(sessionPath, "switchSessionModel");
    let entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) {
      await this.ensureSessionLoaded(sessionPath);
      entry = this._getSessionEntryByPath(sessionPath);
    }
    if (!entry) throw new Error(t("error.sessionNotInCache", { path: sessionPath }));
    if (sessionPath === this.currentSessionPath && this._session !== entry.session) {
      this._session = entry.session;
    }

    const { session } = entry;

    // 并发 guard
    if (entry._switching) {
      throw new Error("Model switch already in progress for this session");
    }
    if (session.isCompacting) {
      throw new Error("Cannot switch model while compaction is in progress");
    }

    entry._switching = true;
    const adaptations = [];
    const oldModel = session.model;

    try {
      // 估算当前上下文 token 数
      const msgs = session.agent?.state?.messages || [];
      const usage = session.getContextUsage?.();
      let currentTokens = usage?.tokens;
      if (currentTokens == null) {
        // fallback: 逐消息估算
        currentTokens = msgs.reduce((sum, m) => sum + estimateTokens(m), 0);
      }

      const effectiveWindow = Math.floor(newModel.contextWindow * 0.9) - 4000;

      if (currentTokens > effectiveWindow) {
        // 预检：最后一轮对话是否本身就超窗口（此时 compact/truncate 都救不了）
        const lastUserIdx = msgs.findLastIndex(m => m.role === "user");
        if (lastUserIdx >= 0) {
          const lastTurnTokens = msgs.slice(lastUserIdx).reduce((s, m) => s + estimateTokens(m), 0);
          if (lastTurnTokens > effectiveWindow) {
            throw new Error("当前对话无法适配目标模型的上下文窗口");
          }
        }

        // 尝试压缩
        try {
          const compactionResult = await this._compactWithModel(session, effectiveWindow, oldModel);
          const hardTruncated = compactionResult?.details?.reason === "cache-preserving-compaction-hard-truncate";
          adaptations.push(hardTruncated ? "truncated" : "compacted");
        } catch (compactErr) {
          log.warn(`compactWithModel failed, falling back to hard truncate: ${compactErr.message}`);
          // 压缩失败，尝试硬截断
          try {
            await this._hardTruncate(session, effectiveWindow);
            adaptations.push("truncated");
          } catch (truncErr) {
            throw new Error(`Failed to fit context into new model window: ${truncErr.message}`);
          }
        }

        // 终极检查：压缩/截断后仍然超窗口则拒绝
        const postMsgs = session.agent.state.messages;
        const postTokens = postMsgs.reduce((sum, m) => sum + estimateTokens(m), 0);
        if (postTokens > effectiveWindow) {
          throw new Error(
            `Context still exceeds new model window after adaptation (${postTokens} > ${effectiveWindow})`
          );
        }
      }

      // 执行模型切换
      await session.setModel(newModel);
      entry.modelId = newModel.id;
      entry.modelProvider = newModel.provider;
      const models = this._d.getModels();
      const currentThinkingLevel = this.getSessionThinkingLevel(sessionPath);
      const nextThinkingLevel = normalizeThinkingLevelForModel(currentThinkingLevel, newModel);
      entry.thinkingLevel = nextThinkingLevel;
      session.setThinkingLevel?.(models?.resolveThinkingLevel?.(nextThinkingLevel) || nextThinkingLevel);
      this.writeSessionMeta(sessionPath, { thinkingLevel: nextThinkingLevel });
      this._renewCachePrefixContract(sessionPath, entry, "model_switch");

      return { adaptations, thinkingLevel: nextThinkingLevel };
    } finally {
      entry._switching = false;
    }
  }

  /**
   * 用主模型同前缀摘要来压缩对话历史（为 model switch 准备窗口）。
   * @private
   */
  async _compactWithModel(session: any, effectiveWindow: any, model: any) {
    const sessionPath = session?.sessionManager?.getSessionFile?.() || this.currentSessionPath;
    const sessionId = this._sessionIdForPath(sessionPath);
    return await runCachePreservingCompactionForSession(session, {
      model,
      settings: {
        enabled: true,
        reserveTokens: 4000,
        keepRecentTokens: effectiveWindow,
      },
      emitLifecycle: true,
      lifecycleReason: "model_switch",
      usageLedger: this._d.getUsageLedger?.(),
      usageContext: {
        source: {
          subsystem: "compaction",
          operation: "compact",
          surface: "desktop",
          trigger: "overflow",
        },
        attribution: {
          kind: "session",
          agentId: this._d.agentIdFromSessionPath?.(sessionPath) || this._d.getActiveAgentId?.() || null,
          ...(sessionId ? { sessionId } : {}),
          sessionPath,
        },
      },
    });
  }

  /**
   * 硬截断对话历史（无 API 调用，用固定文本作为摘要）。
   * @private
   */
  async _hardTruncate(session: any, effectiveWindow: any) {
    const sm = session.sessionManager;
    const pathEntries = sm.getBranch();
    const reason = "model_switch";
    session?._emit?.({ type: "compaction_start", reason });

    try {
      const result = computeHardTruncation(pathEntries, effectiveWindow, {
        summary: "[由于模型切换，早期对话历史已被截断]",
        reason: "model-switch-truncation",
      });
      if (!result) {
        throw new Error("Cannot hard-truncate: not enough messages or cut at beginning");
      }

      const saved = await appendCompactionResultToSession(session, result, { fromExtension: false });
      session?._emit?.({
        type: "compaction_end",
        reason,
        result: saved,
        aborted: false,
        willRetry: false,
      });
      return saved;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session?._emit?.({
        type: "compaction_end",
        reason,
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: `Compaction failed: ${message}`,
      });
      throw error;
    }
  }

  /** Get plan mode for the current (focused) session */
  getPlanMode() {
    return isReadOnlyPermissionMode(this.getPermissionMode());
  }

  _readStoredPermissionModeDefault() {
    const prefs = this._d.getPrefs?.();
    if (typeof prefs?.getSessionPermissionModeDefault !== "function") {
      return DEFAULT_SESSION_PERMISSION_MODE;
    }
    return normalizeSessionPermissionMode(prefs.getSessionPermissionModeDefault());
  }

  _getDefaultPermissionMode() {
    return normalizeSessionPermissionMode(
      this._runtimePermissionModeDefault ?? this._readStoredPermissionModeDefault(),
    );
  }

  _setDefaultPermissionMode(mode: any, { persist = true }: any = {}) {
    let normalized = normalizeSessionPermissionMode(mode);
    this._runtimePermissionModeDefault = normalized;
    if (!persist) return normalized;

    const prefs = this._d.getPrefs?.();
    if (typeof prefs?.setSessionPermissionModeDefault === "function") {
      normalized = normalizeSessionPermissionMode(prefs.setSessionPermissionModeDefault(normalized));
      this._runtimePermissionModeDefault = normalized;
    }
    return normalized;
  }

  getPermissionModeDefault() {
    return this._getDefaultPermissionMode();
  }

  setPermissionModeDefault(mode: any) {
    return this._setDefaultPermissionMode(mode);
  }

  getPermissionMode(sessionPath = this.currentSessionPath) {
    if (!sessionPath) return this._pendingPermissionMode || this._getDefaultPermissionMode();
    const entry = this._sessionFolderEntry(sessionPath);
    if (!entry) {
      const manifest = this._resolveSessionManifestForPath(sessionPath);
      if (manifest?.permissionModeSnapshot?.mode) {
        return normalizeSessionPermissionMode(manifest.permissionModeSnapshot.mode);
      }
    }
    return normalizeSessionPermissionMode(entry || { permissionMode: this._getDefaultPermissionMode() });
  }

  getSessionThinkingLevel(sessionPath = this.currentSessionPath) {
    const fallback = this.getDefaultThinkingLevel();
    if (!sessionPath) return fallback;
    const entry = this._sessionFolderEntry(sessionPath);
    if (!entry) {
      const manifest = this._resolveSessionManifestForPath(sessionPath);
      if (manifest?.thinkingLevel) return normalizeSessionThinkingLevel(manifest.thinkingLevel);
    }
    return normalizeSessionThinkingLevel(entry?.thinkingLevel || fallback);
  }

  async setSessionThinkingLevel(sessionPath: any, level: any) {
    if (!sessionPath) {
      return { ok: false, error: "session thinking level requires sessionPath" };
    }
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry?.session) {
      const meta = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
      if (meta) {
        const nextLevel = normalizeSessionThinkingLevel(level);
        meta.thinkingLevel = nextLevel;
        await this.writeSessionMeta(sessionPath, { thinkingLevel: nextLevel });
        const manifest = this._resolveSessionManifestForPath(sessionPath);
        if (manifest) this._sessionManifestStore.setThinkingLevel(manifest.sessionId, nextLevel);
        this._emitSessionMetadataUpdated(sessionPath, { thinkingLevel: nextLevel });
        return { ok: true, thinkingLevel: nextLevel };
      }
      return { ok: false, error: "session not found", thinkingLevel: this.getSessionThinkingLevel(sessionPath) };
    }
    const models = this._d.getModels();
    const nextLevel = normalizeThinkingLevelForModel(level, entry.session.model);
    entry.thinkingLevel = nextLevel;
    entry.session.setThinkingLevel?.(models.resolveThinkingLevel(nextLevel));
    await this.writeSessionMeta(sessionPath, { thinkingLevel: nextLevel });
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest) this._sessionManifestStore.setThinkingLevel(manifest.sessionId, nextLevel);
    this._emitSessionMetadataUpdated(sessionPath, { thinkingLevel: nextLevel });
    return { ok: true, thinkingLevel: nextLevel };
  }

  getAccessMode(sessionPath = this.currentSessionPath) {
    return legacyAccessModeFromPermissionMode(this.getPermissionMode(sessionPath));
  }

  setPendingAccessMode(mode: any) {
    return this.setPendingPermissionMode(mode);
  }

  setPendingPermissionMode(mode: any) {
    const nextMode = normalizeSessionPermissionMode(mode);
    this._setDefaultPermissionMode(nextMode);
    this._pendingPermissionMode = nextMode;
    this._emitPermissionModeChanged(nextMode, null);
    return { ok: true, mode: nextMode, enabled: isReadOnlyPermissionMode(nextMode) };
  }

  _applyPermissionModeToEntry(sessionPath: any, entry: any, nextMode: any) {
    entry.permissionMode = nextMode;
    entry.accessMode = legacyAccessModeFromPermissionMode(nextMode);
    entry.planMode = isReadOnlyPermissionMode(nextMode);
    this.writeSessionMeta(sessionPath, {
      permissionMode: entry.permissionMode,
      accessMode: entry.accessMode,
      planMode: entry.planMode,
    });
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    if (manifest) {
      this._sessionManifestStore.setPermissionModeSnapshot(manifest.sessionId, {
        mode: nextMode,
        source: "session_override",
      });
    }
    this._emitPermissionModeChanged(nextMode, sessionPath);
    return { ok: true, mode: nextMode, enabled: entry.planMode };
  }

  setCurrentSessionPermissionMode(mode: any) {
    const nextMode = normalizeSessionPermissionMode(mode);
    const sp = this.currentSessionPath;
    if (!sp) {
      return {
        ok: false,
        error: "current session permission mode requires an active session",
        mode: this._getDefaultPermissionMode(),
      };
    }
    const entry = this._getSessionEntryByPath(sp);
    if (!entry) {
      const meta = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sp);
      if (meta) return this._applyPermissionModeToEntry(sp, meta, nextMode);
      return {
        ok: false,
        error: "current session not found",
        mode: this.getPermissionMode(sp),
      };
    }
    return this._applyPermissionModeToEntry(sp, entry, nextMode);
  }

  setSessionPermissionMode(sessionPath: any, mode: any, _options: any = {}) {
    const nextMode = normalizeSessionPermissionMode(mode);
    if (!sessionPath) {
      return {
        ok: false,
        error: "session permission mode requires sessionPath",
        mode: this._getDefaultPermissionMode(),
      };
    }
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) {
      const meta = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
      if (meta) {
        return this._applyPermissionModeToEntry(sessionPath, meta, nextMode);
      }
      return {
        ok: false,
        error: "session not found",
        mode: this.getPermissionMode(sessionPath),
      };
    }
    return this._applyPermissionModeToEntry(sessionPath, entry, nextMode);
  }

  setPermissionMode(mode: any) {
    const nextMode = normalizeSessionPermissionMode(mode);
    const sp = this.currentSessionPath;
    if (sp) {
      const entry = this._getSessionEntryByPath(sp);
      if (!entry) {
        const meta = this._getRuntimeValueForPath(this._hibernatedSessionMeta, sp);
        if (meta) return this._applyPermissionModeToEntry(sp, meta, nextMode);
      }
      if (!entry) return { ok: false, mode: this.getPermissionMode(sp) };
      return this._applyPermissionModeToEntry(sp, entry, nextMode);
    }

    return this.setPendingPermissionMode(nextMode);
  }

  setAccessMode(mode: any) {
    return this.setPermissionMode(mode);
  }

  /** Backward-compatible route for the old Plan Mode API. */
  setPlanMode(enabled: any) {
    return this.setPermissionMode(enabled ? SESSION_PERMISSION_MODES.READ_ONLY : SESSION_PERMISSION_MODES.OPERATE);
  }

  _emitPermissionModeChanged(mode: any, sessionPath: any) {
    const normalized = normalizeSessionPermissionMode(mode);
    const readOnly = isReadOnlyPermissionMode(normalized);
    const accessMode = legacyAccessModeFromPermissionMode(normalized);
    this._d.emitEvent({ type: "permission_mode", mode: normalized, readOnly }, sessionPath);
    this._d.emitEvent({ type: "access_mode", mode: accessMode, permissionMode: normalized, readOnly }, sessionPath);
    this._d.emitEvent({ type: "plan_mode", enabled: readOnly, mode: normalized }, sessionPath);
    const label = normalized === SESSION_PERMISSION_MODES.READ_ONLY
      ? "只读"
      : (normalized === SESSION_PERMISSION_MODES.ASK
        ? "先问"
        : (normalized === SESSION_PERMISSION_MODES.AUTO ? "自动审核" : "操作"));
    this._d.emitDevLog(`Permission Mode: ${label}`, "info");
  }

  _emitSessionMetadataUpdated(sessionPath: any, metadata: any) {
    if (!sessionPath || !metadata || typeof metadata !== "object") return;
    this._d.emitEvent({
      type: "session_metadata_updated",
      metadata: { ...metadata },
    }, sessionPath);
  }

  /**
   * 获取当前焦点 session 的完整模型引用 {id, provider}。
   *
   * 数据源：entry 的 modelId + modelProvider 字段（session 创建和 switchSessionModel
   * 时成对写入）。找不到 provider（意味着 session 未完整初始化）返回 null——
   * 禁止按单 id 降级。
   */
  getCurrentSessionModelRef() {
    const sp = this.currentSessionPath;
    if (!sp) return null;
    const entry = this._sessionFolderEntry(sp);
    if (!entry?.modelId || !entry?.modelProvider) return null;
    return { id: entry.modelId, provider: entry.modelProvider };
  }

  /** 中断所有正在 streaming 的 session */
  async abortAllStreaming() {
    let count = 0;
    for (const [sessionKey, entry] of this._sessions) {
      const sp = this._sessionPathForEntry(entry, sessionKey);
      if (entry.session.isStreaming) {
        this._cleanupAbortedSessionSidecars(sp, "abort_all");
        if (this._forceReleaseStreamingSession(entry, sp, "abort_all")) count++;
      }
    }
    return count;
  }

  // ── Lifecycle teardown (统一入口) ──

  /**
   * 强制释放一个卡在 streaming 状态的 session。
   *
   * 停止按钮属于控制平面，不能等待 provider stream 自己收尾。这里先把
   * Hanako 侧的 sessionPath 控制权释放出来，再把 SDK abort 和资源清理
   * 丢到后台继续做。旧 session 的事件订阅和 SDK agent 连接会先断开，
   * 避免它之后恢复时把过期 delta 写回同一个前端会话或历史文件。
   *
   * @param {object} entry
   * @param {string} sessionPath
   * @param {string} reason
   * @returns {boolean}
   * @private
   */
  _forceReleaseStreamingSession(entry: any, sessionPath: any, reason: any) {
    if (!entry?.session?.isStreaming) return false;

    const session = entry.session;
    const spShort = sessionPath ? path.basename(sessionPath) : "(anon)";
    entry.lastTouchedAt = Date.now();

    this._clearRuntimePressureTimer(sessionPath);
    this._deleteRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
    this._deleteRuntimeValueForPath(this._sessions, sessionPath);
    if (this._session === session || this.currentSessionPath === sessionPath) {
      this._session = null;
      this._currentSessionPath = null;
      this._sessionStarted = false;
    }

    const unsub = entry.unsub;
    entry.unsub = null;
    try {
      unsub?.();
    } catch (err) {
      log.warn(`forceRelease[${reason}] ${spShort}: unsub failed: ${err.message}`);
    }

    this._d.emitEvent?.({
      type: "session_status",
      isStreaming: false,
      aborted: true,
      reason,
    }, sessionPath);

    try {
      const abortPromise = session.abort?.();
      Promise.resolve(abortPromise).catch((err) =>
        log.warn(`forceRelease[${reason}] ${spShort}: abort failed: ${err.message}`),
      );
    } catch (err) {
      log.warn(`forceRelease[${reason}] ${spShort}: abort failed: ${err.message}`);
    }

    try {
      session.dispose?.();
    } catch (err) {
      log.warn(`forceRelease[${reason}] ${spShort}: session.dispose failed: ${err.message}`);
    }

    this._teardownSessionEntry(entry, sessionPath, reason).catch((err) =>
      log.warn(`forceRelease[${reason}] ${spShort}: teardown failed: ${err.message}`),
    );
    return true;
  }

  /**
   * 释放一个 sessionEntry 的所有资源。
   *
   * 三步契约:
   *   1. emit session_shutdown — 让 SDK 扩展清理 setInterval / store 订阅
   *   2. unsub — 取消 Hanako 层的 session 事件转发
   *   3. session.dispose — 让 SDK 释放 agent 订阅和 event listeners
   *
   * 任何一步失败都 log.warn 并继续下一步, 保证下游资源一定被释放。
   *
   * 契约背景: SDK 的 AgentSession.dispose() 本身不 emit session_shutdown,
   * 消费方必须显式 emit, 否则 deferred-result-ext 的 30 秒 setInterval
   * 永远不会被清理。
   *
   * @param {object} entry - sessionEntry (session, unsub, agentId, ...)
   * @param {string} sessionPath - 用于日志识别
   * @param {string} reason - teardown 原因 (lru / close / close_all / isolated)
   * @private
   */
  async _teardownSessionEntry(entry: any, sessionPath: any, reason: any) {
    if (!entry) return;
    const spShort = sessionPath ? path.basename(sessionPath) : "(anon)";
    await teardownSessionResources({
      session: entry.session,
      unsub: entry.unsub,
      label: `teardown[${reason}] ${spShort}`,
      warn: (msg) => log.warn(msg),
    });
  }

  _canHibernateSessionRuntime(entry: any, sessionPath: any) {
    if (!entry?.session || !sessionPath) return false;
    if (entry.session.isStreaming || entry.session.isCompacting || entry._switching) return false;
    if (this._hasRuntimeValueForPath(this._prePromptAbortControllers, sessionPath)) return false;
    const pendingDeferred = this._d.getDeferredResultStore?.()?.listPending?.(sessionPath);
    if (Array.isArray(pendingDeferred) && pendingDeferred.length > 0) return false;
    return true;
  }

  async hibernateSessionRuntime(sessionPath: any, reason = "memory_pressure") {
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) return false;
    if (!this._canHibernateSessionRuntime(entry, sessionPath)) return false;

    const isFocus = this._session === entry.session || this.currentSessionPath === sessionPath;
    if (isFocus) this._currentSessionPath = sessionPath;
    this._setRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath, {
      sessionId: entry.sessionId || this._sessionRuntimeKeyForPath(sessionPath, { warn: false }),
      sessionPath,
      agentId: entry.agentId,
      memoryEnabled: entry.memoryEnabled,
      experienceEnabled: entry.experienceEnabled,
      modelId: entry.modelId,
      modelProvider: entry.modelProvider,
      cwd: entry.cwd || entry.session?.sessionManager?.getCwd?.() || null,
      workspaceFolders: Array.isArray(entry.workspaceFolders) ? [...entry.workspaceFolders] : [],
      authorizedFolders: Array.isArray(entry.authorizedFolders) ? [...entry.authorizedFolders] : [],
      permissionMode: entry.permissionMode,
      accessMode: entry.accessMode,
      planMode: entry.planMode,
      thinkingLevel: entry.thinkingLevel,
      toolNames: Array.isArray(entry.toolNames) ? [...entry.toolNames] : entry.toolNames,
      contextUsage: entry.session?.getContextUsage?.() || null,
      hibernatedAt: Date.now(),
    });
    await this._teardownSessionEntry(entry, sessionPath, reason);
    this._deleteRuntimeValueForPath(this._sessions, sessionPath);
    this._clearRuntimePressureTimer(sessionPath);
    if (isFocus) {
      this._session = null;
    }
    log.log(`session runtime hibernated (${reason}): ${path.basename(sessionPath)}`);
    return true;
  }

  checkRuntimeMemoryPressure(sessionPath: any, reason = "manual") {
    return this._checkRuntimeMemoryPressure(sessionPath, reason);
  }

  async _checkRuntimeMemoryPressure(sessionPath: any, reason: any) {
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) return { hibernated: false, reason: "not_loaded" };
    if (!this._memoryPressure.enabled) return { hibernated: false, reason: "disabled" };
    if (!this._canHibernateSessionRuntime(entry, sessionPath)) {
      return { hibernated: false, reason: "busy" };
    }

    const retainedBytes = estimateSessionRuntimeRetainedBytes(entry.session);
    const memory = this._readMemoryUsage();
    const thresholds = this._memoryPressure.thresholds;
    const externalBytes = (memory.external || 0) + (memory.arrayBuffers || 0);
    const payloadPressure = retainedBytes >= thresholds.highPayloadBytes;
    const processPressure = memory.rss >= thresholds.highRssBytes || externalBytes >= thresholds.highExternalBytes;
    const shouldHibernate = payloadPressure || (processPressure && retainedBytes >= thresholds.minRetainedBytes);
    if (!shouldHibernate) {
      return { hibernated: false, reason: "below_threshold", retainedBytes, memory };
    }

    const hibernated = await this.hibernateSessionRuntime(sessionPath, `memory_pressure:${reason}`);
    return {
      hibernated,
      reason: hibernated ? "memory_pressure" : "busy",
      retainedBytes,
      memory,
    };
  }

  _readMemoryUsage() {
    try {
      const usage = this._memoryPressure.getMemoryUsage();
      return {
        rss: Number(usage?.rss) || 0,
        heapUsed: Number(usage?.heapUsed) || 0,
        external: Number(usage?.external) || 0,
        arrayBuffers: Number(usage?.arrayBuffers) || 0,
      };
    } catch (err) {
      log.warn(`memory pressure usage read failed: ${err.message}`);
      return { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
    }
  }

  _scheduleRuntimePressureCheck(sessionPath: any, reason = "post_turn") {
    if (!this._memoryPressure.enabled || !sessionPath) return;
    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) return;
    const scheduledSession = entry.session;
    this._clearRuntimePressureTimer(sessionPath);
    const delay = Math.max(0, Number(this._memoryPressure.thresholds.checkDelayMs) || 0);
    const timer = setTimeout(() => {
      this._deleteRuntimeValueForPath(this._runtimePressureTimers, sessionPath);
      const current = this._getSessionEntryByPath(sessionPath);
      if (!current || current.session !== scheduledSession) return;
      this._checkRuntimeMemoryPressure(sessionPath, reason).catch((err) => {
        log.warn(`runtime pressure check failed for ${path.basename(sessionPath)}: ${err.message}`);
      });
    }, delay);
    timer.unref?.();
    this._setRuntimeValueForPath(this._runtimePressureTimers, sessionPath, timer);
  }

  _clearRuntimePressureTimer(sessionPath: any) {
    const timer = this._getRuntimeValueForPath(this._runtimePressureTimers, sessionPath);
    if (!timer) return;
    clearTimeout(timer);
    this._deleteRuntimeValueForPath(this._runtimePressureTimers, sessionPath);
  }

  // ── Session 关闭 ──

  async discardSessionRuntime(sessionPath: any, reason = "discard", options: { skipMemory?: boolean } = {}) {
    if (!sessionPath) return false;
    this._clearRuntimePressureTimer(sessionPath);
    const hadHibernated = this._deleteRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);
    const entry = this._getSessionEntryByPath(sessionPath);
    if (entry) {
      const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
      if (options.skipMemory !== true) {
        agent?._memoryTicker?.notifySessionEnd(sessionPath).catch((err) =>
          log.warn(`discardSessionRuntime ${path.basename(sessionPath)}: notifySessionEnd failed: ${err.message}`),
        );
      }
      if (entry.session.isStreaming) {
        this._forceReleaseStreamingSession(entry, sessionPath, reason);
      } else {
        await this._teardownSessionEntry(entry, sessionPath, reason);
        this._deleteRuntimeValueForPath(this._sessions, sessionPath);
      }
    }

    // 清理该 session 的 pending confirmation / deferred result
    this._d.getConfirmStore?.()?.abortBySession(sessionPath);
    this._d.getDeferredResultStore?.()?.clearBySession(sessionPath);
    if (sessionPath) {
      try {
        this._d.closeTerminalsForSession?.(sessionPath);
      } catch (err) {
        log.warn(`discardSessionRuntime ${path.basename(sessionPath)}: close terminals failed: ${err.message}`);
      }
    }
    if (sessionPath === this.currentSessionPath) {
      this._session = null;
      this._currentSessionPath = null;
      this._sessionStarted = false;
    }
    const discarded = !!entry || hadHibernated;
    if (discarded && typeof this._d.onSessionRuntimeDiscarded === "function") {
      try {
        await this._d.onSessionRuntimeDiscarded(sessionPath, reason);
      } catch (err) {
        log.warn(`discardSessionRuntime ${path.basename(sessionPath)}: runtime state cleanup failed: ${(err as any).message}`);
      }
    }
    return discarded;
  }

  async discardSessionsForAgent(agentId: any, reason = "agent deleted") {
    if (!agentId) return 0;
    const paths = new Set();
    for (const [sessionKey, entry] of this._sessions) {
      const sessionPath = this._sessionPathForEntry(entry, sessionKey);
      const entryAgentId = entry?.agentId || this._d.agentIdFromSessionPath?.(sessionPath);
      if (entryAgentId === agentId) paths.add(sessionPath);
    }
    for (const [sessionKey, entry] of this._hibernatedSessionMeta) {
      const sessionPath = this._sessionPathForEntry(entry, sessionKey);
      const entryAgentId = entry?.agentId || this._d.agentIdFromSessionPath?.(sessionPath);
      if (entryAgentId === agentId) paths.add(sessionPath);
    }
    let discarded = 0;
    for (const sessionPath of paths) {
      if (await this.discardSessionRuntime(sessionPath, reason)) discarded += 1;
    }
    return discarded;
  }

  async closeSession(sessionPath: any) {
    return this.discardSessionRuntime(sessionPath, "close");
  }

  async closeAllSessions() {
    for (const [sessionKey, timer] of this._runtimePressureTimers) {
      const sessionPath = this._sessionPathForEntry(timer, sessionKey) || sessionKey;
      this._clearRuntimePressureTimer(sessionPath);
    }
    // abort all streaming sessions + teardown（记忆收尾由 disposeAll 带超时处理）
    for (const [sessionKey, entry] of this._sessions) {
      const sessionPath = this._sessionPathForEntry(entry, sessionKey);
      if (entry.session.isStreaming) {
        this._forceReleaseStreamingSession(entry, sessionPath, "close_all");
      } else {
        await this._teardownSessionEntry(entry, sessionPath, "close_all");
      }
      // closeAll 只卸载运行时 sidecar，不代表删除 session。
      // pending confirmation 必须 abort；后台任务结果由 DeferredResultCoordinator
      // 按 sessionPath 持久投递，closeAll 只卸载 runtime，不应清掉 pending。
      this._d.getConfirmStore?.()?.abortBySession(sessionPath);
    }
    try {
      this._d.closeAllTerminals?.();
    } catch (err) {
      log.warn(`closeAllSessions: close terminals failed: ${err.message}`);
    }
    this._sessions.clear();
    this._hibernatedSessionMeta.clear();
    this._session = null;
    this._currentSessionPath = null;
  }

  async cleanupSession() {
    await this.closeAllSessions();
    log.log("sessions cleaned up");
  }

  /**
   * Provider 配置变更后，强制所有 active session 从 ModelRegistry 重新解析
   * 当前 model 对象。
   *
   * 必要性：Pi SDK 把 baseUrl 烤在 model 对象字段里，session 持的是创建时
   * 的对象引用。Hanako 这边 ModelRegistry.refresh() 之后会重建模型对象，
   * 但 session 还指向旧对象——下一个 turn 仍用旧 baseUrl 发请求。
   * 本方法由 engine.onProviderChanged() 触发。
   */
  refreshAllSessionsModels() {
    for (const [sessionKey, entry] of this._sessions) {
      const sessionPath = this._sessionPathForEntry(entry, sessionKey);
      try {
        refreshSessionModelFromRegistry(entry.session);
        this._renewCachePrefixContract(sessionPath, entry, "provider_refresh");
      } catch (err) {
        log.warn(`refreshAllSessionsModels: ${err.message}`);
      }
    }
  }

  // ── Session 查询 ──

  getSessionByPath(sessionPath: any) {
    return this._getSessionEntryByPath(sessionPath)?.session ?? null;
  }

  getSessionContextUsage(sessionPath: any) {
    if (!sessionPath) return null;
    const live = this._getSessionEntryByPath(sessionPath)?.session?.getContextUsage?.();
    if (live) return live;
    return this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath)?.contextUsage || null;
  }

  _assertActiveDesktopSessionPath(sessionPath: any, operation: any) {
    if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) {
      throw new Error(`${operation}: path must be an active desktop session under agents/{id}/sessions/*.jsonl; got ${sessionPath}`);
    }
  }

  _isDeletedAgentSessionPath(sessionPath: any) {
    const agentId = this._d.agentIdFromSessionPath?.(sessionPath);
    return !!agentId && this._d.isAgentDeleted?.(agentId) === true;
  }

  isRunnableSessionPath(sessionPath: any) {
    if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) return false;
    if (this._isDeletedAgentSessionPath(sessionPath)) return false;
    if (
      this._getSessionEntryByPath(sessionPath)
      || this._getRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath)
    ) return true;
    try {
      return fs.existsSync(sessionPath);
    } catch {
      return false;
    }
  }

  /**
   * #1624：返回当前应展示的"工具能力有更新"提示数据；无漂移或已被 dismiss
   * （dismissed fingerprint === 当前 live fingerprint）时返回 null。
   * 数据在 restore 完成时算好挂在 sessionEntry 上，这里只做读取与 dismiss 过滤。
   */
  getSessionCapabilityDriftNotice(sessionPath: any) {
    const entry = this._getSessionEntryByPath(sessionPath);
    const drift = entry?.capabilityDrift;
    if (!drift?.hasDrift) return null;
    if (entry.capabilityDriftDismissedFingerprint === drift.fingerprint) return null;
    return {
      ...drift,
      addedToolNames: [...drift.addedToolNames],
      removedToolNames: [...drift.removedToolNames],
      invalidToolNames: [...drift.invalidToolNames],
    };
  }

  /**
   * #1624：记录"用户关闭了当前 fingerprint 的提示"。持久化在 session-meta
   * （跟 session 走，跨重启生效）；指纹再次变化时才重新提示。
   */
  async dismissSessionCapabilityDrift(sessionPath: any, fingerprint: any) {
    this._assertActiveDesktopSessionPath(sessionPath, "dismissSessionCapabilityDrift");
    if (typeof fingerprint !== "string" || !fingerprint) {
      throw new Error("dismissSessionCapabilityDrift: fingerprint required");
    }
    const entry = this._getSessionEntryByPath(sessionPath);
    if (entry) entry.capabilityDriftDismissedFingerprint = fingerprint;
    await this.writeSessionMeta(sessionPath, { capabilityDriftDismissedFingerprint: fingerprint });
    return { ok: true };
  }

  async reloadSessionRuntime(sessionPath: any, { refreshCapabilitySnapshots = false }: any = {}) {
    this._assertActiveDesktopSessionPath(sessionPath, "reloadSessionRuntime");
    if (this._isDeletedAgentSessionPath(sessionPath)) {
      throw new Error("reloadSessionRuntime: session belongs to a deleted agent");
    }
    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (!targetAgentId) {
      throw new Error(`reloadSessionRuntime: cannot resolve agentId for ${sessionPath}`);
    }
    const agent = this._d.getAgentById(targetAgentId);
    if (!agent) {
      throw new Error(`reloadSessionRuntime: agent "${targetAgentId}" not found`);
    }

    const oldEntry = this._getSessionEntryByPath(sessionPath);
    if (oldEntry) {
      if (oldEntry.session?.isStreaming || oldEntry.session?.isCompacting || oldEntry._switching) {
        throw new Error("reloadSessionRuntime: session is busy");
      }
      await this._teardownSessionEntry(oldEntry, sessionPath, "reload");
      this._deleteRuntimeValueForPath(this._sessions, sessionPath);
    }
    this._deleteRuntimeValueForPath(this._hibernatedSessionMeta, sessionPath);

    const memoryEnabled = typeof oldEntry?.memoryEnabled === "boolean"
      ? oldEntry.memoryEnabled
      : this.getSessionMemoryEnabled(sessionPath);

    this._emitSessionHealthWarning(sessionPath);
    // #1285: 在 open 前修复坏会话的孤儿 toolResult（必须早于 SessionManager.open）
    this._repairOrphanToolHistory(sessionPath);
    this._repairInlineMediaHistory(sessionPath);
    const sessionMgr = SessionManager.open(sessionPath, agent.sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    const result = await this.createSession(sessionMgr, cwd, memoryEnabled, null, {
      restore: true,
      agent,
      agentId: targetAgentId,
      preserveAgentMemoryState: true,
      refreshCapabilitySnapshots,
    });
    return result.session;
  }

  /**
   * 确保 sessionPath 已加载进 _sessions cache，但**不改 this._session（UI 焦点）**。
   *
   * 供 /rc 接管态使用：bridge 端操作桌面 session 时，该 session 可能未被
   * UI 打开过（不在 cache 里）。switchSession 会切焦点 + flush 旧 session，
   * 副作用太重。此方法走 createSession 的 cold-load 路径后回滚 this._session 指针，
   * 保证 UI 焦点和内存态不受影响。
   *
   * 幂等：已缓存则直接返回，刷新 lastTouchedAt。
   *
   * @param {string} sessionPath
   * @returns {Promise<object>} AgentSession 实例
   */
  async ensureSessionLoaded(sessionPath: any) {
    this._assertActiveDesktopSessionPath(sessionPath, "ensureSessionLoaded");
    if (this._isDeletedAgentSessionPath(sessionPath)) {
      throw new Error("ensureSessionLoaded: session belongs to a deleted agent");
    }
    const existing = this._getSessionEntryByPath(sessionPath);
    if (existing) {
      existing.lastTouchedAt = Date.now();
      return existing.session;
    }

    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (!targetAgentId) {
      throw new Error(`ensureSessionLoaded: cannot resolve agentId for ${sessionPath}`);
    }
    const agent = this._d.getAgentById(targetAgentId);
    if (!agent) {
      throw new Error(`ensureSessionLoaded: agent "${targetAgentId}" not found`);
    }

    // memoryEnabled 从 session-owned state 恢复（跟 switchSession 同一份数据源）
    const memoryEnabled = this.getSessionMemoryEnabled(sessionPath);

    // 保存焦点：createSession 副作用会设 this._session / _sessionStarted，
    // /rc 这类纯 attach 路径结束后必须完整回滚，避免污染桌面 UI 的当前会话态。
    const prevFocus = this._session;
    const prevCurrentSessionPath = this._currentSessionPath;
    const prevSessionStarted = this._sessionStarted;
    try {
      // #521: attach 路径同样要做健康度评估，否则 bridge / RC 自动恢复时也会反复失败
      this._emitSessionHealthWarning(sessionPath);
      this._repairOversizedSessionHistory(sessionPath);
      // #1285: 在 open 前修复坏会话的孤儿 toolResult（必须早于 SessionManager.open）
      this._repairOrphanToolHistory(sessionPath);
      this._repairInlineMediaHistory(sessionPath);
      const sessionMgr = SessionManager.open(sessionPath, agent.sessionDir);
      const cwd = sessionMgr.getCwd?.() || undefined;
      await this.createSession(sessionMgr, cwd, memoryEnabled, null, {
        restore: true,
        agent,
        agentId: targetAgentId,
        preserveAgentMemoryState: true,
      });
    } finally {
      this._session = prevFocus;
      this._currentSessionPath = prevCurrentSessionPath;
      this._sessionStarted = prevSessionStarted;
    }

    const entry = this._getSessionEntryByPath(sessionPath);
    if (!entry) throw new Error(`ensureSessionLoaded: session not in cache after createSession`);
    if (entry.agentId !== targetAgentId) {
      throw new Error(`ensureSessionLoaded: restored agentId mismatch (${entry.agentId} !== ${targetAgentId})`);
    }
    return entry.session;
  }

  isSessionStreaming(sessionPath: any) {
    return this._hasRuntimeValueForPath(this._prePromptAbortControllers, sessionPath)
      || !!this.getSessionByPath(sessionPath)?.isStreaming;
  }

  isSessionSwitching(sessionPath: any) {
    return !!this._getSessionEntryByPath(sessionPath)?._switching;
  }

  async abortSessionByPath(sessionPath: any, options: any = {}) {
    return this.abortSession(sessionPath, options);
  }

  async listSessions(options: any = {}) {
    const activeAgents = this._d.listAgents({
      includePluginPrivate: options.includePluginPrivate === true,
      ...(options.ownerPluginId ? { ownerPluginId: options.ownerPluginId } : {}),
    });
    const deletedAgents = this._d.listDeletedAgents?.() || [];
    const agents = [
      ...activeAgents.map(agent => ({ ...agent, agentDeleted: false })),
      ...deletedAgents.map(agent => ({ ...agent, agentDeleted: true })),
    ];

    // 并行处理每个 agent，避免串行同步 I/O 阻塞事件循环
    const perAgent = await Promise.all(agents.map(async (agent) => {
      const sessionDir = path.join(this._d.agentsDir, agent.id, "sessions");
      try { await fsp.access(sessionDir); } catch { return []; }
      try {
        const [sessions, titles, meta] = await Promise.all([
          this._sessionListProjectionCache.list(sessionDir),
          this._loadSessionTitlesFor(sessionDir),
          this._readMetaCached(path.join(sessionDir, "session-meta.json")),
        ]);
        const visibleSessions = [];
        for (const s of sessions) {
          const title = this._sessionTitleFromMap(titles, s.path);
          if (title) s.title = title;
          s.agentId = agent.id;
          s.agentName = agent.name;
          if (agent.agentDeleted) {
            s.agentDeleted = true;
            s.readOnlyReason = "agent_deleted";
            s.continuationAvailable = true;
            s.deletedAt = agent.deletedAt || null;
          }
          const sessKey = path.basename(s.path);
          const metaEntry = meta[sessKey];
          const manifest = this._resolveSessionManifestForPath(s.path);
          const runtimeEntry = this._sessionFolderEntry(s.path);
          if (hasSessionPermissionModeFields(runtimeEntry)) {
            s.permissionMode = normalizeSessionPermissionMode(runtimeEntry);
          } else if (hasSessionPermissionModeFields(metaEntry)) {
            s.permissionMode = normalizeSessionPermissionMode(metaEntry);
          } else if (manifest?.permissionModeSnapshot?.mode) {
            s.permissionMode = normalizeSessionPermissionMode(manifest.permissionModeSnapshot.mode);
          }
          s.pinnedAt = typeof manifest?.pinnedAt === "string"
            ? manifest.pinnedAt
            : (typeof metaEntry?.pinnedAt === "string" ? metaEntry.pinnedAt : null);
          s.projectId = typeof metaEntry?.projectId === "string" && metaEntry.projectId.trim()
            ? metaEntry.projectId.trim()
            : null;
          const workspaceMount = normalizeSessionWorkspaceMount(metaEntry);
          s.workspaceMountId = workspaceMount?.mountId || null;
          s.workspaceLabel = workspaceMount?.label || null;
          const runtimePluginMeta = normalizePluginSessionMeta({
            ownerPluginId: runtimeEntry?.ownerPluginId,
            sessionKind: runtimeEntry?.sessionKind,
            sessionVisibility: runtimeEntry?.sessionVisibility,
          });
          const manifestPluginMeta = manifest?.plugin && typeof manifest.plugin === "object"
            ? manifest.plugin
            : null;
          const legacyPluginMeta = metaEntry?.plugin && typeof metaEntry.plugin === "object"
            ? metaEntry.plugin
            : null;
          const pluginMeta = runtimePluginMeta || manifestPluginMeta || legacyPluginMeta;
          s.ownerPluginId = typeof pluginMeta?.ownerPluginId === "string" ? pluginMeta.ownerPluginId : null;
          s.sessionKind = typeof pluginMeta?.kind === "string" ? pluginMeta.kind : null;
          s.visibility = typeof pluginMeta?.visibility === "string" ? pluginMeta.visibility : "public";
          // 读取新格式 model:{id,provider}；老格式（只有 modelId）视为无 provider，
          // 调用方必须接受 modelProvider 可能为 null。
          if (metaEntry?.model && typeof metaEntry.model === "object") {
            s.modelId = metaEntry.model.id || null;
            s.modelProvider = metaEntry.model.provider || null;
          } else {
            s.modelId = metaEntry?.modelId || null;
            s.modelProvider = null;
          }
          if (!sessionMatchesListOptions(s, options)) continue;
          s.sessionId = manifest?.sessionId || this._sessionIdForPath(s.path);
          visibleSessions.push(s);
        }
        return visibleSessions;
      } catch (err) {
        // 显式日志：之前静默吞错会让用户看到「对话框列表为空」却没有任何线索 (#414)
        log.warn(`listSessions: agent="${agent.id}" sessionDir="${sessionDir}" failed: ${err?.message || err}`);
        return [];
      }
    }));
    const allSessions = perAgent.flat();

    const currentPath = this.currentSessionPath;
    const projectedPaths = new Set(allSessions.map((s) => s.path));
    for (const [sessionKey, entry] of this._sessions) {
      const sessionPath = this._sessionPathForEntry(entry, sessionKey);
      if (projectedPaths.has(sessionPath)) continue;
      if (!isActiveSessionPath(sessionPath, this._d.agentsDir)) continue;
      const shouldExpose =
        entry.visibleInSessionList === true
        || entry.session?.isStreaming === true
        || this._hasRuntimeValueForPath(this._prePromptAbortControllers, sessionPath)
        || (sessionPath === currentPath && this._sessionStarted);
      if (!shouldExpose) continue;

      const deletedInfo = this._d.getDeletedAgentInfo?.(entry.agentId);
      const isDeleted = !!deletedInfo || this._d.isAgentDeleted?.(entry.agentId);
      const agent = isDeleted ? deletedInfo : (this._d.getAgentById?.(entry.agentId) || this._d.getAgent());
      const projected = {
        path: sessionPath,
        title: null,
        firstMessage: "",
        modified: new Date(entry.lastTouchedAt || Date.now()),
        // 内存占位投影没有磁盘修订点；revision=null 表示「未知」，
        // 前端 reconcile 对 null 不做盲目重拉。
        revision: null,
        messageCount: 0,
        cwd: entry.session?.sessionManager?.getCwd?.() || "",
        agentId: entry.agentId || this._d.getActiveAgentId(),
        agentName: agent?.agentName || agent?.name || entry.agentId || null,
        modelId: entry.modelId || null,
        modelProvider: entry.modelProvider || null,
        ownerPluginId: entry.ownerPluginId || null,
        sessionKind: entry.sessionKind || null,
        visibility: entry.sessionVisibility || "public",
        workspaceMountId: entry.workspaceMountId || null,
        workspaceLabel: entry.workspaceLabel || null,
        sessionId: entry.sessionId || this._sessionIdForPath(sessionPath),
        pinnedAt: null,
        projectId: null,
        ...(isDeleted ? {
          agentDeleted: true,
          readOnlyReason: "agent_deleted",
          continuationAvailable: true,
          deletedAt: deletedInfo?.deletedAt || null,
        } : {}),
      };
      if (!sessionMatchesListOptions(projected, options)) continue;
      allSessions.push(projected);
      projectedPaths.add(sessionPath);
    }

    allSessions.sort((a, b) => b.modified - a.modified);
    return allSessions;
  }

  async saveSessionTitle(sessionPath: any, title: any) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const titlePath = path.join(sessionDir, "session-titles.json");
    const titles = await this._loadSessionTitlesFor(sessionDir);
    const titleKey = this._sessionTitleKeyForPath(sessionPath);
    if (titleKey !== sessionPath) {
      delete titles[sessionPath];
      delete titles[path.basename(sessionPath)];
    }
    titles[titleKey] = title;
    await fsp.writeFile(titlePath, JSON.stringify(titles, null, 2), "utf-8");
    // 更新缓存
    this._titlesCache.set(sessionDir, { titles: { ...titles }, ts: Date.now() });
  }

  async setSessionPinned(sessionRef: any, pinned: any) {
    const { sessionId, sessionPath, manifest } = this._resolveSessionWriteRef(sessionRef, "setSessionPinned");
    const pinnedAt = pinned ? new Date().toISOString() : null;
    await this.writeSessionMeta(sessionPath, { pinnedAt });
    if (manifest || sessionId) {
      this._sessionManifestStore.setPinnedAt((manifest?.sessionId || sessionId), pinnedAt);
    }
    await this._verifySessionPinnedState(sessionPath, pinnedAt);
    this._emitSessionMetadataUpdated(sessionPath, { pinnedAt });
    return pinnedAt;
  }

  async setSessionPluginMeta(sessionPath: any, patch: any = {}) {
    if (!sessionPath) throw new Error("sessionPath is required");
    const entry = this._getSessionEntryByPath(sessionPath) || null;
    const manifest = this._resolveSessionManifestForPath(sessionPath);
    let current: any = {
      ownerPluginId: manifest?.plugin?.ownerPluginId || entry?.ownerPluginId || null,
      kind: manifest?.plugin?.kind || entry?.sessionKind || null,
      visibility: manifest?.plugin?.visibility || entry?.sessionVisibility || "public",
    };
    try {
      const metaPath = this._sessionMetaPathFor(sessionPath);
      const meta = await this._readMetaCached(metaPath);
      const metaEntry = meta[path.basename(sessionPath)];
      if (metaEntry?.plugin && typeof metaEntry.plugin === "object") {
        current = {
          ownerPluginId: metaEntry.plugin.ownerPluginId || current.ownerPluginId || null,
          kind: metaEntry.plugin.kind || current.kind || null,
          visibility: metaEntry.plugin.visibility || current.visibility || "public",
        };
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`setSessionPluginMeta: meta read failed for ${path.basename(sessionPath)}: ${err.message}`);
      }
    }
    const plugin = normalizePluginSessionMeta({
      ownerPluginId: patch.ownerPluginId ?? current.ownerPluginId,
      sessionKind: patch.kind ?? patch.sessionKind ?? current.kind,
      sessionVisibility: patch.visibility ?? patch.sessionVisibility ?? current.visibility,
    }) || { ownerPluginId: null, kind: null, visibility: "public" };
    await this.writeSessionMeta(sessionPath, { plugin });
    if (manifest) {
      this._sessionManifestStore.setPlugin(manifest.sessionId, plugin);
    }
    if (entry) {
      entry.ownerPluginId = plugin.ownerPluginId || null;
      entry.sessionKind = plugin.kind || null;
      entry.sessionVisibility = plugin.visibility || "public";
    }
    this._emitSessionMetadataUpdated(sessionPath, { plugin });
    return plugin;
  }

  async _verifySessionPinnedState(sessionPath: any, expectedPinnedAt: any) {
    const metaPath = this._sessionMetaPathFor(sessionPath);
    const sessKey = path.basename(sessionPath);
    let meta = {};
    try {
      meta = await this._readMetaCached(metaPath);
    } catch (err) {
      if (expectedPinnedAt === null && err.code === "ENOENT") return;
      throw new Error(`setSessionPinned: verify failed for ${sessKey}: ${err.message}`);
    }
    const actual = meta[sessKey]?.pinnedAt ?? null;
    if (actual !== expectedPinnedAt) {
      throw new Error(`setSessionPinned: expected pinnedAt=${expectedPinnedAt ?? "null"} for ${sessKey}, got ${actual ?? "null"}`);
    }
  }

  /**
   * 清除指定 session 在 session-titles.json 的标题条目。
   * 供归档永久删除 / cleanup 使用，避免 titles.json 孤儿残留。
   * 文件不存在或 key 不在时为 no-op。
   */
  async clearSessionTitle(sessionPath: any) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const titlePath = path.join(sessionDir, "session-titles.json");
    let raw;
    try {
      raw = await fsp.readFile(titlePath, "utf-8");
    } catch {
      return; // titles.json 不存在
    }
    let titles;
    try { titles = JSON.parse(raw); } catch { return; }
    const keys = [
      this._sessionTitleKeyForPath(sessionPath),
      sessionPath,
      path.basename(sessionPath),
    ].filter(Boolean);
    let changed = false;
    for (const key of [...new Set(keys)]) {
      if (Object.prototype.hasOwnProperty.call(titles, key)) {
        delete titles[key];
        changed = true;
      }
    }
    if (!changed) return;
    await fsp.writeFile(titlePath, JSON.stringify(titles, null, 2), "utf-8");
    this._titlesCache.set(sessionDir, { titles: { ...titles }, ts: Date.now() });
  }

  /**
   * 列出所有 agent 的已归档 session（`<agentDir>/sessions/archived/*.jsonl`）。
   * title 的存储 key 仍是活跃路径——从 archived 路径反推活跃路径再查 titles.json。
   */
  async listArchivedSessions() {
    const agents = this._d.listAgents();
    const perAgent = await Promise.all(agents.map(async (agent) => {
      const sessionDir = path.join(this._d.agentsDir, agent.id, "sessions");
      const archDir = path.join(sessionDir, "archived");
      let files;
      try { files = await fsp.readdir(archDir); } catch { return []; }
      const titles = await this._loadSessionTitlesFor(sessionDir).catch(() => ({}));
      const rows = await Promise.all(files
        .filter((f) => f.endsWith(".jsonl"))
        .map(async (f) => {
          const full = path.join(archDir, f);
          try {
            const stat = await fsp.stat(full);
            const activeKey = path.join(sessionDir, f);
            return {
              path: full,
              title: this._sessionTitleFromMap(titles, full, [activeKey]) || null,
              archivedAt: stat.mtime.toISOString(),
              sizeBytes: stat.size,
              agentId: agent.id,
              agentName: agent.name,
            };
          } catch {
            return null;
          }
        }));
      return rows.filter(Boolean);
    }));
    const all = perAgent.flat();
    all.sort((a, b) => new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime());
    return all;
  }

  async getTitlesForPaths(paths: any[]) {
    const titles = {};
    for (const p of paths) titles[p] = null;

    const byDir = new Map();
    for (const p of paths) {
      const dir = path.dirname(p);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(p);
    }

    for (const [dir, sessionPaths] of byDir) {
      try {
        const dirTitles = await this._loadSessionTitlesFor(dir);
        for (const sp of sessionPaths) {
          const title = this._sessionTitleFromMap(dirTitles, sp);
          if (title) titles[sp] = title;
        }
      } catch {
        // titles 可选：某个目录的 session-titles.json 缺失/损坏时，该目录下路径保持预设的 null。
      }
    }

    return titles;
  }

  async _loadSessionTitlesFor(sessionDir: any) {
    const cached = this._titlesCache.get(sessionDir);
    if (cached && Date.now() - cached.ts < SessionCoordinator._TITLES_TTL) {
      return { ...cached.titles };
    }
    try {
      const raw = await fsp.readFile(path.join(sessionDir, "session-titles.json"), "utf-8");
      const titles = JSON.parse(raw);
      this._titlesCache.set(sessionDir, { titles, ts: Date.now() });
      return { ...titles };
    } catch {
      this._titlesCache.set(sessionDir, { titles: {}, ts: Date.now() });
      return {};
    }
  }

  /** 异步读取 session-meta.json，带 TTL 缓存 */
  async _readMetaCached(metaPath: any) {
    const cached = this._metaCache.get(metaPath);
    if (cached && Date.now() - cached.ts < SessionCoordinator._TITLES_TTL) {
      return cached.data;
    }
    try {
      const stat = await fsp.stat(metaPath);
      if (stat.size > SESSION_META_INDEX_MAX_BYTES) {
        const compacted = await this._compactOversizedSessionMeta(metaPath);
        const data = await this._hydrateSessionMetaPayloads(metaPath, compacted);
        this._metaCache.set(metaPath, { data, ts: Date.now() });
        return data;
      }
      const raw = await fsp.readFile(metaPath, "utf-8");
      const data = await this._hydrateSessionMetaPayloads(metaPath, JSON.parse(raw));
      this._metaCache.set(metaPath, { data, ts: Date.now() });
      return data;
    } catch {
      return {};
    }
  }

  async _readSessionPromptSnapshot(agent: any, sessionPath: any) {
    try {
      const metaPath = path.join(agent.sessionDir, "session-meta.json");
      const meta = await this._readMetaCached(metaPath);
      return normalizeSessionPromptSnapshot(meta[path.basename(sessionPath)]?.promptSnapshot);
    } catch {
      return null;
    }
  }

  _resolvePromptModelFromSessionManager(sessionMgr: any, models: any) {
    try {
      const ref = sessionMgr?.buildSessionContext?.()?.model;
      if (!ref?.provider || !ref?.modelId) return null;
      return findModel(models.availableModels, ref.modelId, ref.provider);
    } catch (err) {
      log.warn(`restore prompt patch model resolve failed: ${err.message}`);
      return null;
    }
  }

  _getFinalSystemPrompt(session: any) {
    if (typeof session?._baseSystemPrompt === "string") {
      return session._baseSystemPrompt;
    }
    if (typeof session?.agent?.state?.systemPrompt === "string") {
      return session.agent.state.systemPrompt;
    }
    return null;
  }

  _buildCachePrefixContract(entry: any, { model = null, context = null }: any = {}) {
    const session = entry?.session;
    const state = session?.agent?.state;
    const hasContextPrompt = context && Object.prototype.hasOwnProperty.call(context, "systemPrompt");
    return buildLlmContextCachePrefixContract({
      model: model || session?.model || state?.model || null,
      systemPrompt: hasContextPrompt ? context.systemPrompt : (this._getFinalSystemPrompt(session) ?? ""),
      tools: Array.isArray(context?.tools) ? context.tools : (Array.isArray(state?.tools) ? state.tools : []),
    });
  }

  _renewCachePrefixContract(sessionPath: any, entry: any, reason: any, options: any = {}) {
    if (!entry?.session) return null;
    const contract = this._buildCachePrefixContract(entry, options);
    entry.cachePrefixContract = contract;
    entry.cachePrefixContractRenewReason = reason;
    entry.cachePrefixContractRenewedAt = Date.now();
    entry.cachePrefixContractRequestCount = 0;

    if (cacheContractDebugEnabled()) {
      log.log(`cache_contract_renew ${JSON.stringify({
        session: sessionPath ? path.basename(sessionPath) : null,
        reason,
        contract: summarizeCachePrefixContract(contract),
      })}`);
    }
    return contract;
  }

  _assertCachePrefixContract(sessionPath: any, entry: any, { model = null, context = null }: any = {}) {
    if (!entry?.session) return null;
    const expected = entry.cachePrefixContract
      || this._renewCachePrefixContract(sessionPath, entry, "late_init", { model, context });
    const actual = this._buildCachePrefixContract(entry, { model, context });
    const diffs = diffCachePrefixContracts(expected, actual);
    if (diffs.length > 0) {
      const record = {
        session: sessionPath ? path.basename(sessionPath) : null,
        renewReason: entry.cachePrefixContractRenewReason || null,
        requestCount: entry.cachePrefixContractRequestCount || 0,
        diffs,
        expected: summarizeCachePrefixContract(expected),
        actual: summarizeCachePrefixContract(actual),
      };
      log.error(`cache_contract_violation ${JSON.stringify(record)}`);
      try {
        this._d.emitEvent?.({
          type: "cache_contract_violation",
          sessionPath,
          diffs,
          expected: summarizeCachePrefixContract(expected),
          actual: summarizeCachePrefixContract(actual),
        }, sessionPath);
      } catch {
        // The provider request must still fail even if UI event delivery fails.
      }
      throw new Error(`Cache prefix contract violated: ${diffs.map((d) => d.field).join(", ")}`);
    }

    entry.cachePrefixContractRequestCount = (entry.cachePrefixContractRequestCount || 0) + 1;
    if (cacheContractDebugEnabled()) {
      log.log(`cache_contract_check ${JSON.stringify({
        session: sessionPath ? path.basename(sessionPath) : null,
        requestCount: entry.cachePrefixContractRequestCount,
        contract: summarizeCachePrefixContract(actual),
      })}`);
    }
    return actual;
  }

  _installCachePrefixGuard(sessionPath: any, entry: any) {
    const agent = entry?.session?.agent;
    if (!agent || typeof agent.streamFn !== "function" || entry.cachePrefixGuardInstalled) return;
    const originalStreamFn = agent.streamFn;
    entry.cachePrefixGuardInstalled = true;
    entry.cachePrefixOriginalStreamFn = originalStreamFn;
    agent.streamFn = async (model, context, options) => {
      this._assertCachePrefixContract(sessionPath, entry, { model, context });
      return originalStreamFn.call(agent, model, context, options);
    };
  }

  _applyFinalPromptSnapshot(session: any, finalSystemPrompt: any) {
    if (typeof finalSystemPrompt !== "string") return;
    try {
      session._baseSystemPrompt = finalSystemPrompt;
    } catch {
      // session 对象理论上可能 frozen 或 _baseSystemPrompt 带抛错 setter；
      // 容错即可，下面 agent.state.systemPrompt 仍独立尝试写入。
    }
    if (session?.agent?.state && typeof session.agent.state === "object") {
      session.agent.state.systemPrompt = finalSystemPrompt;
    }
  }

  /** session-meta 写入后清除对应缓存 */
  invalidateMetaCache(metaPath: any) {
    this._metaCache.delete(metaPath);
  }

  /**
   * Single entry point for all session-meta.json writes. Both the memory-toggle
   * path (persistSessionMeta) and the tool-snapshot path (createSession) go
   * through this method. Writes are serialized via a promise chain to prevent
   * RMW races where two concurrent writers would each read stale meta and
   * clobber the other's fields on write-back.
   *
   * @param {string} sessionPath - absolute path to the session .jsonl file
   * @param {object} partial - fields to merge into meta[basename(sessionPath)]
   * @returns {Promise<void>} Resolves after this write (and any writes queued
   *   before it) has been attempted. I/O failures are logged and swallowed
   *   internally — the returned promise never rejects.
   */
  writeSessionMeta(sessionPath: any, partial: any) {
    const next = () => this._doWriteSessionMeta(sessionPath, partial);
    // Chain on both success and failure branches so a failed write does not
    // poison the queue — the next write still runs.
    this._metaWriteQueue = this._metaWriteQueue.then(next, next);
    return this._metaWriteQueue;
  }

  async _doWriteSessionMeta(sessionPath: any, partial: any) {
    const metaPath = this._sessionMetaPathFor(sessionPath);
    const sessKey = path.basename(sessionPath);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const meta = await this._readSessionMetaIndexForWrite(metaPath);
        meta[sessKey] = {
          ...meta[sessKey],
          ...partial,
        };
        // model is owned by PI SDK via session JSONL — keep session-meta clean
        delete meta[sessKey].model;
        delete meta[sessKey].modelId;
        meta[sessKey] = await this._externalizeSessionMetaPayloads(metaPath, sessKey, meta[sessKey]);
        await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
        this.invalidateMetaCache(metaPath);
        this._writeSessionCapabilitySnapshot(sessionPath, partial);
        return;
      } catch (err) {
        if (attempt === 0) {
          // 首次写失败可能因父目录缺失：best-effort 补建后由下一轮 attempt 重试 writeFile。
          // mkdir 自身失败（如目录已存在）不影响重试，吞掉即可。
          try { await fsp.mkdir(path.dirname(metaPath), { recursive: true }); } catch {}
        } else {
          log.warn(`writeSessionMeta failed for ${sessKey}: ${err.message}`);
        }
      }
    }
  }

  _isSessionMetaPayloadRef(value: any, field?: any) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (value.kind !== "session-meta-payload") return false;
    if (field && value.field !== field) return false;
    return typeof value.path === "string" && value.path.length > 0;
  }

  _sessionMetaPayloadRelativePath(sessKey: any, field: any) {
    return path.join(SESSION_META_PAYLOAD_DIR, `${encodeURIComponent(sessKey)}.${field}.json`);
  }

  _sessionMetaPayloadAbsolutePath(metaPath: any, refPath: any) {
    return path.join(path.dirname(metaPath), refPath);
  }

  async _readSessionMetaIndexForWrite(metaPath: any) {
    try {
      const stat = await fsp.stat(metaPath);
      if (stat.size > SESSION_META_INDEX_MAX_BYTES) {
        return await this._compactOversizedSessionMeta(metaPath);
      }
    } catch (err) {
      if (err?.code !== "ENOENT") {
        log.warn(`session-meta stat failed for write: ${err.message}`);
      }
      return {};
    }
    try {
      return JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    } catch {
      return {};
    }
  }

  async _quarantineOversizedSessionMeta(metaPath: any) {
    try {
      const backupPath = path.join(
        path.dirname(metaPath),
        `session-meta.oversized.${Date.now()}.json`,
      );
      await fsp.rename(metaPath, backupPath);
      this.invalidateMetaCache(metaPath);
      log.warn(`oversized session-meta quarantined: ${backupPath}`);
    } catch (err) {
      if (err?.code !== "ENOENT") {
        log.warn(`oversized session-meta quarantine failed: ${err.message}`);
      }
    }
  }

  async _compactOversizedSessionMeta(metaPath: any) {
    let data;
    try {
      data = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    } catch {
      await this._quarantineOversizedSessionMeta(metaPath);
      return {};
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      await this._quarantineOversizedSessionMeta(metaPath);
      return {};
    }
    const compacted: any = {};
    for (const [sessKey, entry] of Object.entries(data)) {
      compacted[sessKey] = await this._externalizeSessionMetaPayloads(metaPath, sessKey, entry);
    }
    await fsp.writeFile(metaPath, JSON.stringify(compacted, null, 2));
    this.invalidateMetaCache(metaPath);
    log.warn(`oversized session-meta compacted with payload sidecars: ${metaPath}`);
    return compacted;
  }

  async _externalizeSessionMetaPayloads(metaPath: any, sessKey: any, entry: any) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const next = { ...entry };
    for (const field of SESSION_META_PAYLOAD_FIELDS) {
      const value = next[field];
      if (value === undefined || this._isSessionMetaPayloadRef(value, field)) continue;
      let encoded = "";
      try {
        encoded = JSON.stringify(value);
      } catch {
        continue;
      }
      if (Buffer.byteLength(encoded, "utf-8") <= SESSION_META_PAYLOAD_INLINE_LIMIT_BYTES) continue;
      const relPath = this._sessionMetaPayloadRelativePath(sessKey, field);
      const absPath = this._sessionMetaPayloadAbsolutePath(metaPath, relPath);
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      await fsp.writeFile(absPath, encoded, "utf-8");
      next[field] = {
        kind: "session-meta-payload",
        version: 1,
        field,
        path: relPath,
      };
    }
    return next;
  }

  async _hydrateSessionMetaPayloads(metaPath: any, data: any) {
    if (!data || typeof data !== "object") return {};
    const hydrated = {};
    for (const [sessKey, entry] of Object.entries(data)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        hydrated[sessKey] = entry;
        continue;
      }
      const next = { ...(entry as any) };
      for (const field of SESSION_META_PAYLOAD_FIELDS) {
        const ref = next[field];
        if (!this._isSessionMetaPayloadRef(ref, field)) continue;
        try {
          const raw = await fsp.readFile(this._sessionMetaPayloadAbsolutePath(metaPath, ref.path), "utf-8");
          next[field] = JSON.parse(raw);
        } catch (err) {
          log.warn(`session-meta payload read failed for ${sessKey}/${field}: ${err.message}`);
          delete next[field];
        }
      }
      hydrated[sessKey] = next;
    }
    return hydrated;
  }

  _sessionMetaPathFor(sessionPath: any) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    return path.join(sessionDir, "session-meta.json");
  }

  _isPromotableActivitySession(agent: any, sessionPath: any) {
    return !!agent?.agentDir && isPathInsideDir(path.join(agent.agentDir, "activity"), sessionPath);
  }

  async _writePromotableActivitySessionMeta(agent: any, activitySessionPath: any, partial: any) {
    if (!agent?.sessionDir || !activitySessionPath) return;
    const promotedSessionPath = path.join(agent.sessionDir, path.basename(activitySessionPath));
    await this.writeSessionMeta(promotedSessionPath, partial);
  }

  async _ensurePromotedActivitySessionToolMeta(agent: any, sessionPath: any) {
    if (!agent?.sessionDir || !sessionPath) return;
    const sessionFileName = path.basename(sessionPath);
    const metaPath = path.join(agent.sessionDir, "session-meta.json");
    try {
      const meta = await this._readMetaCached(metaPath);
      if (Array.isArray(meta?.[sessionFileName]?.toolNames)) return;
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`promoteActivitySession meta read failed: ${err.message}`);
      }
    }

    let cwd = this._d.getHomeCwd?.(agent.id) || process.cwd();
    try {
      const manager = SessionManager.open(sessionPath, agent.sessionDir);
      cwd = manager?.getCwd?.() || cwd;
    } catch (err) {
      log.warn(`promoteActivitySession could not open session for cwd: ${err.message}`);
    }

    const models = this._d.getModels?.() || {};
    const preferredRef = agent.config?.models?.chat;
    let model = models.defaultModel || null;
    if (preferredRef?.id && preferredRef?.provider && Array.isArray(models.availableModels)) {
      model = findModel(models.availableModels, preferredRef.id, preferredRef.provider) || model;
    }
    let execModel = model;
    if (model && typeof models.resolveExecutionModel === "function") {
      execModel = models.resolveExecutionModel(model);
    }
    const toolsSnapshot = typeof agent.getToolsSnapshot === "function"
      ? agent.getToolsSnapshot({
        forceMemoryEnabled: agent.memoryMasterEnabled !== false,
        model: execModel,
        ...(typeof agent.experienceEnabled === "boolean"
          ? { forceExperienceEnabled: agent.experienceEnabled === true }
          : {}),
      })
      : agent.tools;
    const workspaceScope = normalizeWorkspaceScope({ primaryCwd: cwd, workspaceFolders: [] });
    const folderScope = normalizeSessionFolderScope({
      primaryCwd: cwd,
      workspaceFolders: workspaceScope.workspaceFolders,
      authorizedFolders: [],
    });
    const built = this._d.buildTools?.(cwd, toolsSnapshot, {
      agentDir: agent.agentDir,
      workspace: cwd,
      workspaceFolders: workspaceScope.workspaceFolders,
      authorizedFolders: folderScope.authorizedFolders,
      getAuthorizedFolders: () => folderScope.authorizedFolders,
      getSessionPath: () => sessionPath,
      fileReadSessionPaths: [],
      getPermissionMode: () => SESSION_PERMISSION_MODES.OPERATE,
      permissionContext: { isSubagent: false },
    }) || { tools: [], customTools: [] };
    const toolNames = uniqueToolNames(toolNamesFromObjects([
      ...(built.tools || []),
      ...(built.customTools || []),
    ]));
    await this.writeSessionMeta(sessionPath, {
      memoryEnabled: agent.memoryMasterEnabled !== false,
      experienceEnabled: agent.experienceEnabled === true,
      workspaceFolders: workspaceScope.workspaceFolders,
      authorizedFolders: folderScope.authorizedFolders,
      permissionMode: SESSION_PERMISSION_MODES.OPERATE,
      accessMode: legacyAccessModeFromPermissionMode(SESSION_PERMISSION_MODES.OPERATE),
      planMode: false,
      toolNames,
    });
  }

  // ── Session Context ──

  createSessionContext() {
    const models = this._d.getModels();
    const skills = this._d.getSkills();
    return {
      authStorage:    models.authStorage,
      modelRegistry:  models.modelRegistry,
      resourceLoader: this._d.getResourceLoader(),
      allSkills:      skills.allSkills,
      getSkillsForAgent: (ag) => skills.getSkillsForAgent(ag),
      buildTools:     (cwd, customTools, opts) => this._d.buildTools(cwd, customTools, opts),
      resolveModel:   (agentConfig) => {
        // migration #5 后 models.chat 必为 {id, provider}；半成品或字符串视为未配置
        const chatRef = agentConfig?.models?.chat;
        const ref = (typeof chatRef === "object" && chatRef?.id && chatRef?.provider) ? chatRef : null;
        if (!ref) {
          if (models.defaultModel) {
            log.log(`[resolveModel] agentConfig 未指定完整 models.chat，回退到默认模型 ${models.defaultModel.provider}/${models.defaultModel.id}`);
            return models.defaultModel;
          }
          log.error(`[resolveModel] agentConfig 未指定 models.chat，也没有默认模型`);
          throw new Error(t("error.resolveModelNoChatModel"));
        }
        const found = findModel(models.availableModels, ref.id, ref.provider);
        if (!found) {
          // 模型在可用列表中找不到，尝试回退到默认模型
          if (models.defaultModel) {
            log.log(`[resolveModel] 模型 "${ref.provider}/${ref.id}" 不在可用列表中，回退到默认模型 ${models.defaultModel.provider}/${models.defaultModel.id}`);
            return models.defaultModel;
          }
          const available = models.availableModels.map(m => `${m.provider}/${m.id}`).join(", ");
          log.error(`[resolveModel] 找不到模型 "${ref.provider}/${ref.id}"。availableModels=[${available}]`);
          throw new Error(t("error.resolveModelNotAvailable", { id: `${ref.provider}/${ref.id}` }));
        }
        return found;
      },
    };
  }

  async promoteActivitySession(activitySessionFile: any, agentId: any) {
    const agent = agentId ? this._d.getAgentById(agentId) : this._d.getAgent();
    if (!agent) return null;
    const oldPath = path.join(agent.agentDir, "activity", activitySessionFile);
    if (!fs.existsSync(oldPath)) return null;

    const newPath = path.join(agent.sessionDir, activitySessionFile);
    try {
      fs.mkdirSync(agent.sessionDir, { recursive: true });
      fs.renameSync(oldPath, newPath);
      try {
        await this._ensurePromotedActivitySessionToolMeta(agent, newPath);
      } catch (err) {
        log.warn(`promoteActivitySession meta backfill failed: ${err.message}`);
      }
      agent._memoryTicker?.notifyPromoted(newPath);
      log.log(`promoted activity session: ${activitySessionFile} (agent=${agent.id})`);
      return newPath;
    } catch (err) {
      log.error(`promoteActivitySession failed: ${err.message}`);
      return null;
    }
  }

  // ── Isolated Execution ──

  /**
   * 隔离执行：在独立 session 中执行 prompt（原子操作）。
   *
   * opts:
   *   agentId, cwd, model, persist (string 目录路径 | falsy),
   *   toolFilter, builtinFilter, extraCustomTools, signal,
   *   fileReadSessionPaths (string[] = parent session SessionFile scopes inherited as read-only),
   *   subagentContext (true = 走 subagent 专用 prompt：跳过记忆三段和团队名单),
   *   allowHumanApproval (false = 后台执行遇到人工确认请求时快速返回未批准),
   *   emitEvents (true 时将 session 事件转发到 EventBus),
   *   onSessionReady (sessionPath => void) 回调，session 创建后、prompt 执行前触发
   */
  async executeIsolated(prompt: any, opts: any = {}) {
    let targetAgent = opts.agentId ? this._d.getAgentById(opts.agentId) : this._d.getAgent();
    if (!targetAgent) throw new Error(t("error.agentNotInitialized", { id: opts.agentId }));

    // abort signal：提前中止检查
    if (opts.signal?.aborted) {
      return { sessionPath: null, replyText: "", error: "aborted" };
    }
    if (typeof this._d.ensureAgentRuntime === "function") {
      const ensured = await this._d.ensureAgentRuntime(targetAgent.id, {
        priority: opts.agentId ? "background" : "foreground",
        reason: "executeIsolated",
      });
      if (ensured) targetAgent = ensured;
    }

    const bm = BrowserManager.instance();
    const wasBrowserRunning = bm.hasAnyRunning;
    const opId = `iso_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this._headlessOps.add(opId);
    if (this._headlessOps.size === 1) bm.setHeadless(true);
    let tempSessionMgr;
    let childSessionPath = null;
    // resume 复用的持久实例 session：cleanup 各路径（含 early_abort 的无条件 cleanupTempSession）
    // 一律不动，否则被 abort 一次实例文件就蒸发（撞底线#3）。
    let isResumedSession = false;
    const cleanupTempSession = () => {
      if (isResumedSession) return;
      const sp = tempSessionMgr?.getSessionFile?.();
      if (sp) {
        // 临时 session 文件清理 best-effort：删不掉（如已被删/权限）不应让 isolated 执行失败。
        try { fs.unlinkSync(sp); } catch {}
      }
    };
    try {
      const sessionDir = opts.persist || path.join(targetAgent.agentDir, '.ephemeral');
      fs.mkdirSync(sessionDir, { recursive: true });

      const execCwd = opts.cwd || this._d.getHomeCwd(targetAgent.id) || process.cwd();
      const workspaceSourceSessionPath = typeof opts.parentSessionPath === "string" && opts.parentSessionPath.trim()
        ? opts.parentSessionPath
        : this.currentSessionPath;
      const inheritedWorkspaceFolders = Array.isArray(opts.workspaceFolders)
        ? opts.workspaceFolders
        : this.getSessionWorkspaceFolders(workspaceSourceSessionPath);
      const inheritedAuthorizedFolders = Array.isArray(opts.authorizedFolders)
        ? opts.authorizedFolders
        : this.getSessionAuthorizedFolders(workspaceSourceSessionPath);
      const execWorkspaceScope = normalizeWorkspaceScope({
        primaryCwd: execCwd,
        workspaceFolders: inheritedWorkspaceFolders,
      });
      const execFolderScope = normalizeSessionFolderScope({
        primaryCwd: execCwd,
        workspaceFolders: execWorkspaceScope.workspaceFolders,
        authorizedFolders: inheritedAuthorizedFolders,
      });
      const fileReadSessionPaths = Array.isArray(opts.fileReadSessionPaths)
        ? opts.fileReadSessionPaths.filter((sp) => typeof sp === "string" && sp.trim())
        : [];
      const models = this._d.getModels();
      // migration #5 之后 models.chat 必为 {id, provider}；旧裸字符串/缺 provider 对象视为未配置
      const agentPreferredRef = targetAgent.config?.models?.chat;
      const preferredRef = opts.model ? null
        : ((typeof agentPreferredRef === "object" && agentPreferredRef?.id && agentPreferredRef?.provider)
            ? agentPreferredRef : null);
      let resolvedModel = opts.model;
      if (!resolvedModel) {
        if (preferredRef) {
          resolvedModel = findModel(models.availableModels, preferredRef.id, preferredRef.provider);
        }
        if (!resolvedModel) {
          resolvedModel = models.defaultModel;
        }
        if (!resolvedModel) {
          log.error(`[executeIsolated] agent "${targetAgent.agentName}" 未指定完整 models.chat，也没有可用的默认模型`);
          throw new Error(t("error.executeIsolatedNoModel", { name: targetAgent.agentName }));
        }
        if (preferredRef && resolvedModel.id !== preferredRef.id) {
          log.log(`[executeIsolated] 模型 "${preferredRef.provider}/${preferredRef.id}" 不可用，fallback → ${resolvedModel.provider}/${resolvedModel.id}`);
        }
      }
      const execModel = models.resolveExecutionModel(resolvedModel);
      // resume 分支：opts.resumeSessionPath 指向已有持久实例 session（subagent 复用续接）。
      // 照前台 restore / bridge owner 范式：先修 #1285 孤儿 toolResult（必须早于 open），再 open；
      // 文件不存在则退回新建（禁止静默：调用方传了 resumeSessionPath 但文件没了，按新建处理并由上层感知）。
      const resumeExisting = typeof opts.resumeSessionPath === "string"
        && opts.resumeSessionPath.trim()
        && fs.existsSync(opts.resumeSessionPath);
      if (resumeExisting) {
        this._repairOversizedSessionHistory(opts.resumeSessionPath);
        this._repairOrphanToolHistory(opts.resumeSessionPath);
        this._repairInlineMediaHistory(opts.resumeSessionPath);
        tempSessionMgr = SessionManager.open(opts.resumeSessionPath, sessionDir);
        isResumedSession = true;
      } else {
        tempSessionMgr = SessionManager.create(execCwd, sessionDir);
      }
      const execPermissionMode = normalizeSessionPermissionMode({
        permissionMode: opts.permissionMode || SESSION_PERMISSION_MODES.OPERATE,
      });
      const targetAgentToolsSnapshot = typeof targetAgent.getToolsSnapshot === "function"
        ? targetAgent.getToolsSnapshot({
          forceMemoryEnabled: targetAgent.memoryMasterEnabled !== false,
          model: execModel,
          ...(typeof targetAgent.experienceEnabled === "boolean"
            ? { forceExperienceEnabled: targetAgent.experienceEnabled === true }
            : {}),
        })
        : targetAgent.tools;
      const { tools: allBuiltinTools, customTools: allCustomTools } = this._d.buildTools(
        execCwd,
        targetAgentToolsSnapshot,
        {
          agentDir: targetAgent.agentDir,
          workspace: execCwd,
          workspaceFolders: execWorkspaceScope.workspaceFolders,
          authorizedFolders: execFolderScope.authorizedFolders,
          getAuthorizedFolders: () => execFolderScope.authorizedFolders,
          getSessionPath: () => tempSessionMgr?.getSessionFile?.() || null,
          fileReadSessionPaths,
          getPermissionMode: () => execPermissionMode,
          permissionContext: { isSubagent: !!opts.subagentContext },
          allowHumanApproval: opts.allowHumanApproval !== false,
          ...(opts.bridgeContext ? { bridgeContext: opts.bridgeContext } : {}),
          ...(opts.notificationContext ? { notificationContext: opts.notificationContext } : {}),
        },
      );

      const patrolAllowed = opts.toolFilter
        || targetAgent.config?.desk?.patrol_tools
        || PATROL_TOOLS_DEFAULT;
      // heartbeat 巡检中屏蔽自动化工具：agent 在巡检里创建一个 3 分钟任务
      // 会让该任务持续触发后续巡检/活动，看起来像「巡检间隔被破坏」(#398)
      const isHeartbeat = opts.activityType === "heartbeat";
      const heartbeatBlocked = new Set(isHeartbeat ? ["automation", "cron"] : []);
      const actCustomTools = patrolAllowed === "*"
        ? allCustomTools.filter(t => !heartbeatBlocked.has(t.name))
        : allCustomTools.filter(t => new Set(patrolAllowed).has(t.name) && !heartbeatBlocked.has(t.name));
      const extraCustomTools = Array.isArray(opts.extraCustomTools)
        ? opts.extraCustomTools.filter(t => t && typeof t.name === "string" && t.name.trim())
        : [];

      const actTools = opts.builtinFilter
        ? allBuiltinTools.filter(t => opts.builtinFilter.includes(t.name))
        : allBuiltinTools;

      const agent = this._d.getAgent();
      const skills = this._d.getSkills();
      const resourceLoader = this._d.getResourceLoader();
      let isolatedPrompt;
      if (opts.subagentContext) {
        // Subagent 专用 prompt：跳过长期记忆、pinned、记忆规则、团队 agent 名单。
        // 不走 cached systemPrompt getter，因为它返回"完整 prompt"的缓存。
        isolatedPrompt = targetAgent.buildSystemPrompt({ forSubagent: true, cwdOverride: execCwd });
      } else {
        // 非 session 路径（巡检/cron 等）统一用 master 版本的 systemPrompt cache。
        // per-session 开关只管该 session 自己的对话窗口，不影响这里。
        isolatedPrompt = targetAgent.systemPrompt;
      }
      const execResourceLoaderProps: any = {
        getSystemPrompt: { value: () => isolatedPrompt },
        getAppendSystemPrompt: {
          value: () => {
            const base = resourceLoader.getAppendSystemPrompt?.() || [];
            const workspacePrompt = formatWorkspaceScopePrompt({
              primaryCwd: execWorkspaceScope.primaryCwd,
              workspaceFolders: execWorkspaceScope.workspaceFolders,
              locale: targetAgent.config?.locale || getLocale(),
            });
            return workspacePrompt ? [...base, workspacePrompt] : base;
          },
        },
      };
      if (targetAgent !== agent) {
        execResourceLoaderProps.getSkills = { value: () => skills.getSkillsForAgent(targetAgent) };
      }
      const execResourceLoader = Object.create(resourceLoader, execResourceLoaderProps);
      const execThinkingLevel = resolveThinkingLevelForModel(
        this._d.getPrefs().getThinkingLevel(),
        execModel,
        (level) => models.resolveThinkingLevel(level),
      );

      const { session } = await createAgentSession({
        cwd: execCwd,
        sessionManager: tempSessionMgr,
        settingsManager: this._createSettings(execModel),
        authStorage: models.authStorage,
        modelRegistry: models.modelRegistry,
        model: execModel,
        thinkingLevel: execThinkingLevel,
        resourceLoader: execResourceLoader,
        tools: actTools,
        customTools: [...actCustomTools, ...extraCustomTools],
      });

      childSessionPath = session.sessionManager?.getSessionFile?.() || null;
      if (!isResumedSession && childSessionPath && this._isPromotableActivitySession(targetAgent, childSessionPath)) {
        const promotedSessionPath = path.join(targetAgent.sessionDir, path.basename(childSessionPath));
        const isolatedSkillsResult = targetAgent !== agent && skills?.getSkillsForAgent
          ? freezeSkillsResult(skills.getSkillsForAgent(targetAgent))
          : freezeSkillsResult(resourceLoader.getSkills?.());
        const promptSnapshot = {
          version: SESSION_PROMPT_SNAPSHOT_VERSION,
          systemPrompt: isolatedPrompt,
          appendSystemPrompt: normalizeStringArray(execResourceLoader.getAppendSystemPrompt?.()),
          skillsResult: freezeSkillsResult(await snapshotSkillsForSession(isolatedSkillsResult, promotedSessionPath)),
          agentsFilesResult: freezeAgentsFilesResult(resourceLoader.getAgentsFiles?.()),
          ...(this._getFinalSystemPrompt(session)
            ? { finalSystemPrompt: this._getFinalSystemPrompt(session) }
            : {}),
        };
        await this._writePromotableActivitySessionMeta(targetAgent, childSessionPath, {
          memoryEnabled: targetAgent.memoryMasterEnabled !== false,
          experienceEnabled: targetAgent.experienceEnabled === true,
          workspaceFolders: execWorkspaceScope.workspaceFolders,
          authorizedFolders: execFolderScope.authorizedFolders,
          permissionMode: execPermissionMode,
          accessMode: legacyAccessModeFromPermissionMode(execPermissionMode),
          planMode: isReadOnlyPermissionMode(execPermissionMode),
          thinkingLevel: execThinkingLevel,
          promptSnapshot,
          toolNames: uniqueToolNames(toolNamesFromObjects([
            ...(actTools || []),
            ...(actCustomTools || []),
            ...(extraCustomTools || []),
          ])),
        });
      }

      const readyChildSessionId = childSessionPath ? this._sessionIdForPath(childSessionPath) : null;
      // 通知调用方 session 已就绪（subagent 用 path 后补 streamKey；workflow 额外消费稳定 sessionId）
      try {
        opts.onSessionReady?.(childSessionPath, {
          ...(readyChildSessionId ? { sessionId: readyChildSessionId } : {}),
          sessionPath: childSessionPath,
        });
      } catch (err) { log.warn(`isolated onSessionReady callback failed: ${err?.message}`); }

      let replyText = "";
      let finalAssistantText = "";
      let finalStopReason = null;
      let finalErrorMessage = null;
      const sessionFiles = [];
      const toolErrors = [];
      const unsub = session.subscribe((event) => {
        const parentSessionPath = typeof opts.parentSessionPath === "string" && opts.parentSessionPath.trim()
          ? opts.parentSessionPath
          : null;
        const parentSessionId = typeof opts.parentSessionId === "string" && opts.parentSessionId.trim()
          ? opts.parentSessionId.trim()
          : (parentSessionPath ? this._sessionIdForPath(parentSessionPath) : null);
        const childSessionId = childSessionPath ? this._sessionIdForPath(childSessionPath) : null;
        recordAssistantUsage({
          ledger: this._d.getUsageLedger?.(),
          event,
          sessionPath: childSessionPath,
          sessionId: childSessionId,
          agentId: targetAgent.id,
          model: execModel,
          resolveModel: (ref) => findModel(this._d.getModels?.()?.availableModels, ref.id, ref.provider),
          source: {
            subsystem: opts.subagentContext ? "subagent" : "automation",
            operation: "run",
            surface: opts.subagentContext ? "desktop" : "system",
            trigger: opts.subagentContext ? "tool" : "scheduled",
            ...(opts.subagentContext ? {
              actor: {
                kind: "subagent",
                agentId: targetAgent.id || null,
                ...(childSessionId ? { sessionId: childSessionId } : {}),
                sessionPath: childSessionPath,
                taskId: opts.subagentTaskId || null,
                threadId: opts.subagentThreadId || null,
                threadKind: opts.subagentThreadKind || null,
              },
            } : {}),
            ...(parentSessionPath ? {
              parent: {
                kind: "session",
                ...(parentSessionId ? { sessionId: parentSessionId } : {}),
                sessionPath: parentSessionPath,
              },
            } : {}),
          },
          attribution: parentSessionPath
            ? {
                kind: "session",
                agentId: this._d.agentIdFromSessionPath?.(parentSessionPath) || null,
                ...(parentSessionId ? { sessionId: parentSessionId } : {}),
                sessionPath: parentSessionPath,
                childAgentId: opts.subagentContext ? targetAgent.id || null : undefined,
                childSessionId: opts.subagentContext ? childSessionId || undefined : undefined,
                childSessionPath: opts.subagentContext ? childSessionPath : undefined,
                taskId: opts.subagentContext ? opts.subagentTaskId || null : undefined,
                threadId: opts.subagentContext ? opts.subagentThreadId || null : undefined,
                threadKind: opts.subagentContext ? opts.subagentThreadKind || null : undefined,
              }
            : { kind: opts.subagentContext ? "utility" : "automation", agentId: targetAgent.id || null },
        });
        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            replyText += sub.delta || "";
          }
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          finalStopReason = event.message.stopReason ?? null;
          finalErrorMessage = event.message.errorMessage || (event.message as any).error || null;
          finalAssistantText = collectAssistantTextFromMessage(event.message) || finalAssistantText;
        }
        if (event.type === "tool_execution_end") {
          if (event.isError) {
            toolErrors.push(toolErrorSummary(event));
          } else {
            for (const file of collectSessionFilesFromToolResult(event.result)) {
              addUniqueSessionFile(sessionFiles, file);
            }
          }
        }
        if (opts.emitEvents && childSessionPath) {
          this._d.emitEvent({ ...event, isolated: true }, childSessionPath);
        }
      });

      // isolated 专用 teardown: 临时 session 不在 _sessions Map 中,
      // 但仍需 emit shutdown + dispose 以避免扩展资源泄漏。幂等:
      // AgentSession.dispose() 基于 _unsubscribeAgent 做重复调用保护。
      const teardownIsolatedSession = async (label) => {
        await teardownSessionResources({
          session,
          unsub,
          label: `executeIsolated[${label}]`,
          warn: (msg) => log.warn(msg),
        });
      };

      const abortHandler = () => session.abort();
      opts.signal?.addEventListener("abort", abortHandler, { once: true });

      if (opts.signal?.aborted) {
        opts.signal.removeEventListener("abort", abortHandler);
        await teardownIsolatedSession("early_abort");
        cleanupTempSession();
        return { sessionPath: null, replyText: "", error: "aborted" };
      }

      try {
        await session.prompt(prompt);
      } finally {
        opts.signal?.removeEventListener("abort", abortHandler);
        await teardownIsolatedSession("finally");
      }

      const sessionPath = session.sessionManager?.getSessionFile?.() || null;
      const finalReplyText = stripClosedInternalNarrationBlocks(replyText || finalAssistantText);
      const completionError = isolatedCompletionError(finalStopReason, finalErrorMessage);

      if (!opts.persist && !isResumedSession && sessionPath) {
        // 非 persist 的临时 session 文件清理 best-effort：删不掉不影响返回结果。
        // isResumedSession 双保险：resume 复用文件即使调用方漏设 persist 也绝不删。
        try { fs.unlinkSync(sessionPath); } catch {}
        return {
          sessionPath: null,
          replyText: finalReplyText,
          error: completionError,
          stopReason: finalStopReason,
          sessionFiles,
          toolErrors,
        };
      }

      return {
        sessionPath,
        replyText: finalReplyText,
        error: completionError,
        stopReason: finalStopReason,
        sessionFiles,
        toolErrors,
      };
    } catch (err) {
      log.error(`isolated execution failed: ${err.message}`);
      if (!opts.persist && tempSessionMgr) {
        cleanupTempSession();
      }
      return { sessionPath: null, replyText: "", error: err.message };
    } finally {
      if (childSessionPath && bm.isRunning(childSessionPath)) {
        try { await bm.closeBrowserForSession(childSessionPath); }
        catch (err) { log.warn(`executeIsolated browser cleanup failed for ${path.basename(childSessionPath)}: ${err.message}`); }
      }
      this._headlessOps.delete(opId);
      if (this._headlessOps.size === 0) bm.setHeadless(false);
      const browserNowRunning = bm.hasAnyRunning;
      if (browserNowRunning !== wasBrowserRunning) {
        this._d.emitEvent({ type: "browser_bg_status", running: browserNowRunning }, null);
      }
    }
  }

  /** 创建 session 专用 settings（控制 compaction + max_completion_tokens） */
  _createSettings(model: any) {
    return createDefaultSettings();
  }
}
