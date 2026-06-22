/**
 * HanaEngine — Hanako 的核心引擎（Thin Facade）
 *
 * 持有所有 Manager，对外暴露统一 API。
 * 具体逻辑委托给：
 *   - AgentManager       — agent CRUD / init / switch
 *   - SessionCoordinator — session 生命周期 / listing
 *   - ConfigCoordinator  — 配置读写 / 模型 / 搜索 / utility
 *   - ChannelManager     — 频道 CRUD / 成员管理
 *   - BridgeSessionManager — 外部平台 session
 *   - ModelManager        — 模型注册 / 发现
 *   - PreferencesManager  — 全局偏好
 *   - SkillManager        — 技能注册 / 同步
 */
import fs from "fs";
import os from "os";
import path from "path";
import { migrateConfigScope } from "../shared/migrate-config-scope.ts";
import { migrateToProvidersYaml } from "./migrate-providers.ts";
import { migrateProviderMediaConfig } from "./provider-media-config.ts";
import { runMigrations } from "./migrations.ts";
import { createServerRuntimeContext } from "./server-runtime-context.ts";
import { StudioCronService } from "./studio-cron-service.ts";
import { createRuntimeExecutionBoundary } from "./execution-boundary.ts";
import { ResourceAccessService } from "./resource-access-service.ts";
import { ResourceService } from "./resource-service.ts";
import { appendSecurityAuditEvent } from "./security-audit-log.ts";
import { findModel } from "../shared/model-ref.ts";
import { resolveWorkspaceSkillPaths } from "../shared/workspace-skill-paths.ts";
import { resolveHanaPiAgentDir, resolveHanaPiProjectDir } from "../shared/hana-runtime-paths.ts";
import { PluginManager } from "./plugin-manager.ts";
import { PluginDevService } from "./plugin-dev-service.ts";
import { createPluginDevTools } from "./plugin-dev-tools.ts";
import { DefaultResourceLoader, SettingsManager } from "../lib/pi-sdk/index.ts";
import { compactSessionWithCachePreservation, isStaleExtensionContextError } from "./session-compactor.ts";
import { getFreshCompactNoopReason } from "../lib/fresh-compact/policy.ts";
import { DeferredResultCoordinator } from "../lib/deferred-result-coordinator.ts";
import { getToolSessionPath, normalizeToolRuntimeContext } from "../lib/tools/tool-session.ts";
import { loadLocale } from "../lib/i18n.ts";
import { createApprovalGateway, createModelApprovalReviewer } from "../lib/approval-gateway.ts";
import { callText } from "./llm-client.ts";

/** 已知的外部 AI 工具技能目录（相对 $HOME） */
export const WELL_KNOWN_SKILL_PATHS = [
  { suffix: ".claude/skills",     label: "Claude Code" },
  { suffix: ".codex/skills",      label: "Codex" },
  { suffix: ".openclaw/skills",   label: "OpenClaw" },
  { suffix: ".pi/agent/skills",   label: "Pi" },
  { suffix: ".agents/skills",     label: "Agents" },
];

function findUniqueModelById(models, id) {
  if (!id || !Array.isArray(models)) return null;
  const matches = models.filter(m => m.id === id);
  return matches.length === 1 ? matches[0] : null;
}

function readSessionThinkingLevel(ctx) {
  try {
    const level = ctx?.sessionManager?.buildSessionContext?.()?.thinkingLevel;
    return typeof level === "string" ? level : null;
  } catch {
    return null;
  }
}

function resolveRequestReasoningLevel(models, prefs, ctx) {
  const sessionThinkingLevel = readSessionThinkingLevel(ctx);
  const defaultThinkingLevel = typeof models.getModelDefaultThinkingLevel === "function"
    ? models.getModelDefaultThinkingLevel(ctx?.model || null, prefs.getThinkingLevel())
    : prefs.getThinkingLevel();
  const preferenceThinkingLevel = models.resolveThinkingLevel(defaultThinkingLevel);
  const preferenceRequestsMax = preferenceThinkingLevel === "xhigh" || preferenceThinkingLevel === "max";
  return preferenceRequestsMax && sessionThinkingLevel === "high"
    ? preferenceThinkingLevel
    : (sessionThinkingLevel || preferenceThinkingLevel);
}

function resolveChannelsEnabledForToolAvailability(engine) {
  try {
    if (
      Object.prototype.hasOwnProperty.call(engine, "isChannelsEnabled")
      && typeof engine.isChannelsEnabled === "function"
    ) {
      return engine.isChannelsEnabled();
    }
    if (typeof engine._configCoord?.getChannelsEnabled === "function") {
      return engine._configCoord.getChannelsEnabled();
    }
    if (typeof engine._prefs?.getChannelsEnabled === "function") {
      return engine._prefs.getChannelsEnabled();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

import { PreferencesManager } from "./preferences-manager.ts";
import { ModelManager } from "./model-manager.ts";
import { SessionProjectCatalogStore } from "./session-project-catalog-store.ts";
import { SkillManager } from "./skill-manager.ts";
import { BridgeSessionManager } from "./bridge-session-manager.ts";
import { createSlashSystem } from "./slash-commands/index.ts";
import { AgentManager } from "./agent-manager.ts";
import { sanitizeMessagesForModel, stripHistoricalInlineMediaForReplay } from "./message-sanitizer.ts";
import { normalizeProviderContextMessages, normalizeProviderPayload } from "./provider-compat.ts";
import { VisionBridge } from "./vision-bridge.ts";
import { SessionCoordinator } from "./session-coordinator.ts";
import { SessionManifestResolver } from "./session-manifest/resolver.ts";
import { SessionManifestStore } from "./session-manifest/store.ts";
import { ensureLegacySessionManifestMigration } from "./session-manifest/startup-migration.ts";
import {
  moveSessionManifestDbFilesAside,
  sanitizeSessionManifestFileSuffix,
} from "./session-manifest/db-files.ts";
import { ConfigCoordinator, SHARED_MODEL_KEYS } from "./config-coordinator.ts";
import { ChannelManager } from "./channel-manager.ts";
import {
  summarizeTitle as _summarizeTitle,
  translateSkillNames as _translateSkillNames,
  summarizeActivity as _summarizeActivity,
  summarizeActivityQuick as _summarizeActivityQuick,
} from "./llm-utils.ts";
import { debugLog, createModuleLogger } from "../lib/debug-log.ts";
import { createSandboxedTools } from "../lib/sandbox/index.ts";
import { externalReadPathsFromSessionFiles } from "../lib/sandbox/win32-policy.ts";
import { Win32LegacySandboxCleanupQueue } from "../lib/sandbox/win32-legacy-migration.ts";
import { t } from "../lib/i18n.ts";
import { CheckpointStore } from "../lib/checkpoint-store.ts";
import { assertAllToolsCategorized } from "../shared/tool-categories.ts";
import { workspaceRootsForSandbox } from "../shared/workspace-scope.ts";
import { wrapWithCheckpoint } from "../lib/checkpoint-wrapper.ts";
import { wrapWithSessionPermission } from "../lib/tools/session-permission-wrapper.ts";
import { filterToolObjectsByAvailability } from "./tool-availability.ts";
import { TaskRegistry } from "../lib/task-registry.ts";
import { TerminalSessionManager } from "../lib/terminal/terminal-session-manager.ts";
import { PluginInstallRecords } from "../lib/plugin-install-records.ts";
import { ComputerHost } from "./computer-use/computer-host.ts";
import { ComputerProviderRegistry } from "./computer-use/provider-registry.ts";
import { createMockComputerProvider } from "./computer-use/providers/mock-provider.ts";
import { createMacosCuaProvider } from "./computer-use/providers/macos-cua-provider.ts";
import { createWindowsUiaProvider } from "./computer-use/providers/windows-uia-provider.ts";
import {
  effectiveComputerUseSettings,
  isComputerUsePlatformSupported,
} from "./computer-use/platform-support.ts";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";
import { serializeSessionFile } from "../lib/session-files/session-file-response.ts";
import { AutomationSuggestionStore } from "../lib/tools/automation-suggestion-store.ts";
import { NotificationService } from "../lib/notifications/notification-service.ts";
import { SpeechRecognitionService } from "./speech-recognition-service.ts";
import { UniversalMediaManager } from "./media/universal-media-manager.ts";
import { createCurrentTurnNativeMediaStore } from "./current-turn-native-media.ts";
import {
  getSkillNameTranslationCachePath,
  translateSkillNamesWithCache,
} from "../lib/skills/skill-name-translation-cache.ts";
import { createUsageLedger } from "../lib/llm/usage-ledger.ts";
import {
  autoProjectIdForCwd,
  isAutoProjectId,
  normalizeSessionProjectId,
  UNCATEGORIZED_PROJECT_ID,
} from "../shared/session-projects.ts";

const moduleLog = createModuleLogger("engine");
const toolAvailabilityLog = createModuleLogger("tool-availability");
const win32SandboxCleanupLog = createModuleLogger("win32-sandbox-cleanup");

function sessionBelongsToProject(projectId) {
  return (session) => {
    const explicitProjectId = normalizeSessionProjectId(session?.projectId);
    if (explicitProjectId) return explicitProjectId === projectId;
    if (!isAutoProjectId(projectId)) return false;
    return autoProjectIdForCwd(session?.cwd || null) === projectId;
  };
}

export class HanaEngine {
  declare _activityHub: any;
  declare _agentMgr: any;
  declare _approvalGateway: any;
  declare _automationSuggestionStore: any;
  declare _bridge: any;
  declare _channels: any;
  declare _checkpointStore: any;
  declare _computerHost: any;
  declare _computerProviders: any;
  declare _configCoord: any;
  declare _confirmStore: any;
  declare _coreExtensionFactories: any;
  declare _currentTurnNativeMedia: any;
  declare _deferredResultCoordinator: any;
  declare _deferredResultStore: any;
  declare _devLogs: any;
  declare _devLogsMax: any;
  declare _discoveredExternalPaths: any;
  declare _eventBus: any;
  declare _extensionFactories: any;
  declare _frameworkExtFactories: any;
  declare _hubCallbacks: any;
  declare _imageStripNotified: any;
  declare _listeners: any;
  declare _media: any;
  declare _models: any;
  declare _notifications: any;
  declare _outboundProxyRuntime: any;
  declare _pluginDevEventBusCleanup: any;
  declare _pluginDevService: any;
  declare _pluginInstallRecords: any;
  declare _pluginManager: any;
  declare _prefs: any;
  declare _resourceAccess: any;
  declare _resourceLoader: any;
  declare _resources: any;
  declare _runtimeContext: any;
  declare _sessionCoord: any;
  declare _sessionFiles: any;
  declare _sessionManifestMigration: any;
  declare _sessionManifestResolver: any;
  declare _sessionManifestStore: any;
  declare _sessionManifestStoreRecovery: any;
  declare _sessionProjects: any;
  declare _skills: any;
  declare _slashSystem: any;
  declare _speechRecognition: any;
  declare _studioCronService: any;
  declare _subagentControllers: any;
  declare _subagentRunStore: any;
  declare _subagentThreadStore: any;
  declare _taskRegistry: any;
  declare _terminalSessions: any;
  declare _uiContextBySession: any;
  declare _usageLedger: any;
  declare _videoStripNotified: any;
  declare _visionBridge: any;
  declare _win32LegacySandboxCleanupQueue: any;
  declare agentsDir: any;
  declare appVersion: any;
  declare channelsDir: any;
  declare hanakoHome: any;
  declare productDir: any;
  declare userDir: any;
  /**
   * @param {object} dirs
   * @param {string} dirs.hanakoHome
   * @param {string} dirs.productDir
   * @param {string} [dirs.agentId]
   * @param {string} [dirs.appVersion]
   */
  constructor({ hanakoHome, productDir, agentId, appVersion }) {
    this.hanakoHome = hanakoHome;
    this.productDir = productDir;
    this.appVersion = appVersion || "0.0.0";
    this._runtimeContext = null;
    this._resources = null;
    this._resourceAccess = null;
    this.agentsDir = path.join(hanakoHome, "agents");
    this.userDir = path.join(hanakoHome, "user");
    this.channelsDir = path.join(hanakoHome, "channels");
    fs.mkdirSync(this.channelsDir, { recursive: true });
    this._studioCronService = new StudioCronService({
      hanakoHome: this.hanakoHome,
      agentsDir: this.agentsDir,
      getStudioId: () => {
        const studioId = this._runtimeContext?.studioId;
        if (!studioId) throw new Error("runtime studioId unavailable");
        return studioId;
      },
    });
    this._sessionFiles = new SessionFileRegistry({
      managedCacheRoot: path.join(hanakoHome, "session-files"),
      getSessionIdForPath: (sessionPath) => this.getSessionIdForPath(sessionPath),
    });
    this._sessionManifestStoreRecovery = null;
    this._sessionManifestStore = this._openSessionManifestStore();
    this._sessionManifestResolver = this._sessionManifestStore
      ? new SessionManifestResolver({ store: this._sessionManifestStore })
      : null;
    this._sessionManifestMigration = this._runSessionManifestStartupMigration();
    this._currentTurnNativeMedia = createCurrentTurnNativeMediaStore();
    this._pluginInstallRecords = new PluginInstallRecords({ hanakoHome });
    this._automationSuggestionStore = new AutomationSuggestionStore();
    this._approvalGateway = createApprovalGateway({
      smallToolModelReviewer: createModelApprovalReviewer({
        role: "utility",
        resolveUtilityConfig: (options) => this.resolveUtilityConfig(options || {}),
        callText: (options) => this._callApprovalReviewerText(options),
      }),
      largeToolModelReviewer: createModelApprovalReviewer({
        role: "utility_large",
        resolveUtilityConfig: (options) => this.resolveUtilityConfig(options || {}),
        callText: (options) => this._callApprovalReviewerText(options),
      }),
    });

    // ── Core managers ──
    this._prefs = new PreferencesManager({ userDir: this.userDir, agentsDir: this.agentsDir });
    this._models = new ModelManager({ hanakoHome });
    this._speechRecognition = new SpeechRecognitionService({
      providerRegistry: this._models.providerRegistry,
      preferences: this._prefs,
      sessionFiles: this._sessionFiles,
      emitEvent: (event, sessionPath) => this._emitEvent(event, sessionPath),
    });
    this._media = new UniversalMediaManager({
      hanakoHome: this.hanakoHome,
      providerRegistry: this._models.providerRegistry,
      preferences: this._prefs,
      speechRecognition: this._speechRecognition,
      sessionFiles: this._sessionFiles,
      registerSessionFile: (entry) => this.serializeSessionFile(this.registerSessionFile(entry)),
      onProviderChanged: () => this.onProviderChanged(),
    });
    this._sessionProjects = new SessionProjectCatalogStore({ userDir: this.userDir });

    // 确定启动时焦点 agent
    const startId = agentId || this._prefs.getPrimaryAgent() || this._prefs.findFirstAgent();
    if (!startId) throw new Error(t("error.noAgentsFound"));

    // ── Channel Manager ──
    this._channels = new ChannelManager({
      channelsDir: this.channelsDir,
      agentsDir: this.agentsDir,
      userDir: this.userDir,
      getHub: () => this._hubCallbacks,
    });

    // ── Agent Manager ──
    this._agentMgr = new AgentManager({
      hanakoHome: this.hanakoHome,
      agentsDir: this.agentsDir,
      productDir: this.productDir,
      userDir: this.userDir,
      channelsDir: this.channelsDir,
      getPrefs: () => this._prefs,
      getModels: () => this._models,
      getHub: () => this._hubCallbacks,
      getSkills: () => this._skills,
      getSearchConfig: () => this.getSearchConfig(),
      resolveUtilityConfig: (options) => this.resolveUtilityConfig(options),
      getSharedModels: () => this._configCoord.getSharedModels(),
      getChannelManager: () => this._channels,
      getSessionCoordinator: () => this._sessionCoord,
      getEngine: () => this,
      getResourceLoader: () => this._resourceLoader,
    });

    // ── Session Coordinator ──
    this._sessionCoord = new SessionCoordinator({
      agentsDir: this.agentsDir,
      getAgent: () => this.agent,
      getActiveAgentId: () => this.currentAgentId,
      getModels: () => this._models,
      getResourceLoader: () => this._resourceLoader,
      getSkills: () => this._skills,
      buildTools: (cwd, ct, opts) => this.buildTools(cwd, ct, opts),
      emitEvent: (e, sp) => this._emitEvent(e, sp),
      emitDevLog: (t, l) => this.emitDevLog(t, l),
      getHomeCwd: (agentId) => this.getHomeCwd(agentId),
      agentIdFromSessionPath: (p) => this.agentIdFromSessionPath(p),
      switchAgentOnly: (id) => this._agentMgr.switchAgentOnly(id),
      getConfig: () => this.config,
      getPrefs: () => this._prefs,
      getAgents: () => this._agentMgr.agents,
      getActivityStore: (id) => this.getActivityStore(id),
      getAgentById: (id) => this._agentMgr.getAgent(id),
      ensureAgentRuntime: (id, opts) => this.ensureAgentRuntime(id, opts),
      listAgents: () => this.listAgents(),
      listDeletedAgents: () => this.listDeletedAgents(),
      isAgentDeleted: (id) => this.isAgentDeleted(id),
      getDeletedAgentInfo: (id) => this.getDeletedAgentInfo(id),
      getConfirmStore: () => this._confirmStore,
      getDeferredResultStore: () => this._deferredResultStore,
      getTaskRegistry: () => this._taskRegistry,
      getEngine: () => this,
      getUsageLedger: () => this._usageLedger,
      sessionManifestStore: this._sessionManifestStore,
      closeTerminalsForSession: (sessionPath) => this._terminalSessions.closeForSession(sessionPath),
      closeAllTerminals: () => this._terminalSessions.closeAll(),
      onSessionRuntimeDiscarded: (sessionPath, reason) => this.clearSessionRuntimeState(sessionPath, reason),
      onBeforeSessionCreate: async (cwd) => {
        await this.syncWorkspaceSkillPaths(cwd, { reload: true, emitEvent: false });
      },
    });

    // ── Config Coordinator ──
    this._configCoord = new ConfigCoordinator({
      hanakoHome,
      agentsDir: this.agentsDir,
      getAgent: () => this.agent,
      getAgentById: (id) => this._agentMgr.getAgent(id),
      getActiveAgentId: () => this._agentMgr.activeAgentId,
      getAgents: () => this._agentMgr.agents,
      getModels: () => this._models,
      getPrefs: () => this._prefs,
      getSkills: () => this._skills,
      getSession: () => this._sessionCoord.session,
      getSessionCoordinator: () => this._sessionCoord,
      getHub: () => this._hubCallbacks,
      emitEvent: (e, sp) => this._emitEvent(e, sp),
      emitDevLog: (t, l) => this.emitDevLog(t, l),
      getCurrentModel: () => this.currentModel?.name,
    });

    this._visionBridge = new VisionBridge({
      resolveVisionConfig: () => this.resolveVisionConfig(),
      getUsageLedger: () => this._usageLedger,
      getActiveAgentId: () => this._agentMgr.activeAgentId,
      getSessionIdForPath: (sessionPath) => this.getSessionIdForPath(sessionPath),
    });

    // ── Bridge Session Manager ──
    this._bridge = new BridgeSessionManager({
      getAgent: () => this.agent,
      getAgentById: (id) => this._agentMgr.getAgent(id),
      getAgents: () => this._agentMgr.agents,
      getModelManager: () => this._models,
      getResourceLoader: () => this._resourceLoader,
      getSkills: () => this._skills,
      getPreferences: () => this._readPreferences(),
      buildTools: (cwd, customTools, opts) => this.buildTools(cwd, customTools, opts),
      getHomeCwd: (agentId) => this.getHomeCwd(agentId),
      getVisionBridge: () => this._visionBridge,
      isVisionAuxiliaryEnabled: () => this.isVisionAuxiliaryEnabled(),
      getHanakoHome: () => this.hanakoHome,
      registerSessionFile: (entry) => this.registerSessionFile(entry),
      getSessionFile: (fileId, options) => this.getSessionFile(fileId, options),
      getSessionFileByPath: (filePath, options) => this.getSessionFileByPath(filePath, options),
      getSessionIdForPath: (sessionPath) => this.getSessionIdForPath(sessionPath),
      beginCurrentTurnNativeMedia: (sessionPath, opts) => this.beginCurrentTurnNativeMedia(sessionPath, opts),
      endCurrentTurnNativeMedia: (token) => this.endCurrentTurnNativeMedia(token),
      emitEvent: (event, sessionPath) => this._emitEvent(event, sessionPath),
      ensureAgentRuntime: (id, opts) => this.ensureAgentRuntime(id, opts),
      getUsageLedger: () => this._usageLedger,
    });
    this._notifications = new NotificationService({
      emitDesktop: ({ title, body, agentId, desktopFocusPolicy, sessionPath }) => {
        this._hubCallbacks?.eventBus?.emit({
          type: "notification",
          title,
          body,
          agentId: agentId || null,
          desktopFocusPolicy,
          ...(sessionPath ? { sessionPath } : {}),
        }, sessionPath || null);
      },
      getBridgeManager: () => this._hubCallbacks?.hub?.bridgeManager || null,
    });

    // ── Slash Command System ──
    // hub 尚未注入，dispatcher 的 hub 字段先为 null；setHubCallbacks 时通过 setHub() 补齐
    this._slashSystem = createSlashSystem({ engine: this, hub: null });

    // 任务注册表（外部 abort 用）；handler 是运行时函数，任务元数据持久化供插件重启恢复和诊断使用。
    this._taskRegistry = new TaskRegistry({
      persistencePath: path.join(this.hanakoHome, ".ephemeral", "plugin-tasks.json"),
      getSessionIdForPath: (sessionPath) => this.getSessionIdForPath(sessionPath),
    });

    // subagent AbortController 存储（engine 级别，跨 agent 共享）
    this._subagentControllers = new Map();
    this._subagentRunStore = null;
    this._taskRegistry.registerHandler("subagent", {
      abort: (taskId) => {
        const ctrl = this._subagentControllers.get(taskId);
        if (ctrl) ctrl.abort();
      },
    });

    this._terminalSessions = new TerminalSessionManager({
      hanakoHome: this.hanakoHome,
      getSessionIdForPath: (sessionPath) => this.getSessionIdForPath(sessionPath),
      emitEvent: (event, sessionPath) => this._emitEvent(event, sessionPath),
    });

    // Checkpoint 备份存储
    this._checkpointStore = new CheckpointStore(
      path.join(this.hanakoHome, "checkpoints")
    );

    // Computer Use runtime is deliberately lazy. Constructing the provider
    // registry resolves native helper paths and wires platform-specific
    // runners; keep startup cold until the global switch is enabled or a
    // Computer Use endpoint/tool explicitly needs the host.
    this._computerProviders = null;
    this._computerHost = null;

    // ── Plugin Manager ──
    this._pluginManager = null;  // initialized async in initPlugins()
    this._pluginDevService = null;
    this._pluginDevEventBusCleanup = null;

    // Pi SDK resources（init 时填充）
    this._resourceLoader = null;

    // Hub 回调（由 Hub 构造后通过 setHubCallbacks 注入，替代旧的 engine._hub 双向引用）
    this._hubCallbacks = null;

    // 事件系统
    this._listeners = new Set();
    this._eventBus = null;
    this._usageLedger = createUsageLedger({
      storagePath: path.join(this.hanakoHome, "usage-ledger.json"),
      eventBus: {
        emit: (event, sessionPath) => this._emitEvent(event, sessionPath),
      },
      logger: moduleLog,
    });

    // 首次剥媒体通知去重：sessionPath → 已通知。由 context extension handler 维护，
    // 避免每一轮对话都重复广播 stripped_notice 事件。
    this._imageStripNotified = new Set();
    this._videoStripNotified = new Set();

    // UI context（用户当前视野）：sessionPath → { currentViewed, activeFile,
    // activePreview, pinnedFiles }。由前端每次发 prompt 时带过来，经 server/routes/chat.js
    // 写入；current_status 工具按需读取 ui_context 来解析“这个 / 当前打开的”等指代。
    this._uiContextBySession = new Map();

    // DevTools 日志
    this._devLogs = [];
    this._devLogsMax = 200;

    this._outboundProxyRuntime = null;
    this._win32LegacySandboxCleanupQueue = process.platform === "win32"
      ? new Win32LegacySandboxCleanupQueue({
          hanakoHome: this.hanakoHome,
          log: win32SandboxCleanupLog,
        })
      : null;

    // 设置起始 agentId
    this._agentMgr.activeAgentId = startId;
  }

  // ════════════════════════════
  //  Agent 代理（→ AgentManager）
  // ════════════════════════════

  /** @ui-focus-only 返回 UI 焦点 agent 实例，后端逻辑应通过 getAgent(agentId) 查询 */
  get agent() { return this._agentMgr.agent; }
  get usageLedger() { return this._usageLedger; }
  getAgent(agentId) { return this._agentMgr.getAgent(agentId); }
  async ensureAgentRuntime(agentId, opts: any = {}) {
    const targetId = agentId || this.currentAgentId;
    return this._agentMgr.ensureAgentRuntime(targetId, opts);
  }
  /** @ui-focus-only 返回 UI 焦点 agent 的 ID */
  get currentAgentId() { return this._agentMgr.activeAgentId; }
  get confirmStore() { return this._confirmStore; }
  get automationSuggestionStore() { return this._automationSuggestionStore; }
  getAutomationSuggestionStore() { return this._automationSuggestionStore; }
  get approvalGateway() { return this._approvalGateway; }
  getStudioCronStore() { return this._studioCronService; }

  /** @deprecated 工具应通过 emitEvent(event, sessionPath) 传入显式 sessionPath */
  emitSessionEvent(event) {
    this._emitEvent(event, this.currentSessionPath);
  }

  setConfirmStore(store) {
    this._confirmStore = store;
    if (store) {
      store.onResolved = (confirmId, action) => {
        this._emitEvent({ type: "confirmation_resolved", confirmId, action }, null);
      };
    }
  }

  setDeferredResultStore(store) {
    this._deferredResultCoordinator?.dispose?.();
    this._deferredResultStore = store;
    this._deferredResultCoordinator = null;
    if (store) {
      this._deferredResultCoordinator = new DeferredResultCoordinator({
        store,
        sessionCoordinator: this._sessionCoord,
        recordCustomEntry: (sessionPath, customType, data) => (
          this.recordSessionCustomEntry(sessionPath, customType, data)
        ),
      });
      this._deferredResultCoordinator.start();
    }
  }

  get deferredResults() {
    return this._deferredResultStore || null;
  }

  setSubagentRunStore(store) {
    this._subagentRunStore = store || null;
  }

  get subagentRuns() {
    return this._subagentRunStore || null;
  }

  setSubagentThreadStore(store) {
    this._subagentThreadStore = store || null;
  }

  get subagentThreads() {
    return this._subagentThreadStore || null;
  }

  setActivityHub(hub) {
    this._activityHub = hub || null;
  }

  get activityHub() {
    return this._activityHub || null;
  }

  get taskRegistry() {
    return this._taskRegistry;
  }

  get runtimeContext() {
    return this._runtimeContext;
  }

  getRuntimeContext() {
    if (!this._runtimeContext) {
      throw new Error("server runtime context is not initialized");
    }
    return this._runtimeContext;
  }

  createExecutionBoundary( options: any = {}) {
    return createRuntimeExecutionBoundary(this.getRuntimeContext(), options);
  }

  get terminalSessions() {
    return this._terminalSessions;
  }

  registerSessionFile(entry) {
    const sessionId = entry?.sessionId || (
      entry?.sessionPath ? this.getSessionIdForPath(entry.sessionPath) : null
    );
    return this._sessionFiles.registerFile({
      ...entry,
      ...(sessionId ? { sessionId } : {}),
    });
  }
  recordSessionFileOperation(entry) {
    const file = this.registerSessionFile(entry);
    this._emitSessionFileUpdatedEvent(file, entry);
    return file;
  }
  _emitSessionFileUpdatedEvent(file, entry: any = {}) {
    const origin = typeof file?.origin === "string" ? file.origin : entry?.origin;
    if (origin !== "agent_write" && origin !== "agent_edit") return;

    const sessionPath = file?.sessionPath || entry?.sessionPath;
    const filePath = file?.filePath || entry?.filePath;
    if (!sessionPath || !filePath) return;

    const fileId = file?.id || file?.fileId || null;
    const operation = entry?.operation || file?.operation || (
      Array.isArray(file?.operations) ? file.operations[file.operations.length - 1] : null
    );
    this._emitAppEvent("session-file-updated", {
      sessionPath,
      filePath,
      ...(fileId ? { fileId } : {}),
      origin,
      ...(operation ? { operation } : {}),
      ...(file?.mtimeMs !== undefined ? { mtimeMs: file.mtimeMs } : {}),
      ...(file?.size !== undefined ? { size: file.size } : {}),
      ...(file?.version ? { version: file.version } : {}),
    });
  }
  _sessionFileOptionsWithLocator(options: any = {}) {
    const next = { ...(options || {}) };
    if (next.sessionId && !next.sessionPath) {
      const manifest = this.getSessionManifest?.(next.sessionId) || null;
      const locatorPath = manifest?.currentLocator?.path || null;
      if (locatorPath) next.sessionPath = locatorPath;
    }
    return next;
  }
  getSessionFile(fileId, options) { return this._sessionFiles.get(fileId, this._sessionFileOptionsWithLocator(options)); }
  getSessionFileByPath(filePath, options) { return this._sessionFiles.getByFilePath(filePath, this._sessionFileOptionsWithLocator(options)); }
  getSessionFileBySourceKey(sourceKey, options) { return this._sessionFiles.getBySourceKey(sourceKey, this._sessionFileOptionsWithLocator(options)); }
  listSessionFiles(sessionPath) { return this._sessionFiles.list(sessionPath); }
  updateSessionFileTranscription(fileId, transcription, options) { return this._sessionFiles.updateTranscription(fileId, transcription, this._sessionFileOptionsWithLocator(options)); }
  _sessionRefForPath(sessionPath) {
    return {
      sessionId: this.getSessionIdForPath(sessionPath),
      sessionPath,
    };
  }
  _sessionRefForPathSafe(sessionPath) {
    return typeof this._sessionRefForPath === "function"
      ? this._sessionRefForPath(sessionPath)
      : { sessionId: null, sessionPath };
  }
  beginCurrentTurnNativeMedia(sessionPath, opts) {
    const sessionRef = typeof this._sessionRefForPathSafe === "function"
      ? this._sessionRefForPathSafe(sessionPath)
      : { sessionId: null, sessionPath };
    return this._currentTurnNativeMedia.begin(sessionRef, opts);
  }
  endCurrentTurnNativeMedia(token) { return this._currentTurnNativeMedia.end(token); }
  _sessionRuntimeKeyForPath(sessionPath) {
    if (!sessionPath) return null;
    try {
      return this.getSessionIdForPath?.(sessionPath) || sessionPath;
    } catch {
      return sessionPath;
    }
  }
  _deleteSessionRuntimeMapEntry(map, sessionPath) {
    const key = this._sessionRuntimeKeyForPath(sessionPath);
    if (!key) return false;
    const deleted = map?.delete?.(key) === true;
    const legacyDeleted = key !== sessionPath ? map?.delete?.(sessionPath) === true : false;
    return deleted || legacyDeleted;
  }
  _deleteSessionRuntimeSetEntry(set, sessionPath) {
    const key = this._sessionRuntimeKeyForPath(sessionPath);
    if (!key) return false;
    const deleted = set?.delete?.(key) === true;
    const legacyDeleted = key !== sessionPath ? set?.delete?.(sessionPath) === true : false;
    return deleted || legacyDeleted;
  }
  clearSessionRuntimeState(sessionPath, reason = "discard") {
    if (!sessionPath) return false;
    void reason;
    const sessionRef = typeof this._sessionRefForPathSafe === "function"
      ? this._sessionRefForPathSafe(sessionPath)
      : { sessionId: null, sessionPath };
    this._deleteSessionRuntimeMapEntry(this._uiContextBySession, sessionPath);
    this._deleteSessionRuntimeSetEntry(this._imageStripNotified, sessionPath);
    this._deleteSessionRuntimeSetEntry(this._videoStripNotified, sessionPath);
    if (typeof this._currentTurnNativeMedia?.clearSession === "function") {
      this._currentTurnNativeMedia.clearSession(sessionRef);
    }
    if (typeof this._sessionFiles?.unloadSession === "function") {
      this._sessionFiles.unloadSession(sessionPath);
    }
    if (typeof this._computerHost?.abortSession === "function") {
      this._computerHost.abortSession(sessionRef);
    }
    return true;
  }
  get speechRecognition() { return this._speechRecognition; }
  get media() { return this._media; }
  get resources() { return this._resources; }
  getResourceService() {
    if (!this._resources) throw new Error("resource service is not initialized");
    return this._resources;
  }
  getResourceAccessService() {
    if (!this._resourceAccess) throw new Error("resource access service is not initialized");
    return this._resourceAccess;
  }
  getResource(resourceId) { return this.getResourceService().getResource(resourceId); }
  resolveResourceContent(resourceId) { return this.getResourceService().resolveContent(resourceId); }
  serializeSessionFile(file) { return serializeSessionFile(file, { runtimeContext: this.getRuntimeContext() }); }
  async cleanupColdSessionFiles(options) {
    return this._sessionFiles.cleanupColdSessions({
      agentsDir: this.agentsDir,
      ...(options || {}),
    });
  }

  setSubagentController(taskId, controller) { this._subagentControllers.set(taskId, controller); }
  removeSubagentController(taskId) { this._subagentControllers.delete(taskId); }

  /**
   * 写入某 session 当前的 UI context（用户视野）。
   * 前端在发每条 prompt 时带上；current_status(ui_context) 按需读取。
   * 传 null / undefined 等价于删除（显式清空）。
   *
   * @param {string} sessionPath
   * @param {{currentViewed?: string|null, activeFile?: string|null, activePreview?: string|null, pinnedFiles?: string[]}|null|undefined} ctx
   */
  setUiContext(sessionPath, ctx) {
    if (!sessionPath) return;
    const key = this._sessionRuntimeKeyForPath(sessionPath);
    if (!key) return;
    if (ctx == null) {
      this._deleteSessionRuntimeMapEntry(this._uiContextBySession, sessionPath);
    } else {
      this._uiContextBySession.set(key, ctx);
      if (key !== sessionPath) this._uiContextBySession.delete(sessionPath);
    }
  }

  /** 读取某 session 当前的 UI context。无则返回 null。 */
  getUiContext(sessionPath) {
    if (!sessionPath) return null;
    const key = this._sessionRuntimeKeyForPath(sessionPath);
    if (!key) return null;
    return this._uiContextBySession.get(key)
      || (key !== sessionPath ? this._uiContextBySession.get(sessionPath) : null)
      || null;
  }

  // 向后兼容 getter
  get agentDir() { return this.agent?.agentDir || path.join(this.agentsDir, this.currentAgentId); }
  get baseDir() { return this.agentDir; }
  get activityDir() { return path.join(this.agentDir, "activity"); }
  get activityStore() { return this.getActivityStore(this.currentAgentId); }
  getActivityStore(agentId) { return this._agentMgr.getActivityStore(agentId); }

  get agents() { return this._agentMgr.agents; }
  listAgents(options = {}) { return this._agentMgr.listAgents(options); }
  listDeletedAgents() { return this._agentMgr.listDeletedAgents(); }
  isAgentDeleted(agentId) { return this._agentMgr.isAgentDeleted(agentId); }
  getDeletedAgentInfo(agentId) { return this._agentMgr.getDeletedAgentInfo(agentId); }
  invalidateAgentListCache() { this._agentMgr.invalidateAgentListCache(); }
  async createAgent(opts) { return this._agentMgr.createAgent(opts); }
  async switchAgent(agentId) {
    return this._agentMgr.switchAgent(agentId);
  }
  async deleteAgent(agentId) { return this._agentMgr.deleteAgent(agentId); }
  setPrimaryAgent(agentId) { return this._agentMgr.setPrimaryAgent(agentId); }
  agentIdFromSessionPath(p) { return this._agentMgr.agentIdFromSessionPath(p); }
  async createSessionForAgent(agentId, cwd, mem, model, opts: any = {}) {
    return this._agentMgr.createSessionForAgent(agentId, cwd, mem, model, opts);
  }

  // 向后兼容：agent 属性代理
  get agentName() { return this.agent.agentName; }
  set agentName(v) { this.agent.agentName = v; }
  get userName() { return this.agent.userName; }
  set userName(v) { this.agent.userName = v; }
  get configPath() { return this.agent.configPath; }
  get sessionDir() { return this.agent.sessionDir; }
  get factsDbPath() { return this.agent.factsDbPath; }
  get memoryMdPath() { return this.agent.memoryMdPath; }

  // ════════════════════════════
  //  Session 代理（→ SessionCoordinator）
  // ════════════════════════════

  get session() { return this._sessionCoord.session; }
  get messages() { return this._sessionCoord.session?.messages ?? []; }
  get isStreaming() { return this._sessionCoord.session?.isStreaming ?? false; }
  /** @ui-focus-only 返回 UI 焦点 session 的路径，后端逻辑不应依赖此值 */
  get currentSessionPath() { return this._sessionCoord.currentSessionPath; }
  get cwd() { return this._sessionCoord.session?.sessionManager?.getCwd?.() ?? process.cwd(); }
  get deskCwd() { return this._sessionCoord.session?.sessionManager?.getCwd?.() || this.homeCwd || null; }

  async createSession(mgr, cwd, mem, model, opts: any = {}) {
    return this._sessionCoord.createSession(mgr, cwd, mem, model, opts);
  }
  resolveSessionRef(ref, opts = {}) {
    if (!this._sessionManifestResolver) {
      const error: any = new Error("Session manifest store is unavailable.");
      error.code = "session_manifest_unavailable";
      error.status = 503;
      throw error;
    }
    return this._sessionManifestResolver.resolve(ref, opts);
  }
  getSessionManifest(sessionId) {
    return this._sessionManifestStore?.getBySessionId(sessionId) || null;
  }
  getSessionIdForPath(sessionPath) {
    if (!this._sessionManifestResolver) return null;
    try {
      return this._sessionManifestResolver.resolveOptional({ sessionPath })?.sessionId || null;
    } catch (error) {
      moduleLog.warn(`Session manifest lookup failed for ${path.basename(sessionPath || "")}: ${error?.message || error}`);
      return null;
    }
  }

  _openSessionManifestStore() {
    const dbPath = path.join(this.hanakoHome, "session-manifest.db");
    try {
      return new SessionManifestStore({ dbPath });
    } catch (error) {
      moduleLog.warn(`Session manifest store open failed: ${error?.message || error}`);
      let moved = [];
      try {
        moved = moveSessionManifestDbFilesAside({
          hanaHome: this.hanakoHome,
          suffix: `quarantine-${sanitizeSessionManifestFileSuffix(new Date().toISOString())}`,
        });
      } catch (moveError) {
        moduleLog.warn(`Session manifest quarantine failed: ${moveError?.message || moveError}`);
        this._sessionManifestStoreRecovery = { status: "unavailable", error, quarantineError: moveError };
        return null;
      }

      if (!moved.length) {
        this._sessionManifestStoreRecovery = { status: "unavailable", error, moved };
        return null;
      }

      try {
        const store = new SessionManifestStore({ dbPath });
        this._sessionManifestStoreRecovery = { status: "quarantined", error, moved };
        moduleLog.warn(`Session manifest database quarantined and recreated (${moved.length} files)`);
        return store;
      } catch (retryError) {
        moduleLog.warn(`Session manifest store reopen failed after quarantine: ${retryError?.message || retryError}`);
        this._sessionManifestStoreRecovery = { status: "unavailable", error: retryError, initialError: error, moved };
        return null;
      }
    }
  }

  _runSessionManifestStartupMigration() {
    if (!this._sessionManifestStore) {
      return {
        status: "unavailable",
        error: this._sessionManifestStoreRecovery?.error || null,
      };
    }
    try {
      const result = ensureLegacySessionManifestMigration({
        hanaHome: this.hanakoHome,
        store: this._sessionManifestStore,
        appVersion: this.appVersion,
      });
      if (result.status === "failed") {
        moduleLog.warn(`Session manifest startup migration failed: ${result.error?.message || "unknown error"}`);
      }
      return result;
    } catch (error) {
      moduleLog.warn(`Session manifest startup migration crashed: ${error?.message || String(error)}`);
      return {
        status: "failed",
        error,
      };
    }
  }
  async createDetachedSession( opts: any = {}) {
    return this._sessionCoord.createDetachedSession(opts);
  }
  buildSessionCacheSnapshot(p, opts) {
    return this._sessionCoord.buildSessionCacheSnapshot(p, opts);
  }
  getSessionStreamFn(p) {
    return this._sessionCoord.getSessionStreamFn(p);
  }
  async switchSession(p) {
    const result = await this._sessionCoord.switchSession(p);
    await this.syncWorkspaceSkillPaths(this.cwd, { reload: true, emitEvent: false });
    return result;
  }
  /** @deprecated Phase 2: 使用 promptSession(path, text, opts) */
  async prompt(text, opts) { return this._sessionCoord.prompt(text, opts); }
  /** @deprecated Phase 2: 使用 abortSession(path) */
  async abort(options) { return this._sessionCoord.abort(options); }
  /** @deprecated Phase 2: 使用 steerSession(path, text) */
  steer(text) { return this._sessionCoord.steer(text); }

  // ── Path 感知 API（Phase 2） ──
  async promptSession(p, text, opts) { return this._sessionCoord.promptSession(p, text, opts); }
  steerSession(p, text) { return this._sessionCoord.steerSession(p, text); }
  async abortSession(p, options) { return this._sessionCoord.abortSession(p, options); }
  get focusSessionPath() { return this._sessionCoord.currentSessionPath; }
  getMessages(p) { return this._sessionCoord.getSessionByPath(p)?.messages ?? []; }
  getSessionWorkspaceFolders(p = this.currentSessionPath) {
    return this._sessionCoord.getSessionWorkspaceFolders(p);
  }
  getSessionAuthorizedFolders(p = this.currentSessionPath) {
    return this._sessionCoord.getSessionAuthorizedFolders(p);
  }
  getSessionExecutorMetadata(ref) {
    return this._sessionCoord.getSessionExecutorMetadata(ref);
  }
  setSessionExecutorMetadata(ref, metadata, options = {}) {
    return this._sessionCoord.setSessionExecutorMetadata(ref, metadata, options);
  }
  getSessionMemoryReflectionSnapshot(p = this.currentSessionPath) {
    return this._sessionCoord.getSessionMemoryReflectionSnapshot(p);
  }
  getSessionFolderScope(p = this.currentSessionPath) {
    return this._sessionCoord.getSessionFolderScope(p);
  }
  getSessionMemoryEnabled(p = this.currentSessionPath) {
    return this._sessionCoord.getSessionMemoryEnabled(p);
  }
  async setSessionMemoryEnabled(p, enabled) {
    return this._sessionCoord.setSessionMemoryEnabled(p, enabled);
  }
  setSessionAuthorizedFolders(p, folders) {
    return this._sessionCoord.setSessionAuthorizedFolders(p, folders);
  }
  addSessionAuthorizedFolder(p, folder) {
    return this._sessionCoord.addSessionAuthorizedFolder(p, folder);
  }
  removeSessionAuthorizedFolder(p, folder) {
    return this._sessionCoord.removeSessionAuthorizedFolder(p, folder);
  }

  async abortAllStreaming() { return this._sessionCoord.abortAllStreaming(); }
  isBridgeSessionStreaming(key, opts) { return this._bridge?.isSessionStreaming(key, opts) ?? false; }
  async abortBridgeSession(key) { return this._bridge?.abortSession(key) ?? false; }
  steerBridgeSession(key, text, opts) { return this._bridge?.steerSession(key, text, opts) ?? false; }
  get bridgeSessionManager() { return this._bridge; }
  recordSessionCustomEntry(sessionPath, customType, data) {
    const bridgeResult = this._bridge?.recordCustomEntryForSessionPath?.(sessionPath, customType, data);
    if (bridgeResult?.ok) return bridgeResult;
    return this._sessionCoord.recordCustomEntry(sessionPath, customType, data);
  }
  getBridgeContextForSessionPath(sessionPath, opts: any = {}) {
    return this._bridge?.getBridgeContextForSessionPath?.(sessionPath, opts) || null;
  }
  async deliverNotification(payload, opts: any = {}) {
    return this._notifications.notify(payload, opts);
  }
  get slashRegistry() { return this._slashSystem?.registry ?? null; }
  get slashDispatcher() { return this._slashSystem?.dispatcher ?? null; }
  /** /rc 接管态 + pending-selection 内存 store（Phase 2-A） */
  get rcState() { return this._slashSystem?.rcState ?? null; }
  async closeSession(p) { return this._sessionCoord.closeSession(p); }
  async discardSessionRuntime(p, reason, options) { return this._sessionCoord.discardSessionRuntime(p, reason, options); }
  getSessionByPath(p) { return this._sessionCoord.getSessionByPath(p); }
  getSessionContextUsage(p) { return this._sessionCoord.getSessionContextUsage(p); }
  /** 确保桌面 session 已加载进 cache 但不改 UI 焦点（Phase 2-C：/rc 接管态用） */
  async ensureSessionLoaded(p) { return this._sessionCoord.ensureSessionLoaded(p); }
  async reloadSessionRuntime(p, opts = {}) { return this._sessionCoord.reloadSessionRuntime(p, opts); }
  /** #1624：当前应展示的"工具能力有更新"提示（无漂移 / 已 dismiss → null） */
  getSessionCapabilityDriftNotice(p) { return this._sessionCoord.getSessionCapabilityDriftNotice(p); }
  /** #1624：记录当前 fingerprint 已被用户关闭，持久化到 session-meta */
  async dismissSessionCapabilityDrift(p, fingerprint) { return this._sessionCoord.dismissSessionCapabilityDrift(p, fingerprint); }
  isSessionStreaming(p) { return this._sessionCoord.isSessionStreaming(p); }
  isSessionSwitching(p) { return this._sessionCoord.isSessionSwitching(p); }
  async abortSessionByPath(p, options) { return this._sessionCoord.abortSessionByPath(p, options); }
  async listSessions(options = {}) { return this._sessionCoord.listSessions(options); }
  async continueDeletedAgentSession(p) { return this._sessionCoord.continueDeletedAgentSession(p); }
  getSessionProjectCatalog() { return this._sessionProjects.getCatalog(); }
  createSessionProjectFolder(input) { return this._sessionProjects.createFolder(input); }
  updateSessionProjectFolder(id, patch) { return this._sessionProjects.updateFolder(id, patch); }
  deleteSessionProjectFolder(id) { return this._sessionProjects.deleteFolder(id); }
  reorderSessionProjectFolders(input) { return this._sessionProjects.reorderFolders(input); }
  createSessionProject(input) { return this._sessionProjects.createProject(input); }
  updateSessionProject(id, patch) { return this._sessionProjects.updateProject(id, patch); }
  async deleteSessionProject(id) {
    const projectId = normalizeSessionProjectId(id);
    if (!projectId) throw new Error("project not found");
    const sessions = await this._sessionCoord.listSessions();
    const affectedSessions = sessions.filter(sessionBelongsToProject(projectId));
    const catalog = this._sessionProjects.deleteProject(projectId);
    await Promise.all(affectedSessions.map(session => (
      this._sessionCoord.writeSessionMeta(session.path, { projectId: UNCATEGORIZED_PROJECT_ID })
    )));
    return {
      catalog,
      assignment: {
        projectId: UNCATEGORIZED_PROJECT_ID,
        sessionPaths: affectedSessions.map(session => session.path),
      },
    };
  }
  reorderSessionProjects(input) { return this._sessionProjects.reorderProjects(input); }
  normalizeSessionProjectAssignmentId(projectId) {
    const normalizedProjectId = normalizeSessionProjectId(projectId);
    if (!normalizedProjectId) return null;
    const catalog = this._sessionProjects.getCatalog();
    if (
      !isAutoProjectId(normalizedProjectId)
      && !catalog.projects.some(project => project.id === normalizedProjectId)
    ) {
      throw new Error("project not found");
    }
    return normalizedProjectId;
  }
  async setSessionProjectAssignment({ sessionPath, projectId }) {
    if (!sessionPath || typeof sessionPath !== "string") throw new Error("sessionPath is required");
    const normalizedProjectId = this.normalizeSessionProjectAssignmentId(projectId);
    await this._sessionCoord.writeSessionMeta(sessionPath, { projectId: normalizedProjectId });
    return { sessionPath, projectId: normalizedProjectId };
  }
  async listArchivedSessions() { return this._sessionCoord.listArchivedSessions(); }
  async saveSessionTitle(p, t) { return this._sessionCoord.saveSessionTitle(p, t); }
  async clearSessionTitle(p) { return this._sessionCoord.clearSessionTitle(p); }
  async setSessionPinned(p, pinned) { return this._sessionCoord.setSessionPinned(p, pinned); }
  async setSessionPluginMeta(p, patch) { return this._sessionCoord.setSessionPluginMeta(p, patch); }
  createSessionContext() { return this._sessionCoord.createSessionContext(); }
  async promoteActivitySession(f, agentId) { return this._sessionCoord.promoteActivitySession(f, agentId); }
  async executeIsolated(prompt, opts) { return this._sessionCoord.executeIsolated(prompt, opts); }

  // ════════════════════════════
  //  Config 代理（→ ConfigCoordinator）
  // ════════════════════════════

  get config() { return this.agent.config; }
  get factStore() { return this.agent.factStore; }
  /** 下一次新对话将使用的模型（UI 选择器绑定此值） */
  get currentModel() {
    return this._sessionCoord.pendingModel
      ?? this._models.currentModel;
  }
  /** 当前活跃 session 实际使用的模型（已创建的对话不随选择器变） */
  get activeSessionModel() {
    return this._sessionCoord.session?.model ?? null;
  }
  get availableModels() { return this._models.availableModels; }
  get memoryEnabled() {
    const sessionPath = this.currentSessionPath;
    return sessionPath ? this._sessionCoord.getSessionMemoryEnabled(sessionPath) : this.agent.memoryEnabled;
  }
  get memoryModelUnavailableReason() { return this.agent.memoryModelUnavailableReason; }
  get planMode() { return this._sessionCoord.getPlanMode(); }
  getPrimaryAgentId() { return this._prefs.getPrimaryAgent(); }
  get homeCwd() { return this.getHomeCwd(this.currentAgentId); }

  getHomeCwd(agentId) {
    return this._configCoord.getHomeFolder(agentId || this.currentAgentId) || null;
  }

  getExplicitHomeCwd(agentId) {
    return this._configCoord.getExplicitHomeFolder(agentId || this.currentAgentId) || null;
  }
  _createResourceLoaderOptions(skillsDir) {
    const cwd = resolveHanaPiProjectDir(this.hanakoHome);
    const agentDir = resolveHanaPiAgentDir(this.hanakoHome);
    if (!cwd || typeof cwd !== "string") {
      throw new Error("ResourceLoader init: cwd is required");
    }
    if (!agentDir || typeof agentDir !== "string") {
      throw new Error("ResourceLoader init: agentDir is required");
    }
    return {
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      systemPromptOverride: () => this.agent.systemPrompt,
      appendSystemPromptOverride: () => [],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      noContextFiles: true,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [skillsDir],
    };
  }
  get authStorage() { return this._models.authStorage; }
  get modelRegistry() { return this._models.modelRegistry; }
  get providerRegistry() { return this._models.providerRegistry; }
  get preferences() { return this._prefs; }

  /** 刷新可用模型列表（含 OAuth 自定义模型注入） */
  async refreshModels() { return this._models.refreshAvailable(); }

  getHomeFolder(agentId) { return this._configCoord.getHomeFolder(agentId); }
  setHomeFolder(agentId, folder) { return this._configCoord.setHomeFolder(agentId, folder); }
  getHeartbeatMaster() { return this._configCoord.getHeartbeatMaster(); }
  setHeartbeatMaster(v) { return this._configCoord.setHeartbeatMaster(v); }
  getChannelsEnabled() { return this._configCoord.getChannelsEnabled(); }
  async setChannelsEnabled(v) { return this._configCoord.setChannelsEnabled(v); }
  isChannelsEnabled() { return this._configCoord.getChannelsEnabled(); }
  getBridgePermissionMode() { return this._prefs.getBridgePermissionMode(); }
  setBridgePermissionMode(v) { return this._prefs.setBridgePermissionMode(v); }
  getAutomationPermissionMode() { return this._prefs.getAutomationPermissionMode(); }
  setAutomationPermissionMode(v) { return this._prefs.setAutomationPermissionMode(v); }
  getVscodeWorkbenchPreferences() { return this._prefs.getVscodeWorkbenchPreferences(); }
  setVscodeWorkbenchPreferences(v) { return this._prefs.setVscodeWorkbenchPreferences(v); }
  getVscodeWorkbenchEnabled() { return this._prefs.getVscodeWorkbenchEnabled(); }
  setVscodeWorkbenchEnabled(v) { return this._prefs.setVscodeWorkbenchEnabled(v); }
  getVscodeWorkbenchGalleryEnabled() { return this._prefs.getVscodeWorkbenchGalleryEnabled(); }
  setVscodeWorkbenchGalleryEnabled(v) { return this._prefs.setVscodeWorkbenchGalleryEnabled(v); }
  getVscodeWorkbenchExtensionAutoUpdate() { return this._prefs.getVscodeWorkbenchExtensionAutoUpdate(); }
  setVscodeWorkbenchExtensionAutoUpdate(v) { return this._prefs.setVscodeWorkbenchExtensionAutoUpdate(v); }
  getVscodeWorkbenchAppAutoUpdate() { return this._prefs.getVscodeWorkbenchAppAutoUpdate(); }
  setVscodeWorkbenchAppAutoUpdate(v) { return this._prefs.setVscodeWorkbenchAppAutoUpdate(v); }
  getVscodeWorkbenchFallbackToHanaOnFailure() { return this._prefs.getVscodeWorkbenchFallbackToHanaOnFailure(); }
  setVscodeWorkbenchFallbackToHanaOnFailure(v) { return this._prefs.setVscodeWorkbenchFallbackToHanaOnFailure(v); }
  getBridgeReadOnly() { return this._prefs.getBridgeReadOnly(); }
  setBridgeReadOnly(v) { this._prefs.setBridgeReadOnly(v); }
  getBridgeReceiptEnabled() { return this._prefs.getBridgeReceiptEnabled(); }
  setBridgeReceiptEnabled(v) { this._prefs.setBridgeReceiptEnabled(v); }
  getBridgeRichStreamingEnabled() { return this._prefs.getBridgeRichStreamingEnabled(); }
  setBridgeRichStreamingEnabled(v) { this._prefs.setBridgeRichStreamingEnabled(v); }
  setOutboundProxyRuntime(runtime) { this._outboundProxyRuntime = runtime || null; }
  getNetworkProxy() { return this._prefs.getNetworkProxy(); }
  setNetworkProxy(v) {
    const config = this._prefs.setNetworkProxy(v);
    this._outboundProxyRuntime?.apply?.(config);
    return config;
  }
  getBridgeMediaPublicBaseUrl() { return this._prefs.getBridgeMediaPublicBaseUrl(); }
  setBridgeMediaPublicBaseUrl(v) { return this._prefs.setBridgeMediaPublicBaseUrl(v); }
  getSharedModels() { return this._configCoord.getSharedModels(); }
  setSharedModels(p) { return this._configCoord.setSharedModels(p); }
  isVisionAuxiliaryEnabled() { return this.getSharedModels()?.vision_enabled === true; }
  getVisionBridge() { return this._visionBridge; }
  _ensureComputerRuntime() {
    if (!this.isComputerUseSupported()) {
      throw new Error("Computer Use is not supported on this platform.");
    }
    if (!this._computerProviders || !this._computerHost) {
      this._computerProviders = new ComputerProviderRegistry();
      this._computerProviders.register(createMockComputerProvider({ providerId: "mock" }));
      this._computerProviders.register(createMacosCuaProvider());
      this._computerProviders.register(createWindowsUiaProvider());
      this._computerHost = new ComputerHost({
        providers: this._computerProviders,
        defaultProviderId: "mock",
        getSettings: () => this.getComputerUseSettings(),
        getAccessMode: (sessionPath) => this._sessionCoord.getAccessMode(sessionPath),
        getPrimaryAgentId: () => this._prefs.getPrimaryAgent(),
      });
    }
    return { providers: this._computerProviders, host: this._computerHost };
  }
  getComputerHost() { return this._ensureComputerRuntime().host; }
  getComputerProviders() { return this._ensureComputerRuntime().providers; }
  isComputerUseSupported(platform = process.platform) { return isComputerUsePlatformSupported(platform); }
  getComputerUseSettings() {
    return effectiveComputerUseSettings(this._prefs.getComputerUseSettings(), { platform: process.platform });
  }
  setComputerUseSettings(partial) {
    if (!this.isComputerUseSupported() && partial?.enabled === true) {
      throw new Error("Computer Use is not supported on this platform.");
    }
    const settings = this._prefs.setComputerUseSettings(partial);
    const effectiveSettings = effectiveComputerUseSettings(settings, { platform: process.platform });
    if (effectiveSettings.enabled === true) this._ensureComputerRuntime();
    return effectiveSettings;
  }
  async updateComputerUseSettings(partial) {
    const effectiveSettings = this.setComputerUseSettings(partial);
    if (effectiveSettings.enabled !== true) {
      await this.disposeComputerRuntime();
    }
    return effectiveSettings;
  }
  async disposeComputerRuntime() {
    const host = this._computerHost;
    try {
      await host?.dispose?.();
    } finally {
      this._computerHost = null;
      this._computerProviders = null;
    }
  }
  approveComputerUseApp(approval) { return this._prefs.approveComputerUseApp(approval); }
  revokeComputerUseApp(approval) { return this._prefs.revokeComputerUseApp(approval); }
  resolveVisionConfig() {
    if (!this.isVisionAuxiliaryEnabled()) return null;
    const ref = this.getSharedModels()?.vision || null;
    if (!ref) return null;
    return this.resolveModelWithCredentials(ref);
  }
  getSearchConfig() { return this._configCoord.getSearchConfig(); }
  setSearchConfig(p) { return this._configCoord.setSearchConfig(p); }
  getUtilityApi() { return this._configCoord.getUtilityApi(); }
  setUtilityApi(p) { return this._configCoord.setUtilityApi(p); }
  resolveUtilityConfig( options: any = {}) {
    const resolvedOptions = { ...(options || {}) };
    if (!resolvedOptions.agentId && resolvedOptions.sessionPath) {
      const ownerAgentId = this.agentIdFromSessionPath(resolvedOptions.sessionPath);
      if (ownerAgentId) resolvedOptions.agentId = ownerAgentId;
    }
    const config = this._configCoord.resolveUtilityConfig(resolvedOptions);
    let usageSessionId = resolvedOptions.sessionId || null;
    if (!usageSessionId && resolvedOptions.sessionPath) {
      try {
        usageSessionId = this.getSessionIdForPath?.(resolvedOptions.sessionPath) || null;
      } catch {
        usageSessionId = null;
      }
    }
    return {
      ...config,
      usageLedger: this._usageLedger,
      usageAgentId: resolvedOptions.agentId || this.currentAgentId || null,
      usageSessionPath: resolvedOptions.sessionPath || null,
      usageSessionId,
    };
  }
  _callApprovalReviewerText(options) { return callText(options); }
  resolveUtilityConfigForAgent(agentId) { return this.resolveUtilityConfig({ agentId }); }
  readAgentOrder() { return this._configCoord.readAgentOrder(); }
  saveAgentOrder(o) { return this._configCoord.saveAgentOrder(o); }
  async syncModelsAndRefresh() { return this._configCoord.syncAndRefresh(); }
  setPendingModel(id, provider) { return this._configCoord.setPendingModel(id, provider); }
  async switchSessionModel(sessionPath, modelId, provider) {
    if (!provider) {
      throw new Error(`switchSessionModel: provider required (modelId=${modelId})`);
    }
    const model = findModel(this._models.availableModels, modelId, provider);
    if (!model) throw new Error(t("error.modelNotFound", { id: `${provider}/${modelId}` }));
    return this._sessionCoord.switchSessionModel(sessionPath, model);
  }
  async setDefaultModel(id, provider, opts) { return this._configCoord.setDefaultModel(id, provider, opts); }
  getThinkingLevel() { return this._configCoord.getThinkingLevel(); }
  setThinkingLevel(l) { return this._configCoord.setThinkingLevel(l); }
  getDefaultThinkingLevel() { return this._sessionCoord.getDefaultThinkingLevel(); }
  setDefaultThinkingLevel(l) { return this._sessionCoord.setDefaultThinkingLevel(l); }
  getSessionThinkingLevel(sessionPath) { return this._sessionCoord.getSessionThinkingLevel(sessionPath); }
  setSessionThinkingLevel(sessionPath, level) { return this._sessionCoord.setSessionThinkingLevel(sessionPath, level); }
  getSandbox() { return this._prefs.getSandbox(); }
  setSandbox(v) { this._prefs.setSandbox(v); }
  startWin32LegacySandboxMaintenance() {
    this._win32LegacySandboxCleanupQueue?.enqueueProfileCleanup?.();
  }
  getSandboxNetwork() {
    if (process.platform === "win32") return true;
    return this._prefs.getSandboxNetwork();
  }
  setSandboxNetwork(v) {
    const enabled = typeof v === "string" ? v === "true" : !!v;
    if (process.platform === "win32" && !enabled) {
      throw new Error("Windows command sandbox does not support network isolation; sandboxed commands keep network access.");
    }
    this._prefs.setSandboxNetwork(enabled);
  }
  getHardwareAcceleration() { return this._prefs.getHardwareAcceleration(); }
  setHardwareAcceleration(v) { this._prefs.setHardwareAcceleration(v); }
  getFileBackup() { return this._prefs.getFileBackup(); }
  setFileBackup(p) { this._prefs.setFileBackup(p); }
  listCheckpoints() { return this._checkpointStore.list(); }
  restoreCheckpoint(id) { return this._checkpointStore.restore(id); }
  removeCheckpoint(id) { return this._checkpointStore.remove(id); }
  async createUserEditCheckpoint({ filePath, reason = "edit-start" }) {
    const cfg = this._prefs.getFileBackup();
    const id = await this._checkpointStore.save({
      sessionPath: null,
      tool: "user-edit",
      source: "user-edit",
      reason,
      filePath,
      maxSizeKb: cfg.max_file_size_kb || 1024,
    });
    return id ? { id, path: filePath, reason } : null;
  }
  cleanupCheckpoints() {
    const cfg = this._prefs.getFileBackup();
    return this._checkpointStore.cleanup(cfg.retention_days || 1);
  }
  getLearnSkills() { return this._prefs.getLearnSkills(); }
  setLearnSkills(p) { this._prefs.setLearnSkills(p); }
  getLocale() { return this._prefs.getLocale(); }
  setLocale(l) { this._prefs.setLocale(l); }
  getSetupComplete() { return this._prefs.getSetupComplete(); }
  markSetupComplete() { return this._prefs.markSetupComplete(); }
  getEditor() { return this._prefs.getEditor(); }
  setEditor(p) { return this._prefs.setEditor(p); }
  getAppearance() { return this._prefs.getAppearance(); }
  setAppearance(p) { return this._prefs.setAppearance(p); }
  getNotificationPreferences() { return this._prefs.getNotificationPreferences(); }
  setNotificationPreferences(p) { return this._prefs.setNotificationPreferences(p); }
  getQuickChatPreferences() { return this._prefs.getQuickChatPreferences(); }
  setQuickChatPreferences(p) { return this._prefs.setQuickChatPreferences(p); }
  getBrowserPreferences() { return this._prefs.getBrowserPreferences(); }
  setBrowserPreferences(p) { return this._prefs.setBrowserPreferences(p); }
  getWorkspaceUiState(workspaceRoot, surface) { return this._prefs.getWorkspaceUiState(workspaceRoot, surface); }
  setWorkspaceUiState(workspaceRoot, surface, state) { return this._prefs.setWorkspaceUiState(workspaceRoot, surface, state); }
  gcWorkspacePersistence( options: any = {}) {
    const configResults = options?.agentId
      ? [this._configCoord.gcWorkspaceConfig(options.agentId, options)]
      : this._configCoord.gcAllWorkspaceConfigs(options);
    const workspaceUiState = this._prefs.gcWorkspaceUiState(options);
    return { configResults, workspaceUiState };
  }
  getSidebarUiPrefs() { return this._prefs.getSidebarUiPrefs(); }
  setSidebarUiPrefs(partial) { return this._prefs.setSidebarUiPrefs(partial); }
  getPluginUiPrefs() { return this._prefs.getPluginUiPrefs(); }
  setPluginUiPrefs(partial) { return this._prefs.setPluginUiPrefs(partial); }
  getPluginDevToolsEnabled() { return this._prefs.getPluginDevToolsEnabled(); }
  setPluginDevToolsEnabled(value) { return this._prefs.setPluginDevToolsEnabled(value); }
  getPluginInstallRecord(pluginId) { return this._pluginInstallRecords.get(pluginId); }
  recordPluginInstall(record) { return this._pluginInstallRecords.recordInstall(record); }
  removePluginInstallRecord(pluginId) { return this._pluginInstallRecords.remove(pluginId); }
  getTimezone() { return this._prefs.getTimezone(); }
  setTimezone(tz) { this._prefs.setTimezone(tz); }
  getKeepAwake() { return this._prefs.getKeepAwake(); }
  setKeepAwake(v) { this._prefs.setKeepAwake(v); }
  setMemoryEnabled(v) { return this._configCoord.setMemoryEnabled(v); }
  setMemoryMasterEnabled(id, v) { return this._configCoord.setMemoryMasterEnabled(id, v); }
  persistSessionMeta() { return this._configCoord.persistSessionMeta(); }
  get permissionMode() { return this._sessionCoord.getPermissionMode(); }
  getSessionPermissionMode(sessionPath) { return this._sessionCoord.getPermissionMode(sessionPath); }
  setSessionPermissionMode(mode) { return this._sessionCoord.setPermissionMode(mode); }
  setSessionPermissionModeForSession(sessionPath, mode, options) { return this._sessionCoord.setSessionPermissionMode(sessionPath, mode, options); }
  setCurrentSessionPermissionMode(mode) { return this._sessionCoord.setCurrentSessionPermissionMode(mode); }
  setPendingSessionPermissionMode(mode) { return this._sessionCoord.setPendingPermissionMode(mode); }
  getSessionPermissionModeDefault() { return this._sessionCoord.getPermissionModeDefault(); }
  setSessionPermissionModeDefault(mode) { return this._sessionCoord.setPermissionModeDefault(mode); }
  get accessMode() { return this._sessionCoord.getAccessMode(); }
  setAccessMode(mode) { return this._sessionCoord.setAccessMode(mode); }
  setPlanMode(enabled) { return this._sessionCoord.setPlanMode(enabled); }
  async updateConfig(p, opts) { return this._configCoord.updateConfig(p, opts); }

  getPreferences() { return this._readPreferences(); }
  savePreferences(p) { return this._writePreferences(p); }

  // ════════════════════════════
  //  Channel 代理（→ ChannelManager）
  // ════════════════════════════

  async createChannelEntry(input) { return this._channels.createChannelEntry(input); }
  async deleteChannelByName(n) { return this._channels.deleteChannelByName(n); }
  async triggerChannelDelivery(n, o) { return this._channels.triggerChannelDelivery(n, o); }
  async triggerChannelTriage(n, o) { return this.triggerChannelDelivery(n, o); }

  // ════════════════════════════
  //  Bridge 代理（→ BridgeSessionManager）
  // ════════════════════════════

  getBridgeIndex(agentId) {
    const agent = agentId ? this.getAgent(agentId) : undefined;
    return this._bridge.readIndex(agent);
  }
  saveBridgeIndex(i, agentId) {
    const agent = agentId ? this.getAgent(agentId) : undefined;
    return this._bridge.writeIndex(i, agent);
  }
  async executeExternalMessage(p, sk, m, o) { return this._bridge.executeExternalMessage(p, sk, m, o); }
  injectBridgeMessage(sk, t) { return this._bridge.injectMessage(sk, t); }
  /** 对指定 bridge session 执行真正的上下文压缩；返回 { tokensBefore, tokensAfter, contextWindow } */
  async compactBridgeSession(sessionKey, opts) { return this._bridge.compactSession(sessionKey, opts); }
  async freshCompactBridgeSession(sessionKey, opts) { return this._bridge.freshCompactSession(sessionKey, opts); }
  /**
   * 对桌面 session 做上下文压缩；返回 { tokensBefore, tokensAfter, contextWindow }
   * 供 /compact 在 /rc 接管态下给出 token delta 反馈（Phase 2-E）
   */
  async compactDesktopSession(sessionPath) {
    let session = this.getSessionByPath(sessionPath);
    if (!session) throw new Error("compactDesktopSession: session not found");
    if (session.isCompacting) throw new Error("compactDesktopSession: already compacting");
    let before = session.getContextUsage?.() ?? null;
    try {
      await compactSessionWithCachePreservation(session, undefined);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
      session = await this.reloadSessionRuntime(sessionPath);
      if (!session) throw error;
      if (session.isCompacting) throw new Error("compactDesktopSession: already compacting");
      before = session.getContextUsage?.() ?? before;
      await compactSessionWithCachePreservation(session, undefined);
    }
    const after = session.getContextUsage?.() ?? null;
    return {
      tokensBefore: before?.tokens ?? null,
      tokensAfter: after?.tokens ?? null,
      contextWindow: after?.contextWindow ?? before?.contextWindow ?? null,
    };
  }

  /**
   * #1624 显式刷新（fresh compact）：把旧对话压缩成 compact checkpoint，然后用
   * 当前 agent 配置重建 system prompt snapshot + 工具快照重启 session runtime。
   * 这是用户显式触发的升级动作——不点刷新的 session 永远保持冻结快照不变。
   *
   * "Already compacted / Nothing to compact" 视为 noop（快照仍然刷新），
   * 与 bridge fresh compact 的 markFreshCompactSatisfied 语义一致。
   */
  async freshCompactDesktopSession(sessionPath) {
    let session = this.getSessionByPath(sessionPath) || await this.ensureSessionLoaded(sessionPath);
    if (!session) throw new Error("freshCompactDesktopSession: session not found");
    if (session.isCompacting) throw new Error("freshCompactDesktopSession: already compacting");
    if (this.isSessionStreaming(sessionPath)) {
      throw new Error("freshCompactDesktopSession: session is streaming, try again after the reply completes");
    }
    let before = session.getContextUsage?.() ?? null;
    let noopReason = null;
    try {
      await compactSessionWithCachePreservation(session, undefined);
    } catch (error) {
      if (isStaleExtensionContextError(error)) {
        session = await this.reloadSessionRuntime(sessionPath);
        if (!session) throw error;
        if (session.isCompacting) throw new Error("freshCompactDesktopSession: already compacting");
        before = session.getContextUsage?.() ?? before;
        try {
          await compactSessionWithCachePreservation(session, undefined);
        } catch (retryError) {
          noopReason = getFreshCompactNoopReason(retryError);
          if (!noopReason) throw retryError;
        }
      } else {
        noopReason = getFreshCompactNoopReason(error);
        if (!noopReason) throw error;
      }
    }
    const after = session.getContextUsage?.() ?? null;
    // 压缩完成后整体重建 runtime：restore 路径按当前配置重算 prompt/tool 快照并写回 session-meta
    await this._sessionCoord.reloadSessionRuntime(sessionPath, { refreshCapabilitySnapshots: true });
    return {
      tokensBefore: before?.tokens ?? null,
      tokensAfter: noopReason ? (before?.tokens ?? null) : (after?.tokens ?? null),
      contextWindow: after?.contextWindow ?? before?.contextWindow ?? null,
      fresh: true,
      noopReason,
    };
  }

  // ════════════════════════════
  //  Skills（→ SkillManager）
  // ════════════════════════════

  _syncAgentSkills() { this._skills.syncAgentSkills(this.agent); }
  _syncAllAgentSkills() { for (const ag of this._agentMgr.agents.values()) this._skills.syncAgentSkills(ag); }
  getAllSkills(agentId) {
    // 不接受 fallback 到 this.agent — 调用方必须显式指定 agentId，
    // 否则前后端 agent 错位会导致 desk skill toggle 把错位列表写入当前 agent (#397)
    if (!agentId) throw new Error("getAllSkills requires explicit agentId");
    const ag = this._agentMgr.getAgent(agentId);
    if (!ag) throw new Error(`agent not found: ${agentId}`);
    return this._skills.getAllSkills(ag);
  }
  getRuntimeSkills(agentId) {
    if (!agentId) throw new Error("getRuntimeSkills requires explicit agentId");
    const ag = this._agentMgr.getAgent(agentId);
    if (!ag) throw new Error(`agent not found: ${agentId}`);
    return this._skills.getRuntimeSkillInfos(ag);
  }
  _getSkillsForAgent(ag) { return this._skills.getSkillsForAgent(ag); }
  get skillsDir() { return this._skills?.skillsDir; }
  get userSkillsDir() { return this._skills?.skillsDir; }
  get modelsJsonPath() { return this._models.modelsJsonPath; }
  get authJsonPath() { return this._models.authJsonPath; }

  async reloadSkills() {
    await this._skills.reload(this._resourceLoader, this._agentMgr.agents);
    this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
    this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);
    this._syncAllAgentSkills();
  }

  /** 获取外部技能路径配置（供 API 使用） */
  getExternalSkillPaths() {
    // 刷新 exists 状态，检测运行期间新增的目录
    let newDirAppeared = false;
    for (const d of this._discoveredExternalPaths || []) {
      const nowExists = fs.existsSync(d.dirPath);
      if (nowExists && !d.exists) newDirAppeared = true;
      d.exists = nowExists;
    }
    // 运行期间有新目录出现：重新集成到 SkillManager（watcher + 扫描）
    if (newDirAppeared) {
      this.syncWorkspaceSkillPaths(this.currentSessionPath ? this.cwd : null, {
        reload: true,
        emitEvent: true,
        agentId: this.currentAgentId || null,
      }).catch(() => {});
    }
    return {
      configured: this._prefs.getExternalSkillPaths(),
      discovered: this._discoveredExternalPaths || [],
    };
  }

  /** 更新外部技能路径 + 同步 ResourceLoader + 重载 */
  async setExternalSkillPaths(paths) {
    this._prefs.setExternalSkillPaths(paths);
    await this.syncWorkspaceSkillPaths(this.currentSessionPath ? this.cwd : null, {
      reload: true,
      emitEvent: true,
      agentId: this.currentAgentId || null,
    });
  }

  /** 合并自动发现 + 用户配置的外部路径（去重） */
  _mergeExternalPaths(userConfiguredPaths, extraPaths = []) {
    // 每次合并时重新检测目录是否存在（不依赖初始化快照）
    for (const d of this._discoveredExternalPaths || []) {
      d.exists = fs.existsSync(d.dirPath);
    }
    const discovered = (this._discoveredExternalPaths || [])
      .filter(d => d.exists)
      .map(d => ({ dirPath: d.dirPath, label: d.label }));
    const userParsed = (userConfiguredPaths || []).map(p => ({
      dirPath: path.resolve(p),
      label: path.basename(path.dirname(p)),
    }));
    const merged = [...discovered];
    const seen = new Set(merged.map(m => m.dirPath));
    for (const up of [...userParsed, ...extraPaths]) {
      if (seen.has(up.dirPath)) continue;
      merged.push(up);
      seen.add(up.dirPath);
    }
    return merged;
  }

  _getWorkspaceExternalSkillPaths(cwd) {
    return resolveWorkspaceSkillPaths(cwd);
  }

  _getResolvedExternalSkillPaths(cwd) {
    const pluginPaths = this._pluginManager?.getSkillPaths?.() || [];
    const workspacePaths = this._getWorkspaceExternalSkillPaths(cwd);
    return this._mergeExternalPaths(this._prefs.getExternalSkillPaths(), [
      ...pluginPaths,
      ...workspacePaths,
    ]);
  }

  _sameExternalSkillPaths(a = [], b = []) {
    if (a.length !== b.length) return false;
    return a.every((entry, index) => {
      const other = b[index];
      return entry?.dirPath === other?.dirPath
        && entry?.label === other?.label
        && (entry?.scope || "") === (other?.scope || "");
    });
  }

  async syncWorkspaceSkillPaths(cwd = null, options: any = {}) {
    const {
      reload = true,
      emitEvent = false,
      force = false,
      agentId = this._agentMgr?.activeAgentId || null,
    } = options;
    if (!this._skills) return false;
    const resolved = this._getResolvedExternalSkillPaths(cwd);
    const changed = !this._sameExternalSkillPaths(this._skills._externalPaths || [], resolved);
    if (!changed && !force) return false;

    this._skills.setExternalPaths(resolved);
    if (reload) await this.reloadSkills();
    if (emitEvent) this._emitAppEvent("skills-changed", { agentId: agentId || null });
    return true;
  }

  // ════════════════════════════
  //  Model 代理
  // ════════════════════════════

  _resolveThinkingLevel(l) { return this._models.resolveThinkingLevel(l); }
  _resolveExecutionModel(r) { return this._models.resolveExecutionModel(r); }
  _resolveProviderCredentials(p) { return this._models.resolveProviderCredentials(p); }
  resolveProviderCredentials(p) { return this._resolveProviderCredentials(p); }
  resolveProviderCredentialsFresh(p) { return this._models.resolveProviderCredentialsFresh(p); }
  resolveModelWithCredentials(ref) { return this._models.resolveModelWithCredentials(ref); }
  async refreshAvailableModels() { return this._models.refreshAvailable(); }
  /**
   * Provider 配置变更后的统一操作序列。
   * reload registry → sync models.json → refresh available → normalize utility prefs
   * → 通知 active session 重新解析 model 对象（baseUrl 等字段烤在对象上）
   */
  async onProviderChanged() {
    await this._models.reloadAndSync();
    this._configCoord.normalizeUtilityApiPreferences();
    this._sessionCoord.refreshAllSessionsModels();
  }
  getRegistryModelsForProvider(name) { return this._models.getRegistryModelsForProvider(name); }

  static SHARED_MODEL_KEYS = SHARED_MODEL_KEYS;

  // ════════════════════════════
  //  生命周期
  // ════════════════════════════

  async init(log: any = () => {}) {
    const startupTimer = Date.now();

    // 0. Config scope 迁移（全局字段从 agent config → preferences）
    migrateConfigScope({
      agentsDir: this.agentsDir,
      prefs: this._prefs,
      primaryAgentId: this._prefs.getPrimaryAgent(),
      log,
    });

    // 0b. Provider 迁移（旧数据 → added-models.yaml，只跑一次）
    migrateToProvidersYaml(this.hanakoHome, this.agentsDir, log);

    // 0b2. Provider media 迁移（旧 type:image 模型 → media.image_generation）
    migrateProviderMediaConfig(this.hanakoHome, log);

    // 0c. Model overrides 迁移（config.models.overrides → added-models.yaml，只跑一次）
    this._models.providerRegistry.migrateOverridesToAddedModels(this.agentsDir, log);

    // 0d. 统一数据迁移（版本号驱动，新迁移统一加在 migrations.js）
    runMigrations({
      hanakoHome: this.hanakoHome,
      agentsDir: this.agentsDir,
      prefs: this._prefs,
      providerRegistry: this._models.providerRegistry,
      log,
    });
    this._runtimeContext = createServerRuntimeContext({
      hanakoHome: this.hanakoHome,
      appVersion: this.appVersion,
    });
    this._resources = new ResourceService({
      agentsDir: this.agentsDir,
      sessionFiles: this._sessionFiles,
      runtimeContext: this._runtimeContext,
    });
    this._resourceAccess = new ResourceAccessService({
      resourceService: this._resources,
      audit: (event) => appendSecurityAuditEvent(this.hanakoHome, event),
    });

    // 频道初始化和 agent 构造会调用 server-side i18n。locale 是 global
    // preference，必须在任何会写持久化文案的初始化逻辑前加载。
    loadLocale(this._prefs.getLocale());

    // 1. Pi SDK + 模型基础设施（必须在 agent init 之前，agent 需要解析记忆模型）
    log(`[init] 1/5 Pi SDK 初始化...`);
    this._models.init();
    // 预填充 _availableModels，agent init 时需要解析 utility model
    await this._models.refreshAvailable();
    log(`[init] 1/5 AuthStorage + ModelRegistry + ${this._models.availableModels.length} 个模型就绪`);

    // 2. 初始化所有 agent
    log(`[init] 2/5 初始化所有 agent...`);
    await this._agentMgr.initAllAgents(log, this._agentMgr.activeAgentId);
    log(`[init] 2/5 ${this._agentMgr.agents.size} 个 agent 已就绪`);

    // 2b. 补齐频道游标投影（老用户升级兼容）。
    // repairChannelCursorProjection 扫描所有频道，为每个"已是成员且有 config"
    // 的 agent 把缺失的 last-read cursor 补进 channels.md，是按成员真相源
    // 重建投影的单一入口，覆盖缺 channels.md 的老 agent。
    await this._channels.repairChannelCursorProjection();

    // 3. ResourceLoader + Skills
    log(`[init] 3/5 ResourceLoader 初始化...`);
    const t_rl = Date.now();
    const skillsDir = path.join(this.hanakoHome, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // 解析外部兼容技能路径
    const homeDir = os.homedir();
    this._discoveredExternalPaths = WELL_KNOWN_SKILL_PATHS.map(w => ({
      dirPath: path.join(homeDir, w.suffix),
      label: w.label,
      exists: fs.existsSync(path.join(homeDir, w.suffix)),
    }));
    const externalPaths = this._getResolvedExternalSkillPaths(null);

    this._skills = new SkillManager({ skillsDir, externalPaths });
    this._coreExtensionFactories = [
      /**
       * Provider payload 兼容化（chat 路径）。与 callText 共享 core/provider-compat.js，
       * 是两条调用路径唯一的 normalize 入口——末端只在"流式 vs 非流式 fetch"分叉。
       *
       * ctx.model 是 Pi SDK 标准入参，正常 chat session 都会带；少数 edge case
       * （子 session / 工具内调）下偏 SDK 实现可能不带，此时只在 payload.model
       * 唯一匹配时补 model；重复 id 直接不猜 provider，避免错套 provider 兼容。
       */
      (pi) => {
        pi.on("context", (event, ctx) => {
          const model = ctx?.model;
          if (!model) return;
          const reasoningLevel = resolveRequestReasoningLevel(this._models, this._prefs, ctx);
          const messages = normalizeProviderContextMessages(event.messages, model, {
            mode: "chat",
            reasoningLevel,
          });
          if (messages === event.messages) return;
          return { messages };
        });

        pi.on("before_provider_request", (event, ctx) => {
          const p = event.payload;
          if (!p) return p;
          const requestModel = ctx?.model
            || findUniqueModelById(this._models.availableModels, p.model)
            || null;
          const reasoningLevel = resolveRequestReasoningLevel(this._models, this._prefs, ctx);
          const sessionPath = ctx?.sessionManager?.getSessionFile?.() || null;
          const deepseekRoleplayReasoningPatch = this._sessionCoord
            .isDeepSeekRoleplayReasoningPatchEnabled(sessionPath);
          const deepseekRoleplayReasoningContext = this._sessionCoord
            .getDeepSeekRoleplayReasoningContext(sessionPath);
          // The SDK hook exposes the serialized body, but not whether maxTokens came
          // from user intent or buildBaseOptions' model-derived default. Keep source
          // unspecified here; output-budget removes only values matching that SDK default.
          return normalizeProviderPayload(p, requestModel, {
            mode: "chat",
            reasoningLevel,
            deepseekRoleplayReasoningPatch,
            deepseekRoleplayReasoningContext,
          });
        });
      },
      /**
       * Capability-aware message adaptation：把历史里的 ImageContent block
       * 替换为 TextContent 占位，避免不支持 image 的 provider 反序列化失败
       * （如 issue #441：messages[N]: unknown variant `image_url`, expected `text`）。
       * 非静默降级：每个 session 首次剥图时通过事件总线通知 UI。
       */
      (pi) => {
        pi.on("context", (event, ctx) => {
          const model = ctx?.model;
          if (!model) return;
          const sessionPath = ctx?.sessionManager?.getSessionFile?.();
          const replaySafe = stripHistoricalInlineMediaForReplay(event.messages);
          const sessionRef = typeof this._sessionRefForPathSafe === "function"
            ? this._sessionRefForPathSafe(sessionPath)
            : { sessionId: null, sessionPath };
          const currentTurnMedia = this._currentTurnNativeMedia.inject(sessionRef, replaySafe.messages);
          const { messages, stripped, strippedImages, strippedVideos } = sanitizeMessagesForModel(currentTurnMedia.messages, model);
          if (replaySafe.stripped === 0 && stripped === 0 && !currentTurnMedia.changed) return;
          const sessionRuntimeKey = sessionPath ? this._sessionRuntimeKeyForPath(sessionPath) : null;
          if (sessionRuntimeKey && strippedImages > 0 && !this._imageStripNotified.has(sessionRuntimeKey)) {
            this._imageStripNotified.add(sessionRuntimeKey);
            this._emitEvent({
              type: "image_stripped_notice",
              modelId: model.id,
              modelProvider: model.provider,
              count: strippedImages,
            }, sessionPath);
          }
          if (sessionRuntimeKey && strippedVideos > 0 && !this._videoStripNotified.has(sessionRuntimeKey)) {
            this._videoStripNotified.add(sessionRuntimeKey);
            this._emitEvent({
              type: "video_stripped_notice",
              modelId: model.id,
              modelProvider: model.provider,
              count: strippedVideos,
            }, sessionPath);
          }
          return { messages };
        });
      },
    ];
    this._extensionFactories = [...this._coreExtensionFactories];
    this._resourceLoader = new DefaultResourceLoader({
      ...this._createResourceLoaderOptions(skillsDir),
      extensionFactories: this._extensionFactories,
    });
    await this._resourceLoader.reload();

    const HIDDEN_SKILLS = new Set(["canvas-design", "skill-creator", "skills-translate-temp"]);
    this._skills.init(this._resourceLoader, this._agentMgr.agents, HIDDEN_SKILLS);
    const extCount = this._skills.allSkills.filter(s => s.source === "external").length;
    log(`[init] 3/5 ResourceLoader 完成 (${Date.now() - t_rl}ms, ${this._skills.allSkills.length} skills${extCount ? `, ${extCount} external` : ""})`);

    this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
    this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);

    // 4. 模型发现
    log(`[init] 4/5 发现可用模型...`);
    try { await this.syncModelsAndRefresh(); } catch (err) { moduleLog.warn(`[init] syncModelsAndRefresh failed: ${err?.message}`); }
    await this._models.refreshAvailable();
    this._configCoord.normalizeUtilityApiPreferences(log);
    const availableModels = this._models.availableModels;
    log(`[init] 4/5 找到 ${availableModels.length} 个模型: ${availableModels.map(m => `${m.provider}/${m.id}`).join(", ")}`);
    if (availableModels.length === 0) {
      moduleLog.warn("⚠ 未找到可用模型，请在设置中配置 API key");
      this._models.defaultModel = null;
    } else {
      // migrations #5 之后 models.chat 必为 {id, provider} 对象；
      // 非对象说明 agent 从未配置过或 migration 未识别（added-models.yaml 里
      // 没对应 provider），保守视为未配置。
      const chatRef = this.agent.config.models?.chat;
      const ref = (typeof chatRef === "object" && chatRef?.id && chatRef?.provider) ? chatRef : null;
      if (!ref) {
        moduleLog.warn("⚠ 未配置 models.chat（或配置缺 provider），defaultModel 为 null");
        this._models.defaultModel = null;
      } else {
        const model = findModel(availableModels, ref.id, ref.provider);
        if (!model) {
          moduleLog.error(`⚠ 配置的模型 "${ref.provider}/${ref.id}" 不在可用列表中，defaultModel 为 null`);
          this._models.defaultModel = null;
        } else {
          this._models.defaultModel = model;
          log(`✿ 使用模型: ${model.name} (${model.provider})`);
        }
      }
    }

    // 5. Sync skills + watch skillsDir
    this._syncAllAgentSkills();
    this._skills.watch(this._resourceLoader, this._agentMgr.agents, () => {
      this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
      this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);
      this._syncAllAgentSkills();
      this._emitAppEvent("skills-changed", { agentId: null });
    });

    // 7. Bridge 孤儿清理
    try { this._bridge.reconcile(); } catch (err) { moduleLog.warn(`[init] bridge reconcile failed: ${err?.message}`); }

    // 8. 沙盒日志
    const sandboxEnabled = this._readPreferences().sandbox !== false;
    log(`✿ 沙盒${sandboxEnabled ? "已启用" : "已关闭"}`);

    // 9. 清理过期的 .ephemeral session 文件（>7 天）
    this._cleanEphemeralSessions();

    const totalTime = ((Date.now() - startupTimer) / 1000).toFixed(1);
    log(`✿ 初始化完成（${totalTime}s）`);
  }

  /** 清理所有 agent 的 .ephemeral/ 目录中超过 7 天的文件 */
  _cleanEphemeralSessions() {
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    try {
      if (!this.agentsDir || !fs.existsSync(this.agentsDir)) return;
      for (const entry of fs.readdirSync(this.agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const ephDir = path.join(this.agentsDir, entry.name, '.ephemeral');
        if (!fs.existsSync(ephDir)) continue;
        for (const file of fs.readdirSync(ephDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = path.join(ephDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > maxAge) fs.unlinkSync(filePath);
          } catch {
            // 过期 ephemeral 文件清理 best-effort：单个文件 stat/unlink 失败跳过即可，下次启动再试。
          }
        }
      }
    } catch {
      // 整体清理 best-effort：扫描 agents 目录失败不应阻塞 init 后续步骤。
    }
  }

  async dispose() {
    try {
      // 先卸载 plugins（它们可能依赖 engine 资源）
      if (this._pluginManager) {
        for (const p of this._pluginManager.listPlugins()) {
          if (p.status === "loaded") {
            await this._pluginManager.unloadPlugin(p.id, { pluginKey: p.pluginKey });
          }
        }
      }
      this._pluginDevEventBusCleanup?.();
      this._pluginDevEventBusCleanup = null;
      this._media?.dispose?.();
      this._skills?.unwatch();
      this._deferredResultCoordinator?.dispose?.();
      this._deferredResultCoordinator = null;
      await this._agentMgr.disposeAll(this._sessionCoord);
      await this._sessionCoord.cleanupSession();
    } finally {
      try {
        await this.disposeComputerRuntime();
      } finally {
        this._sessionManifestStore?.close?.();
      }
    }
  }

  // ════════════════════════════
  //  插件系统
  // ════════════════════════════

  /**
   * Initialize plugin system. Called after Hub construction (EventBus available).
   * @param {import('../hub/event-bus.ts').EventBus} bus
   */
  async initPlugins(bus) {
    this._media?.start?.(bus);
    const builtinPluginsDir = path.join(this.productDir, "..", "plugins");
    const userPluginsDir = path.join(this.hanakoHome, "plugins");
    const devPluginsDir = path.join(this.hanakoHome, "plugins-dev");
    const pluginDevRunsDir = path.join(this.hanakoHome, "plugin-dev-runs");
    const pluginDevSourcesDir = path.join(this.hanakoHome, "plugin-dev-sources");
    const pluginDataDir = path.join(this.hanakoHome, "plugin-data");
    fs.mkdirSync(pluginDevSourcesDir, { recursive: true });

    // Read app version for plugin compatibility check
    let appVersion = "0.0.0";
    try {
      const pkgPath = path.join(this.productDir, "..", "package.json");
      appVersion = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version || "0.0.0";
    } catch {
      // package.json 缺失/损坏时沿用上面的 "0.0.0" 默认值，仅用于插件兼容性检查。
    }
    this.appVersion = appVersion;

    this._pluginManager = new PluginManager({
      pluginsDirs: [builtinPluginsDir, userPluginsDir],
      pluginsDir: undefined,
      dataDir: pluginDataDir,
      bus,
      preferencesManager: this._prefs,
      appVersion,
      getSessionPath: () => this.currentSessionPath,
      registerSessionFile: (entry) => this.registerSessionFile(entry),
      slashRegistry: this._slashSystem?.registry ?? null,
      loadTimeoutMs: undefined,
      lifecycleTimeoutMs: undefined,
      logSink: (entry) => this._pluginDevService?.recordLog(entry),
      runtimeContext: this.getRuntimeContext(),
    });
    const allowedPluginDevSourceRoots = [
      pluginDevSourcesDir,
      this.homeCwd,
      process.cwd(),
      path.resolve(this.productDir, ".."),
    ].filter((dir) => typeof dir === "string" && dir.trim());
    this._pluginDevService = new PluginDevService({
      pluginManager: this._pluginManager,
      devPluginsDir,
      runDataDir: pluginDevRunsDir,
      allowedSourceRoots: allowedPluginDevSourceRoots,
      syncPluginExtensions: () => this.syncPluginExtensions(),
    });
    this._pluginDevEventBusCleanup?.();
    this._pluginDevEventBusCleanup = this._pluginDevService.registerEventBusHandlers(bus);
    this._pluginManager.scan();
    await this._pluginManager.loadAll();

    let providerContributionsChanged = false;
    for (const provider of this._pluginManager.getProviderPlugins()) {
      this._models.providerRegistry.registerProviderContribution(provider);
      providerContributionsChanged = true;
    }
    if (providerContributionsChanged) {
      await this._models.reloadAndSync();
    }

    if (this._skills) {
      await this.syncWorkspaceSkillPaths(this.currentSessionPath ? this.cwd : null, {
        reload: true,
        emitEvent: false,
      });
    }

    // Inject plugin extension factories into ResourceLoader (same array reference)
    await this.syncPluginExtensions();
  }

  /**
   * 同步插件 extension factories 到 ResourceLoader 共享数组。
   * 原地 splice 保持数组引用不变（DefaultResourceLoader 持有同一引用）。
   * 在 initPlugins 以及任何插件热操作后调用。
   */
  _syncExtensionFactories() {
    if (!this._extensionFactories) return;
    const coreFactories = this._coreExtensionFactories || [];
    const frameworkFactories = this._frameworkExtFactories || [];
    const pluginFactories = this._pluginManager?.getExtensionFactories() || [];
    this._extensionFactories.splice(0, Infinity, ...coreFactories, ...frameworkFactories, ...pluginFactories);
  }

  async _reloadResourceLoaderForExtensionFactories() {
    if (!this._resourceLoader?.reload) return;
    await this._resourceLoader.reload();
  }

  /**
   * Register a framework-level extension factory.
   * Tracked separately so _syncExtensionFactories preserves them across plugin hot-reloads.
   * Only affects sessions created after this call.
   */
  async registerExtensionFactory(factory) {
    if (!this._extensionFactories) return;
    if (!this._frameworkExtFactories) this._frameworkExtFactories = [];
    this._frameworkExtFactories.push(factory);
    await this.syncPluginExtensions();
  }

  get pluginManager() { return this._pluginManager; }
  get pluginDevService() { return this._pluginDevService; }

  /** 插件热操作后调用，同步 extension factories 到 ResourceLoader */
  async syncPluginExtensions() {
    this._syncExtensionFactories();
    await this._reloadResourceLoaderForExtensionFactories();
    await this._sessionCoord?.reloadExtensionRunners?.("plugin_extension_sync");
  }

  // ════════════════════════════
  //  工具构建
  // ════════════════════════════

  buildTools(cwd, customTools, opts: any = {}) {
    let ct = customTools;
    let agentId;
    let toolAgent;
    if (!ct) {
      // 通过 opts.agentDir 反查 agent 实例，避免隐式依赖焦点 agent
      if (opts.agentDir) {
        const dirAgentId = path.basename(opts.agentDir);
        const dirAgent = this.getAgent(dirAgentId);
        if (!dirAgent) throw new Error(`buildTools: agent "${dirAgentId}" not found`);
        ct = dirAgent.tools;
        agentId = dirAgentId;
        toolAgent = dirAgent;
      } else {
        ct = this.agent.tools;
        agentId = this.agent?.id || "";
        toolAgent = this.agent;
      }
    } else {
      agentId = opts.agentDir ? path.basename(opts.agentDir) : (this.agent?.id || "");
      toolAgent = opts.agentDir ? this.getAgent(agentId) : this.agent;
    }
    const getSessionPath = typeof opts.getSessionPath === "function"
      ? opts.getSessionPath
      : (() => null);

    // Append plugin tools
    const pluginTools = this._pluginManager?.getAllTools() || [];
    const executionBoundary = this._runtimeContext
      ? this.createExecutionBoundary({ workbenchRoot: cwd })
      : null;
    const executionScope = executionBoundary
      ? { serverNodeId: executionBoundary.serverNodeId, executionBoundary }
      : {};
    const withRuntimeContext = (tool) => {
      if (!tool?.execute) return tool;
      return {
        ...tool,
        execute: (toolCallId, params, signalOrRuntimeCtx, onUpdate, piCtx) => {
          const { ctx: runtimeCtx } = normalizeToolRuntimeContext(signalOrRuntimeCtx, piCtx);
          const sessionPath = runtimeCtx?.sessionPath
            || getToolSessionPath(runtimeCtx)
            || getSessionPath()
            || null;
          const mergedCtx = {
            ...runtimeCtx,
            ...(sessionPath ? { sessionPath } : {}),
            ...(opts.bridgeContext ? { bridgeContext: opts.bridgeContext } : {}),
            ...(opts.notificationContext ? { notificationContext: opts.notificationContext } : {}),
            agentId,
            ...executionScope,
          };
          return tool.execute(toolCallId, params, signalOrRuntimeCtx, onUpdate, mergedCtx);
        },
      };
    };
    const runtimeCustomTools = ct.map(withRuntimeContext);
    const wrappedPluginTools = pluginTools.map(t => ({
      ...t,
      execute: (toolCallId, params, signalOrRuntimeCtx, onUpdate, piCtx) => {
        const { ctx: runtimeCtx } = normalizeToolRuntimeContext(signalOrRuntimeCtx, piCtx);
        const sessionPath = runtimeCtx?.sessionPath
          || getToolSessionPath(runtimeCtx)
          || getSessionPath()
          || null;
        const mergedCtx = {
          ...runtimeCtx,
          ...(sessionPath ? { sessionPath } : {}),
          ...(opts.bridgeContext ? { bridgeContext: opts.bridgeContext } : {}),
          ...(opts.notificationContext ? { notificationContext: opts.notificationContext } : {}),
          agentId,
          ...executionScope,
        };
        return t.execute(toolCallId, params, signalOrRuntimeCtx, onUpdate, mergedCtx);
      },
    }));
    const pluginDevTools = this._pluginDevService && this._prefs.getPluginDevToolsEnabled?.() === true
      ? createPluginDevTools({
          pluginDevService: this._pluginDevService,
          getAgentId: () => agentId,
        })
      : [];
    const allTools = filterToolObjectsByAvailability(
      [...runtimeCustomTools, ...wrappedPluginTools, ...pluginDevTools],
      toolAgent?.config || {},
      {
        agentId,
        channelsEnabled: resolveChannelsEnabledForToolAvailability(this),
      },
      { warn: (msg) => toolAvailabilityLog.warn(msg) },
    );

    const effectiveAgentDir = opts.agentDir || this.agent.agentDir;
    const effectiveWorkspace = opts.workspace !== undefined ? opts.workspace : this.homeCwd;
    const workspaceFolders = opts.workspaceFolders || [];
    const staticAuthorizedFolders = Array.isArray(opts.authorizedFolders) ? opts.authorizedFolders : [];
    const getAuthorizedFolders = typeof opts.getAuthorizedFolders === "function"
      ? () => {
          const folders = opts.getAuthorizedFolders();
          return Array.isArray(folders) ? folders : [];
        }
      : () => staticAuthorizedFolders;
    const fileReadSessionPaths = Array.isArray(opts.fileReadSessionPaths)
      ? opts.fileReadSessionPaths.filter((sp) => typeof sp === "string" && sp.trim())
      : [];
    const getExternalReadPaths = () => {
      const sessionPaths = [];
      const seenSessionPaths = new Set();
      const addSessionPath = (sp) => {
        if (!sp || seenSessionPaths.has(sp)) return;
        seenSessionPaths.add(sp);
        sessionPaths.push(sp);
      };
      addSessionPath(getSessionPath());
      for (const sp of fileReadSessionPaths) addSessionPath(sp);
      if (!sessionPaths.length) return [];
      const files = typeof this.listSessionFiles === "function"
        ? sessionPaths.flatMap((sp) => this.listSessionFiles(sp))
        : [];
      return externalReadPathsFromSessionFiles(files, {
        workspaceRoots: workspaceRootsForSandbox(effectiveWorkspace, workspaceFolders, getAuthorizedFolders()),
        hanakoHome: this.hanakoHome,
      });
    };

    let result = createSandboxedTools(cwd, allTools, {
      agentDir: effectiveAgentDir,
      workspace: effectiveWorkspace,
      workspaceFolders,
      authorizedFolders: staticAuthorizedFolders,
      getAuthorizedFolders,
      hanakoHome: this.hanakoHome,
      executionBoundary,
      getSandboxEnabled: () => this._readPreferences().sandbox !== false,
      getSandboxNetworkEnabled: () => process.platform === "win32"
        ? true
        : this._readPreferences().sandbox_network !== false,
      getExternalReadPaths,
      getSessionPath,
      getSessionIdForPath: (sessionPath) => this.getSessionIdForPath(sessionPath),
      resolveSessionFile: (fileId, options: any = {}) => {
        const lookupSessionPath = options?.sessionPath || getSessionPath() || null;
        return this.getSessionFile?.(fileId, { sessionPath: lookupSessionPath }) || null;
      },
      recordFileOperation: (entry) => this.recordSessionFileOperation(entry),
      getVisionBridge: () => this.getVisionBridge(),
      isVisionAuxiliaryEnabled: () => this.isVisionAuxiliaryEnabled(),
      legacyCleanupQueue: this._win32LegacySandboxCleanupQueue,
    } as any);

    // Checkpoint wrapper (outside sandbox layer)
    const backupCfg = this._prefs.getFileBackup();
    if (backupCfg.enabled) {
      result = {
        ...result,
        tools: wrapWithCheckpoint(result.tools, {
          store: this._checkpointStore,
          maxFileSizeKb: backupCfg.max_file_size_kb,
          cwd,
          getSessionPath,
        }),
      };
    }

    const getPermissionMode = typeof opts.getPermissionMode === "function"
      ? opts.getPermissionMode
      : (sessionPath) => this.getSessionPermissionMode(sessionPath);
    // 拦截上下文（如 { isSubagent }）：classify 据此做与 mode 无关的固定边界（防自递归等）。
    const permissionContext = opts.permissionContext || null;
    const allowHumanApproval = opts.allowHumanApproval !== false;
    result = {
      ...result,
      tools: wrapWithSessionPermission(result.tools, {
        getSessionPath,
        getPermissionMode,
        permissionContext,
        allowHumanApproval,
        getConfirmStore: () => this._confirmStore,
        getApprovalGateway: () => this._approvalGateway,
        emitEvent: (event, sessionPath) => this._emitEvent(event, sessionPath),
      }),
      customTools: wrapWithSessionPermission(result.customTools, {
        getSessionPath,
        getPermissionMode,
        permissionContext,
        allowHumanApproval,
        getConfirmStore: () => this._confirmStore,
        getApprovalGateway: () => this._approvalGateway,
        emitEvent: (event, sessionPath) => this._emitEvent(event, sessionPath),
      }),
    };

    // Startup assertion: every built-in tool must be categorized in
    // shared/tool-categories.js. All session-creation paths route through
    // this function, so a single check here catches the whole surface.
    assertAllToolsCategorized([
      ...result.tools.map((t) => t.name).filter(Boolean),
      ...runtimeCustomTools
        .filter((t) => !t._pluginId)
        .map((t) => t.name)
        .filter(Boolean),
    ]);

    return result;
  }

  // ════════════════════════════
  //  事件系统
  // ════════════════════════════

  /**
   * Hub 构造后注入回调，替代旧的 engine._hub = this 双向引用。
   * Manager 通过 getHub() lazy getter 拿到这个对象。
   */
  setHubCallbacks(callbacks) {
    this._hubCallbacks = callbacks;
    // 把 hub 引用补给 slash dispatcher（Phase 3：bridge-manager / WS 入口都靠它路由命令）
    if (callbacks?.hub) this._slashSystem?.dispatcher?.setHub(callbacks.hub);
  }

  registerAgentPhoneAbortHandler(handler, meta: any = {}) {
    return this._hubCallbacks?.registerAgentPhoneAbortHandler?.(handler, meta) || (() => {});
  }

  setEventBus(bus) {
    for (const fn of this._listeners) bus.subscribe(fn);
    this._listeners.clear();
    this._eventBus = bus;
  }

  getEventBus() {
    return this._eventBus;
  }

  subscribe(listener) {
    if (this._eventBus) return this._eventBus.subscribe(listener);
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emitEvent(event, sessionPath) {
    if (this._eventBus) {
      this._eventBus.emit(event, sessionPath);
    } else {
      for (const fn of this._listeners) {
        // 单个 listener 抛错不能中断对其余 listener 的分发，但要记录避免静默漏处理事件。
        try { fn(event, sessionPath); } catch (err) { moduleLog.warn(`event listener threw for ${event?.type}: ${err?.message}`); }
      }
    }
  }

  emitEvent(event, sessionPath) { this._emitEvent(event, sessionPath); }

  _emitAppEvent(type, payload: any = {}) {
    if (typeof type !== "string" || !type) return;
    const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
    this._emitEvent({
      type: "app_event",
      event: {
        type,
        payload: normalizedPayload,
        source: "server",
      },
    }, null);
  }

  emitDevLog(text, level = "info") {
    const entry = { text, level, ts: Date.now() };
    this._devLogs.push(entry);
    if (this._devLogs.length > this._devLogsMax) {
      this._devLogs.shift();
    }
    const dl = debugLog();
    if (dl) {
      if (level === "error") dl.error("engine", text);
      else dl.log("engine", text);
    }
    this._emitEvent({ type: "devlog", text, level }, null);
  }

  getDevLogs() {
    return this._devLogs;
  }

  // ════════════════════════════
  //  日记 / 工具调用
  // ════════════════════════════

  async writeDiary(opts: any = {}) {
    const currentPath = this.currentSessionPath;
    if (currentPath && this.agent.memoryTicker) {
      await this.agent.memoryTicker.flushSession(currentPath);
    }
    const { writeDiary } = await import("../lib/diary/diary-writer.ts");
    const diaryModelId = this.agent.config.models?.chat || this.agent.memoryModel;
    const resolvedModel = this._models.resolveModelWithCredentials(diaryModelId);
    // 写日记是用户主动触发的「读历史」功能，必须参考记忆，
    // 跟「在对话中潜移默化带入记忆」的 master 开关无关。所以不查 memoryMasterEnabled。
    // per-session 开关只决定缺摘要时是否写回 summaries；关闭时仍可为本次日记临时压缩。
    const agent = this.agent;
    return writeDiary({
      summaryManager: agent.summaryManager,
      resolvedModel,
      agentPersonality: agent.personality,
      memory: (() => {
        try { return fs.readFileSync(agent.memoryMdPath, "utf-8"); } catch { return ""; }
      })(),
      userName: agent.userName,
      agentName: agent.agentName,
      cwd: this.homeCwd || process.cwd(),
      targetDate: opts.targetDate,
      activityStore: this.activityStore,
      sessionDir: agent.sessionDir,
      isSessionMemoryEnabledForPath: (sessionPath) => {
        return agent.isSessionMemoryEnabledFor(sessionPath);
      },
      getCompactionAuth: async (model) => {
        const auth = await this._models.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          throw new Error(`Auth failed for model ${model.id}: ${auth.error}`);
        }
        if (!auth.apiKey) {
          throw new Error(`No API key for provider ${model.provider}`);
        }
        return { apiKey: auth.apiKey, headers: auth.headers };
      },
    });
  }

  _utilityOptionsForContext( opts: any = {}) {
    if (opts?.agentId) return { agentId: opts.agentId, sessionPath: opts.sessionPath || null };
    if (opts?.sessionPath) {
      const agentId = this.agentIdFromSessionPath(opts.sessionPath);
      if (agentId) return { agentId, sessionPath: opts.sessionPath };
    }
    return undefined;
  }

  async summarizeTitle(ut, at, opts: any = {}) {
    return _summarizeTitle(this.resolveUtilityConfig(this._utilityOptionsForContext(opts)), ut, at, opts);
  }

  async translateSkillNames(names, lang, opts: any = {}) {
    const skills = Array.isArray(opts.skills)
      ? opts.skills
      : (opts.agentId ? this.getAllSkills(opts.agentId) : []);
    return translateSkillNamesWithCache({
      cachePath: getSkillNameTranslationCachePath(this.hanakoHome),
      skills,
      names,
      lang,
      translateMissing: (missingNames) => _translateSkillNames(
        this.resolveUtilityConfig(opts.agentId ? { agentId: opts.agentId } : undefined),
        missingNames,
        lang,
      ),
    });
  }

  async summarizeActivity(sp, preloaded, opts: any = {}) {
    const utilityOptions = this._utilityOptionsForContext({ ...opts, sessionPath: opts.sessionPath || sp });
    return _summarizeActivity(this.resolveUtilityConfig(utilityOptions), sp, (msg) => this.emitDevLog(msg), preloaded);
  }

  async summarizeActivityQuick(activityId) {
    let entry = null, foundAgentId = null;
    for (const [agId] of this._agentMgr.agents) {
      const store = this.getActivityStore(agId);
      const e = store?.get(activityId);
      if (e) { entry = e; foundAgentId = agId; break; }
    }
    if (!entry?.sessionFile) return null;
    const sessionPath = path.join(this.agentsDir, foundAgentId, "activity", entry.sessionFile);
    return _summarizeActivityQuick(this.resolveUtilityConfig({ agentId: foundAgentId }), sessionPath);
  }

  // ════════════════════════════
  //  Desk 辅助
  // ════════════════════════════

  listDeskFiles() {
    try {
      const dir = this.homeCwd;
      if (!dir || !fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith("."))
        .map(e => {
          const fp = path.join(dir, e.name);
          let mtime = 0;
          try { mtime = fs.statSync(fp).mtimeMs; } catch {
            // 文件在 readdir 之后被删 / 无权限时 stat 失败，mtime 保持 0 兜底。
          }
          return { name: e.name, isDir: e.isDirectory(), mtime };
        });
    } catch {
      return [];
    }
  }

  get defaultDeskCwd() {
    return this.homeCwd || null;
  }

  _realPathForWorkspaceCheck(p) {
    if (!p || typeof p !== "string") return null;
    try {
      return fs.realpathSync(p);
    } catch {
      try {
        return fs.realpathSync(path.dirname(p));
      } catch {
        return null;
      }
    }
  }

  isApprovedWorkspaceDir(dir) {
    const resolved = this._realPathForWorkspaceCheck(dir);
    if (!resolved) return false;
    const roots = [
      this.homeCwd,
      this.deskCwd,
      ...this.getSessionWorkspaceFolders(this.currentSessionPath),
    ].filter(Boolean);
    return roots.some((root) => {
      const base = this._realPathForWorkspaceCheck(root);
      if (!base) return false;
      return resolved === base || resolved.startsWith(base + path.sep);
    });
  }

  isApprovedDeskDir(dir) {
    const resolved = this._realPathForWorkspaceCheck(dir);
    if (!resolved) return false;
    const roots = [
      this.homeCwd,
      this.deskCwd,
      ...this.getSessionWorkspaceFolders(this.currentSessionPath),
      ...(Array.isArray(this.config?.cwd_history) ? this.config.cwd_history : []),
    ].filter(Boolean);
    return roots.some((root) => {
      const base = this._realPathForWorkspaceCheck(root);
      if (!base) return false;
      return resolved === base || resolved.startsWith(base + path.sep);
    });
  }

  // ════════════════════════════
  //  Preferences 代理
  // ════════════════════════════

  _readPreferences() { return this._prefs.getPreferences(); }
  _writePreferences(prefs) { return this._prefs.savePreferences(prefs); }
  _readPrimaryAgent() { return this._prefs.getPrimaryAgent(); }
  _savePrimaryAgent(agentId) { return this._prefs.savePrimaryAgent(agentId); }

  // ════════════════════════════
  //  巡检工具白名单（向后兼容静态引用）
  // ════════════════════════════

  static PATROL_TOOLS_DEFAULT = "*";
}
