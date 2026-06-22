import type { ThinkingLevel } from './stores/model-slice';
import type {
  HanaPlatformApiMethodName,
  HanaPlatformMethodContract,
} from '../shared/platform-contract-types';
import type { VscodeWorkbenchDiagnostics } from '../shared/vscode-workbench-contract-types';

export type PlatformApiMethodName = HanaPlatformApiMethodName;

export interface AutoLaunchStatus {
  supported: boolean;
  openAtLogin: boolean;
  openedAtLogin: boolean;
  status: string | null;
  executableWillLaunchAtLogin?: boolean | null;
}

export interface KeepAwakeStatus {
  enabled: boolean;
  active: boolean;
  blockerId: number | null;
  type: 'prevent-app-suspension';
}

export type DesktopNotificationFocusPolicy = 'always' | 'when_unfocused';

export interface DesktopNotificationOptions {
  desktopFocusPolicy?: DesktopNotificationFocusPolicy;
}

// ── 核心数据结构 ──

export type SessionPermissionMode = 'auto' | 'operate' | 'ask' | 'read_only';

/**
 * #1624：服务端在 session restore 时算好的"工具能力有更新"提示数据
 * （冻结快照 vs 当前 agent 配置）。前端只消费，不自行计算。
 */
export interface SessionCapabilityDrift {
  version: number;
  /** 当前 live 配置的能力 fingerprint（dismiss 时回传） */
  fingerprint: string;
  frozenFingerprint: string;
  addedToolNames: string[];
  removedToolNames: string[];
  invalidToolNames: string[];
  promptChanged: boolean;
  hasDrift: boolean;
}

export interface Session {
  path: string;
  sessionId?: string | null;
  title: string | null;
  firstMessage: string;
  modified: string;
  /**
   * 服务端磁盘修订点（stat 签名）。null = 服务端未提供（老服务端 / 内存占位投影）。
   * 与 chatSessions[path].revision 对比用于判断缓存内容是否落后于磁盘真相。
   */
  revision?: string | null;
  messageCount: number;
  agentId: string | null;
  agentName: string | null;
  cwd: string | null;
  workspaceMountId?: string | null;
  workspaceLabel?: string | null;
  projectId?: string | null;
  permissionMode?: SessionPermissionMode | null;
  pinnedAt?: string | null;
  hasSummary?: boolean;
  agentDeleted?: boolean;
  readOnlyReason?: 'agent_deleted' | string | null;
  continuationAvailable?: boolean;
  deletedAt?: string | null;
  rcAttachment?: {
    sessionKey: string;
    platform: string;
    title?: string | null;
  } | null;
  _optimistic?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  yuan: string;
  isPrimary: boolean;
  hasAvatar?: boolean;
  chatModel?: { id: string; provider?: string | null } | null;
  homeFolder?: string | null;
  memoryMasterEnabled?: boolean;
}

export interface SessionStream {
  streamId: string | null;
  lastSeq: number;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  isCurrent?: boolean;
  reasoning?: boolean;
  xhigh?: boolean;
  thinkingLevels?: ThinkingLevel[];
  defaultThinkingLevel?: ThinkingLevel;
  audio?: boolean;
  audioTransport?: string | null;
  audioTransportSupported?: boolean;
  /** 输入模态数组（Pi SDK 标准字段）。包含 "image" / "video" 表示模型支持对应媒体输入；音频走 Hana 兼容能力字段。 */
  input?: ("text" | "image" | "video")[];
}

export interface Channel {
  id: string;
  name: string;
  description?: string;
  members: string[];
  lastMessage: string;
  lastSender: string;
  lastTimestamp: string;
  messageCount?: number;
  newMessageCount: number;
  isDM?: boolean;
  dmOwnerId?: string;
  peerId?: string;
  peerName?: string;
}

export interface ChannelMessage {
  sender: string;
  timestamp: string;
  body: string;
}

export interface AgentPhoneActivity {
  conversationId: string;
  conversationType: 'channel' | 'dm';
  agentId: string;
  state: 'idle' | 'viewed' | 'triaging' | 'no_reply' | 'replying' | 'using_tool' | 'waiting_permission' | 'compacting' | 'error' | string;
  summary: string;
  timestamp: string;
  details?: Record<string, unknown> | null;
}

export type ChannelAgentActivities = Record<string, Record<string, AgentPhoneActivity[]>>;

export interface ChannelTickerStatus {
  active?: {
    channelName?: string;
    agentId?: string;
    activeAgentId?: string;
    delivered?: number;
    agentCount?: number;
    checks?: number;
    maxChecks?: number;
    mode?: string;
  } | null;
  nextReminder?: {
    channelName?: string;
    dueAt?: string;
    dueAtMs?: number;
    intervalMs?: number;
  } | null;
  running?: boolean;
  queued?: boolean;
}

export type ChannelTickerStatusMap = Record<string, ChannelTickerStatus | null>;
export type AgentPhoneToolMode = 'read_only' | 'write';

export interface AgentPhoneSettings {
  mode: AgentPhoneToolMode;
  replyMinChars: number | null;
  replyMaxChars: number | null;
  proactiveEnabled: boolean;
  reminderIntervalMinutes: number;
  guardLimit: number;
  modelOverrideEnabled: boolean;
  modelOverrideModel: { id: string; provider: string } | null;
}

export interface Activity {
  id: string;
  type: string;
  title: string;
  timestamp: string;
  agentId?: string;
  agentName?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface PreviewItem {
  id: string;
  type: string;
  title: string;
  content: string;
  language?: string | null;
  fileId?: string;
  filePath?: string;
  ext?: string;
  mime?: string;
  kind?: string;
  storageKind?: string;
  sourceUrl?: string;
  sourceRootPath?: string;
  status?: 'available' | 'expired' | string;
  missingAt?: number | null;
  fileVersion?: FileVersion | null;
  remoteContentRef?: RemoteContentRef | null;
}

export interface DeskFile {
  name: string;
  isDir: boolean;
  size?: number;
  mtime?: string;
}

export interface StudioWorkspace {
  workspaceId: string;
  mountId: string;
  label: string;
  sourceKind?: string | null;
  provider?: string | null;
  presentation?: string | null;
  capabilities?: string[];
  isDefault?: boolean;
  /**
   * local_fs mount 的 native 绝对根路径。仅当服务端按 principal 判定为
   * 本地 owner 时披露；远端/虚拟 mount 恒为 null。
   */
  nativeRootPath?: string | null;
  remoteHost?: string | null;
  remotePort?: number | null;
  remoteUser?: string | null;
  remotePath?: string | null;
}

export interface WorkspaceChangePayload {
  rootPath: string;
  changedPath: string;
  affectedDir: string;
  eventType: string;
}

export interface DeskSearchResult {
  name: string;
  relativePath: string;
  parentSubdir: string;
  isDir: boolean;
  size?: number | null;
  mtime?: string;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

// ── 浮动面板类型 ──
export type ActivePanel = 'activity' | 'automation' | 'bridge' | 'skills' | null;
export type TabType = 'chat' | 'coding' | 'channels' | `plugin:${string}`;
export type RightWorkspaceTab = 'session-files' | 'workspace' | `plugin-widget:${string}`;

export interface FileVersion {
  mtimeMs: number;
  size: number;
  sha256?: string;
}

export interface TextFileSnapshot {
  content: string;
  version: FileVersion;
}

export interface VersionedWriteResult {
  ok: boolean;
  conflict?: boolean;
  version?: FileVersion | null;
}

export interface RemoteWorkbenchContentRef {
  kind: 'workbench-file' | 'mobile-workbench';
  mountId?: string;
  rootId?: string;
  subdir: string;
  name: string;
  contentPath: string;
  version?: FileVersion | null;
}

export type RemoteContentRef = RemoteWorkbenchContentRef;

// ── Plugin Card Protocol ──

export interface PluginCardDetails {
  type: string;         // "iframe" | future types
  pluginId: string;
  route: string;
  title?: string;
  description: string;  // IM fallback / degradation text
  aspectRatio?: string;
}

// ── 插件 UI 信息 ──

export interface PluginPageInfo {
  pluginId: string;
  title: string | Record<string, string>;
  icon: string | null;
  routeUrl: string;
  hostCapabilities: string[];
}

export interface PluginWidgetInfo {
  pluginId: string;
  title: string | Record<string, string>;
  icon: string | null;
  routeUrl: string;
  hostCapabilities: string[];
}

export interface PluginUiHostCapabilityGrant {
  pluginId: string;
  hostCapabilities: string[];
}

export interface BrowserViewerTab {
  tabId: string;
  title?: string;
  url?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface BrowserViewerUpdate {
  title?: string;
  url?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  running?: boolean;
  reason?: string | null;
  sessionPath?: string | null;
  activeTabId?: string | null;
  tabs?: BrowserViewerTab[];
}

export interface VscodeWorkbenchBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible?: boolean;
}

// ── Platform API 类型声明 ──
export interface PlatformApi extends HanaPlatformMethodContract {
  getServerPort(): Promise<string>;
  getServerToken(): Promise<string>;
  runEditCommand?(command: 'cut' | 'copy' | 'paste' | 'selectAll'): Promise<boolean>;
  openSettings(tab?: string): void;
  openBrowserViewer(url?: string, theme?: string): void;
  selectFolder(): Promise<string | null>;
  selectFiles(): Promise<string[]>;
  selectSkill(): Promise<string | null>;
  selectPlugin?(): Promise<string | null>;
  readFile(path: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<boolean>;
  writeFileBinary?(filePath: string, base64Data: string): Promise<boolean>;
  copyFile?(sourcePath: string, destinationPath: string): Promise<boolean>;
  screenshotRender?(payload: unknown): Promise<{ success: boolean; error?: string; dir?: string; filePath?: string }>;
  readFileSnapshot?(path: string): Promise<TextFileSnapshot | null>;
  writeFileIfUnchanged?(filePath: string, content: string, expectedVersion?: FileVersion | null): Promise<VersionedWriteResult>;
  watchFile(filePath: string): Promise<boolean>;
  unwatchFile(filePath: string): Promise<boolean>;
  onFileChanged(callback: (filePath: string) => void): void;
  watchWorkspace?(rootPath: string): Promise<boolean>;
  unwatchWorkspace?(rootPath: string): Promise<boolean>;
  onWorkspaceChanged?(callback: (payload: WorkspaceChangePayload) => void): void;
  readFileBase64(path: string): Promise<string | null>;
  /** 把本地路径转成 <img>/<video> 可用的 file:// URL（同步，纯路径转换）。Web fallback 无此方法，消费侧需运行时判空。 */
  getFileUrl?(path: string): string;
  readDocxHtml(path: string): Promise<string | null>;
  readXlsxHtml(path: string): Promise<string | null>;
  /** 派生一个只读 Viewer 窗口展示指定文件。返回 windowId（主进程 BrowserWindow.id）。 */
  spawnViewer(data: { filePath: string; title: string; type: string; language?: string | null }): Promise<number | null>;
  /** Viewer 窗口接收文件元信息（viewer-window-entry 调用）。 */
  onViewerLoad?(callback: (data: { filePath: string; title: string; type: string; language?: string | null; windowId: number }) => void): void;
  /** Viewer 窗口内"关闭"按钮触发。 */
  viewerClose?(): void;
  /** 主窗口监听任意 viewer 关闭，payload 是 windowId（用于清理 pinnedViewers store）。 */
  onViewerClosed?(callback: (windowId: number) => void): void;
  openFolder(path: string): void;
  openFile(path: string): void;
  openExternal(url: string): void;
  showInFinder(path: string): void;
  trashItem?(path: string): Promise<boolean>;
  getVscodeWorkbenchStatus?(): Promise<VscodeWorkbenchDiagnostics>;
  openVscodeWorkbench?(): Promise<VscodeWorkbenchDiagnostics>;
  closeVscodeWorkbench?(): Promise<VscodeWorkbenchDiagnostics>;
  reloadVscodeWorkbench?(): Promise<VscodeWorkbenchDiagnostics>;
  setVscodeWorkbenchBounds?(bounds: VscodeWorkbenchBounds): Promise<VscodeWorkbenchDiagnostics>;
  onVscodeWorkbenchStatus?(callback: (status: VscodeWorkbenchDiagnostics) => void): void | (() => void);
  browserEmergencyStop?(): void;
  openSkillViewer?(opts: { skillPath?: string; name?: string; baseDir?: string; filePath?: string; installed?: boolean }): void;
  settingsChanged(event: string, payload?: unknown): void;
  syncWindowTheme?(theme: string): void;
  onSettingsChanged(callback: (event: string, payload: unknown) => void): void | (() => void);
  onOpenSettingsModal?(callback: (tab?: string) => void): void | (() => void);
  onSwitchTab?(callback: (tab: string) => void): void | (() => void);
  onServerRestarted?(callback: (data: { port: number; token?: string | null }) => void): void | (() => void);
  getFilePath?(file: File): string | null;
  startDrag?(filePaths: string | string[]): void;
  appReady(): void;

  // ── Window controls (Windows/Linux) ──
  getPlatform?(): Promise<string>;
  windowMinimize?(): void;
  windowMaximize?(): void;
  windowClose?(): void;
  windowIsMaximized?(): Promise<boolean>;
  onMaximizeChange?(callback: (maximized: boolean) => void): void;

  // ── Browser viewer ──
  onBrowserUpdate?(callback: (data: BrowserViewerUpdate) => void): void | (() => void);
  closeBrowserViewer?(): void;
  closeBrowser?(): void;
  browserGoBack?(): void;
  browserGoForward?(): void;
  browserReload?(): void;
  browserNewTab?(): void;
  browserSwitchTab?(tabId: string): void;
  browserCloseTab?(tabId: string): void;

  // ── Skill viewer (preload) ──
  listSkillFiles?(baseDir: string): Promise<unknown[]>;
  readSkillFile?(filePath: string): Promise<string | null>;

  // ── Splash / Onboarding ──
  getAvatarPath?(role: string): Promise<string | null>;
  getSplashInfo?(): Promise<{ agentName?: string; locale?: string; yuan?: string } | null>;
  reloadMainWindow?(): Promise<void>;
  onboardingComplete?(): Promise<void>;

  // ── Notification ──
  showNotification?(title: string, body: string, agentId?: string | null, options?: DesktopNotificationOptions): void;

  // ── App info ──
  getAppVersion?(): Promise<string>;
  getAutoLaunchStatus?(): Promise<AutoLaunchStatus>;
  setAutoLaunchEnabled?(enabled: boolean): Promise<AutoLaunchStatus>;
  getKeepAwakeStatus?(): Promise<KeepAwakeStatus>;
  setKeepAwakeEnabled?(enabled: boolean): Promise<KeepAwakeStatus>;
  quickChatReloadShortcut?(): Promise<{ ok: boolean; shortcut: string; error?: string }>;
  quickChatShortcutStatus?(): Promise<{ shortcut: string; registered: boolean }>;
  quickChatShow?(): void;
  quickChatHide?(): void;
  quickChatResize?(request: 'compact' | 'chat' | { mode: 'compact' | 'chat'; height?: number }): void;
  quickChatOpenSession?(sessionPath: string): void;
  onQuickChatOpenSession?(callback: (payload: { sessionPath?: string }) => void): (() => void) | void;
  onQuickChatShown?(callback: () => void): (() => void) | void;

  // ── Skill viewer overlay ──
  onShowSkillViewer?(callback: (data: unknown) => void): void;

  [key: string]: unknown;
}
