/**
 * session-actions.ts — Session 生命周期操作（纯逻辑 + API）
 *
 * 从 sidebar-shim.ts 迁移。所有函数直接操作 Zustand store，
 * 不依赖 ctx 注入，不持有闭包状态（除 _switchVersion 防竞争）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- store partial patch + API 响应 JSON */

import { useStore } from './index';
import { sessionScopedKey, sessionScopedListIncludes, sessionScopedValue } from './session-slice';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { buildItemsFromHistory } from '../utils/history-builder';
import { migrateLegacyTodos } from '../utils/todo-compat';
import { loadAvatars as loadAvatarsAction, clearChat as clearChatAction } from './agent-actions';
import { activateWorkspaceDesk } from './desk-actions';
import { loadModels } from '../utils/ui-helpers';
import { browserStateForPath, setBrowserStateForPath } from './browser-slice';
import { computerOverlayForSession } from './computer-overlay-slice';
import { snapshotStreamBuffer, type StreamBufferSnapshot } from './stream-invalidator';
import { renderMarkdown } from '../utils/markdown';
import type { ChatMessage, ContentBlock } from './chat-types';
import { readMessageLiveVersion } from './message-live-version';
import type { SessionPermissionMode } from '../types';

// ── 防竞争计数器 ──

let _switchVersion = 0;
let _switchAbortController: AbortController | null = null;

function invalidateSessionSwitches(): void {
  _switchVersion += 1;
  _switchAbortController?.abort();
  _switchAbortController = null;
  useStore.setState({ pendingSessionSwitchPath: null });
}

function isCurrentSwitch(version: number, path: string): boolean {
  const state = useStore.getState();
  return version === _switchVersion && state.pendingSessionSwitchPath === path;
}

function normalizeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function mergeSessionLocators(current: Record<string, { path: string | null }> = {}, sessions: any[] = []) {
  const next = { ...current };
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const sessionId = normalizeSessionId(session?.sessionId);
    if (!sessionId) continue;
    next[sessionId] = { path: typeof session.path === 'string' ? session.path : null };
  }
  return next;
}

function sessionIdForPathFromState(state: Record<string, any>, path: string | null): string | null {
  if (!path) return null;
  const session = (state.sessions || []).find((item: any) => item?.path === path);
  return normalizeSessionId(session?.sessionId);
}

function currentSessionIdentityPatch(state: Record<string, any>, path: string | null, sessionId: unknown) {
  const normalizedSessionId = normalizeSessionId(sessionId) || sessionIdForPathFromState(state, path);
  return {
    currentSessionPath: path,
    currentSessionId: normalizedSessionId,
    ...(normalizedSessionId ? {
      sessionLocatorsById: {
        ...(state.sessionLocatorsById || {}),
        [normalizedSessionId]: { path },
      },
    } : {}),
  };
}

function sessionMessagesUrl(path: string, extra: Record<string, string> = {}): string {
  const state = useStore.getState() as Record<string, any>;
  const params = new URLSearchParams();
  params.set('path', path);
  const sessionId = sessionIdForPathFromState(state, path);
  if (sessionId) params.set('sessionId', sessionId);
  for (const [key, value] of Object.entries(extra)) {
    params.set(key, value);
  }
  return `/api/sessions/messages?${params.toString()}`;
}

function putSessionScopedStateValue(
  state: Record<string, any>,
  map: Record<string, any> = {},
  sessionPath: string,
  value: any,
): Record<string, any> {
  const key = sessionScopedKey(state, sessionPath) || sessionPath;
  const next = { ...map, [key]: value };
  if (key !== sessionPath) delete next[sessionPath];
  return next;
}

function deleteSessionScopedStateValue(
  state: Record<string, any>,
  map: Record<string, any> = {},
  sessionPath: string,
): Record<string, any> {
  const key = sessionScopedKey(state, sessionPath) || sessionPath;
  const next = { ...map };
  delete next[key];
  if (key !== sessionPath) delete next[sessionPath];
  return next;
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (
    (err as { name?: string }).name === 'AbortError' ||
    (err as { message?: string }).message === 'This operation was aborted'
  );
}

function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { hana?: unknown }).hana;
}

function shouldRestoreInputFocus(path: string | null): boolean {
  const state = useStore.getState() as Record<string, any>;
  if (!isDesktopShell()) return false;
  if (state.currentTab !== 'chat') return false;
  if (path) {
    if (state.currentSessionPath !== path) return false;
  } else if (state.pendingNewSession !== true || state.currentSessionPath !== null || state.pendingSessionSwitchPath) {
    return false;
  }
  if (state.settingsModal?.open || state.mediaViewer || state.skillViewerData || state.channelCreateOverlayVisible) return false;
  if (path && computerOverlayForSession(state as any, path)) return false;
  return true;
}

function requestChatInputFocus(path: string | null): void {
  if (shouldRestoreInputFocus(path)) useStore.getState().requestInputFocus?.();
}

function isPendingNewSessionDraftView(): boolean {
  const state = useStore.getState() as Record<string, any>;
  return state.pendingNewSession === true
    && state.currentSessionPath === null
    && !state.pendingSessionSwitchPath;
}

const SESSION_PERMISSION_MODES = new Set(['auto', 'operate', 'ask', 'read_only']);

function normalizeSessionPermissionMode(mode: unknown): SessionPermissionMode {
  return typeof mode === 'string' && SESSION_PERMISSION_MODES.has(mode)
    ? mode as SessionPermissionMode
    : 'ask';
}

function emitSessionPermissionMode(mode: unknown): SessionPermissionMode {
  const normalized = normalizeSessionPermissionMode(mode);
  useStore.getState().setSessionPermissionMode?.(normalized);
  window.dispatchEvent(new CustomEvent('hana-plan-mode', {
    detail: { enabled: normalized === 'read_only', mode: normalized },
  }));
  return normalized;
}

function findSessionProjection(path: string): any | null {
  return useStore.getState().sessions.find((session: any) => session.path === path) || null;
}

function isDeletedAgentSession(path: string): boolean {
  return findSessionProjection(path)?.agentDeleted === true;
}

function filterSessionScopedStateList(state: Record<string, any>, list: string[] | undefined, path: string): string[] {
  const current = Array.isArray(list) ? list : [];
  const key = sessionScopedKey(state, path) || path;
  return current.filter((item) => item !== key && item !== path);
}

function putSessionScopedStateListValue(state: Record<string, any>, list: string[] | undefined, path: string): string[] {
  const key = sessionScopedKey(state, path) || path;
  return [...filterSessionScopedStateList(state, list, path), key];
}

function reconcileStreamingSessionsForPath(
  state: Record<string, any>,
  streamingSessions: string[] | undefined,
  path: string,
  isStreaming: boolean,
): string[] {
  const current = Array.isArray(streamingSessions) ? streamingSessions : [];
  if (isStreaming) {
    return putSessionScopedStateListValue(state, current, path);
  }
  return filterSessionScopedStateList(state, current, path);
}

async function requestActiveSessionStreamResume(path: string, isStreaming: boolean): Promise<void> {
  if (!isStreaming) return;
  try {
    const { requestStreamResume } = await import('../services/stream-resume');
    requestStreamResume(path);
  } catch (err) {
    console.warn('[session] stream resume request skipped after switch:', err);
  }
}

async function resetDeskForSessionWorkspace({
  cwd,
  workspaceMountId,
  workspaceLabel,
}: {
  cwd?: string | null;
  workspaceMountId?: string | null;
  workspaceLabel?: string | null;
}): Promise<void> {
  // Session 切换后的 cwd 以服务端显式返回值为准；右侧 desk 视图归 workspace/CWD 所有。
  // 切到同一 workspace 时保留当前子目录；切到不同 workspace 时恢复该 workspace 的上次子目录。
  await activateWorkspaceDesk(cwd || null, {
    mountId: workspaceMountId || null,
    label: workspaceLabel || null,
  });
}

function clearSessionRuntimeCaches(path: string): void {
  useStore.getState().clearSession?.(path);
  useStore.setState((s: Record<string, any>) => {
    const attachedFilesBySession = deleteSessionScopedStateValue(s, s.attachedFilesBySession || {}, path);
    const sessionRegistryFilesByPath = deleteSessionScopedStateValue(s, s.sessionRegistryFilesByPath || {}, path);
    const drafts = deleteSessionScopedStateValue(s, s.drafts || {}, path);
    const activeSessionStreams = deleteSessionScopedStateValue(s, s.activeSessionStreams || {}, path);
    const computerOverlayBySession = deleteSessionScopedStateValue(s, s.computerOverlayBySession || {}, path);
    const scrollPositions = deleteSessionScopedStateValue(s, s.scrollPositions || {}, path);
    const sessionStreams = deleteSessionScopedStateValue(s, s.sessionStreams || {}, path);
    const browserBySession = deleteSessionScopedStateValue(s, s.browserBySession || {}, path);
    const todosBySession = deleteSessionScopedStateValue(s, s.todosBySession || {}, path);
    const todosLiveVersionBySession = deleteSessionScopedStateValue(s, s.todosLiveVersionBySession || {}, path);
    const sessionAuthorizedFoldersByPath = deleteSessionScopedStateValue(s, s.sessionAuthorizedFoldersByPath || {}, path);
    const capabilityDriftBySession = deleteSessionScopedStateValue(s, s.capabilityDriftBySession || {}, path);
    let inlineErrors = s.inlineErrors;
    if (inlineErrors) {
      inlineErrors = deleteSessionScopedStateValue(s, inlineErrors || {}, path);
      const key = sessionScopedKey(s, path) || path;
      inlineErrors = { ...inlineErrors, [key]: null, [path]: null };
    }
    return {
      attachedFilesBySession,
      sessionRegistryFilesByPath,
      drafts,
      sessionStreams,
      activeSessionStreams,
      browserBySession,
      computerOverlayBySession,
      scrollPositions,
      streamingSessions: filterSessionScopedStateList(s, s.streamingSessions || [], path),
      unreadOutputSessionPaths: filterSessionScopedStateList(s, s.unreadOutputSessionPaths || [], path),
      todosBySession,
      todosLiveVersionBySession,
      sessionAuthorizedFoldersByPath,
      capabilityDriftBySession,
      capabilityRefreshingSessions: filterSessionScopedStateList(s, s.capabilityRefreshingSessions || [], path),
      inlineErrors,
    };
  });
}

// ══════════════════════════════════════════════════════
// 消息加载（从 app-messages-shim 迁移）
// ══════════════════════════════════════════════════════

export async function loadMessages(forPath?: string): Promise<void> {
  const targetPath = forPath || useStore.getState().currentSessionPath;
  if (!targetPath) return;
  const messageLiveVersionBefore = readMessageLiveVersion(targetPath);
  // 捕获 hydrate 前的 live 版本：若 fetch 期间有 tool_end 更新 todos，
  // 后面就跳过 hydrate 写入，避免旧快照覆盖刚收到的实时状态。
  const todosLiveVersionBefore =
    sessionScopedValue(useStore.getState() as Record<string, any>, useStore.getState().todosLiveVersionBySession, targetPath) ?? 0;
  // messages 维度的竞态护栏：rapid switch 或并发 load 时，只有最新一次调用
  // 的响应允许 apply initSession，stale 响应直接丢弃。
  const myVersion = useStore.getState().bumpLoadMessagesVersion(targetPath);
  try {
    const res = await hanaFetch(sessionMessagesUrl(targetPath));
    const data = await res.json();
    const latestVersion =
      sessionScopedValue(useStore.getState() as Record<string, any>, useStore.getState()._loadMessagesVersion, targetPath) ?? 0;
    if (latestVersion !== myVersion) {
      // 已经有更新的 loadMessages 在途，stale 响应不应覆盖新状态。
      // todos 与 messages 必须作为同一份 hydrate 快照一起生效或一起丢弃。
      return;
    }
    const messageLiveVersionNow = readMessageLiveVersion(targetPath);
    if (messageLiveVersionNow !== messageLiveVersionBefore) {
      console.log(
        '[loadMessages] 跳过 session hydrate: mid-flight 收到 live message 更新',
        targetPath,
      );
      return;
    }
    const todosLiveVersionNow =
      sessionScopedValue(useStore.getState() as Record<string, any>, useStore.getState().todosLiveVersionBySession, targetPath) ?? 0;
    if (todosLiveVersionNow !== todosLiveVersionBefore) {
      console.log(
        '[loadMessages] 跳过 session hydrate: mid-flight 收到 live todo 更新',
        targetPath,
      );
      return;
    }
    // per-session todos（防御性兼容层：即使后端漏转或缓存残留，这里兜底再转一次）
    const rawTodos = data.todos || [];
    const migratedTodos = migrateLegacyTodos({ todos: rawTodos });
    const items = buildItemsFromHistory(data);
    // 修订点 stamp：记录本次快照对应的磁盘修订点，后续 reconcile 与列表投影对比。
    const revision = typeof data.revision === 'string' ? data.revision : null;
    useStore.getState().setSessionRegistryFiles(
      targetPath,
      Array.isArray(data.sessionFiles) ? data.sessionFiles : [],
    );
    useStore.getState().setSessionTodosForPath(targetPath, migratedTodos);
    if (items.length > 0) {
      useStore.getState().initSession(targetPath, items, data.hasMore ?? false, revision);
      if (targetPath === useStore.getState().currentSessionPath) {
        useStore.setState({ welcomeVisible: false });
      }
    } else {
      useStore.getState().initSession(targetPath, [], false, revision);
    }
    // In-flight guard: jsonl 仅在 turn_end 落盘。若 session 在 stream 进行中
    // 被 reload（switchSession 冷启动 / stream-resume truncated），合并 buffer
    // 当前快照作为末尾 assistant，避免 UI 上"正在写的消息消失"。
    // 同步执行，不 await，保证中途不会有 text_delta 事件插入。
    const snapshot = snapshotStreamBuffer(targetPath);
    if (snapshot?.hasContent) {
      useStore.getState().appendItem(targetPath, {
        type: 'message',
        data: buildInflightAssistantMessage(snapshot),
      });
    }
  } catch (err) { console.error('[loadMessages] error:', err); }
}

export async function completeSessionTodos(sessionPath: string): Promise<boolean> {
  if (!sessionPath) return false;
  const state = useStore.getState();
  if (sessionScopedListIncludes(state as Record<string, any>, state.streamingSessions, sessionPath)) return false;

  try {
    await hanaFetch('/api/sessions/todos/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: sessionPath }),
    });
    useStore.getState().setSessionTodosForPath(sessionPath, []);
    useStore.getState().bumpTodosLiveVersion(sessionPath);
    return true;
  } catch (err) {
    const message = errorMessage(err);
    useStore.getState().addToast(message, 'error', 6000);
    return false;
  }
}

function buildInflightAssistantMessage(snap: StreamBufferSnapshot): ChatMessage {
  const blocks: ContentBlock[] = [];
  if (snap.thinking || snap.inThinking) {
    blocks.push({ type: 'thinking', content: snap.thinking, sealed: !snap.inThinking });
  }
  if (snap.mood) {
    blocks.push({ type: 'mood', yuan: snap.moodYuan, text: snap.mood });
  }
  if (snap.text) {
    const displayText = snap.text.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '');
    blocks.push({ type: 'text', html: renderMarkdown(displayText), source: displayText });
  }
  return { id: snap.messageId || `inflight-${Date.now()}`, role: 'assistant', blocks, timestamp: Date.now() };
}

/** 上滑加载更早的消息（分页） */
export async function loadMoreMessages(forPath?: string): Promise<void> {
  const targetPath = forPath || useStore.getState().currentSessionPath;
  if (!targetPath) return;
  const session = sessionScopedValue(useStore.getState() as Record<string, any>, useStore.getState().chatSessions, targetPath);
  if (!session || !session.hasMore || session.loadingMore) return;

  useStore.getState().setLoadingMore(targetPath, true);
  try {
    const before = session.oldestId ?? '';
    const res = await hanaFetch(sessionMessagesUrl(targetPath, { before }));
    const data = await res.json();
    if (Array.isArray(data.sessionFiles)) {
      useStore.getState().setSessionRegistryFiles(targetPath, data.sessionFiles);
    }
    const items = buildItemsFromHistory(data);
    if (items.length > 0) {
      useStore.getState().prependItems(targetPath, items, data.hasMore ?? false);
    } else {
      useStore.getState().setLoadingMore(targetPath, false);
    }
  } catch (err) {
    console.error('[loadMoreMessages] error:', err);
    useStore.getState().setLoadingMore(targetPath, false);
  }
}

// ══════════════════════════════════════════════════════
// 会话修订点校验补拉（issue #1610）
// ══════════════════════════════════════════════════════

// per-session in-flight 去重：focus / online / WS reconnect 等触发器可能同时到达，
// 同一会话同一时刻最多一个补拉请求在途。
const _revisionReconcileInFlight = new Map<string, Promise<void>>();

/**
 * 校验「当前打开会话」的缓存内容是否落后于磁盘真相，落后则补拉。
 *
 * 修订点对比：chatSessions[path].revision（hydrate 时 stamp 的 stat 签名）
 * vs store.sessions 列表投影的 revision（最近一次列表刷新看到的磁盘状态）。
 * 两者不一致说明磁盘在本端没有消费到的窗口内前进过——典型场景是 Bridge /rc
 * 接管期间 web/mobile 端 WS 断连（手机锁屏），live 事件全部丢失。
 *
 * 边界（刻意保守，宁可少拉）：
 *   - 只处理当前打开的会话；后台会话切换回来时由 switchSession 触发同一校验
 *   - 流式进行中不补拉：live 事件流正在喂内容，turn 结束后列表刷新会再触发
 *   - 列表投影无 revision（老服务端 / 内存占位）不盲拉
 *   - 缓存 revision 为 null（未知，如 WS 端新会话的空 init）且列表有 revision
 *     时补拉一次，把修订点 stamp 上
 *
 * 调用方约定：在「拿到新鲜列表之后」调用（loadSessions / loadMobileSessions 之后），
 * 否则对比的是旧投影，没有意义。
 */
export function reconcileCurrentSessionMessages(reason = 'unknown'): Promise<void> | undefined {
  const s = useStore.getState();
  const target = s.currentSessionPath;
  if (!target || s.pendingNewSession || s.pendingSessionSwitchPath) return undefined;
  if (sessionScopedListIncludes(s as Record<string, any>, s.streamingSessions || [], target)) return undefined;
  const cached = sessionScopedValue(s as Record<string, any>, s.chatSessions, target);
  if (!cached) return undefined; // 冷启动 / 切换路径负责首载
  const projection = s.sessions.find((session) => session.path === target);
  const listRevision = typeof projection?.revision === 'string' ? projection.revision : null;
  if (!listRevision) return undefined;
  if ((cached.revision ?? null) === listRevision) return undefined;

  const existing = _revisionReconcileInFlight.get(target);
  if (existing) return existing;

  const inFlight = loadMessages(target)
    .catch((err) => {
      // loadMessages 内部已兜底，这里只防御未来改动让异常冒出导致 in-flight 卡死。
      console.warn(`[session] revision reconcile failed (${reason}):`, err);
    })
    .finally(() => {
      _revisionReconcileInFlight.delete(target);
    });
  _revisionReconcileInFlight.set(target, inFlight);
  return inFlight;
}

// ══════════════════════════════════════════════════════
// Session 列表
// ══════════════════════════════════════════════════════

export async function loadSessions(): Promise<void> {
  try {
    const res = await hanaFetch('/api/sessions');
    const data = await res.json();
    const sessions = data || [];

    const s = useStore.getState();
    useStore.setState((state: any) => ({
      sessions,
      sessionLocatorsById: mergeSessionLocators(state.sessionLocatorsById || {}, sessions),
    }));

    if (sessions.length > 0 && !s.currentSessionPath && !s.pendingNewSession && !s.pendingSessionSwitchPath) {
      // 首次加载：走完整的 switchSession 确保后端同步 + 消息加载
      await switchSession(sessions[0].path);
    }
  } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════
// Session 切换
// ══════════════════════════════════════════════════════

export async function switchSession(path: string): Promise<void> {
  const s = useStore.getState();
  const myVersion = ++_switchVersion;
  _switchAbortController?.abort();
  _switchAbortController = null;

  if (path === s.currentSessionPath && !s.pendingNewSession) {
    useStore.setState(state => ({
      pendingSessionSwitchPath: null,
      unreadOutputSessionPaths: filterSessionScopedStateList(state as Record<string, any>, state.unreadOutputSessionPaths || [], path),
    }));
    return;
  }

  useStore.setState({ pendingSessionSwitchPath: path });

  if (isDeletedAgentSession(path)) {
    await switchDeletedAgentSession(path, myVersion);
    return;
  }

  // 关闭浮动面板
  const activePanel = useStore.getState().activePanel;
  if (activePanel === 'activity' || activePanel === 'automation') {
    useStore.getState().setActivePanel(null);
  }

  const abortController = new AbortController();
  _switchAbortController = abortController;
  const targetSessionId = sessionIdForPathFromState(s as Record<string, any>, path);

  try {
    const res = await hanaFetch('/api/sessions/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path,
        ...(targetSessionId ? { sessionId: targetSessionId } : {}),
        currentSessionPath: s.currentSessionPath,
      }),
      signal: abortController.signal,
    });
    const data = await res.json();
    if (!isCurrentSwitch(myVersion, path)) return;
    if (data.error) {
      console.error('[session] switch failed:', data.error);
      useStore.setState({ pendingSessionSwitchPath: null });
      showSessionSwitchError(path, data.error);
      return;
    }

    const state = useStore.getState();

    // 以服务端事实对齐当前 session 的流式状态。刷新或重连后，renderer 的本地集合可能已经过期。
    const isStreaming = data.isStreaming === true;
    const streamingSessions = reconcileStreamingSessionsForPath(state as Record<string, any>, state.streamingSessions, path, isStreaming);
    const activeSessionStreams = { ...(state.activeSessionStreams || {}) };
    const activeStreamKey = sessionScopedKey(state as Record<string, any>, path) || path;
    if (isStreaming) {
      activeSessionStreams[activeStreamKey] = activeSessionStreams[activeStreamKey]
        || activeSessionStreams[path]
        || { streamId: null, turnId: null };
      if (activeStreamKey !== path) delete activeSessionStreams[path];
    } else {
      delete activeSessionStreams[activeStreamKey];
      delete activeSessionStreams[path];
    }

    // 同步全局 agent 上下文
    const switchedAgent = data.agentId && data.agentId !== state.currentAgentId;
    const agentPatch: Record<string, any> = {};

    if (switchedAgent) {
      const ag = state.agents.find((a: any) => a.id === data.agentId);
      agentPatch.currentAgentId = data.agentId;
      agentPatch.agentName = data.agentName || ag?.name || data.agentId;
      agentPatch.agentYuan = ag?.yuan || 'hanako';
      agentPatch.agentAvatarUrl = ag?.hasAvatar ? hanaUrl(`/api/agents/${data.agentId}/avatar?t=${Date.now()}`) : null;
    }

    // 保存当前 session 的附件到 keyed store
    const currentPath = s.currentSessionPath;
    const currentAttachments = state.attachedFiles;
    if (currentPath) {
      useStore.setState(prev => ({
        attachedFilesBySession: putSessionScopedStateValue(
          prev as Record<string, any>,
          prev.attachedFilesBySession || {},
          currentPath,
          [...currentAttachments],
        ),
      }));
    }

    // 在设置 currentSessionPath 之前预加载消息历史。
    // 一旦 currentSessionPath 指向新 session，主窗口 WebSocket 会将该 session 的流式事件
    // 路由到 streamBufferManager，触发 bumpMessageLiveVersion，导致 loadMessages 的
    // 竞态守卫跳过 hydrate，store 丢失完整历史。提前加载可避免此竞态。
    const hasData = !!sessionScopedValue(useStore.getState() as Record<string, any>, useStore.getState().chatSessions, path);
    if (!hasData) {
      await loadMessages(path);
      if (myVersion !== _switchVersion) return;
    }

    // 批量更新 store（切 currentSessionPath 切换对话内容；可见 desk/preview 状态由 workspace 激活流程恢复）
    useStore.setState((prev: any) => ({
      ...currentSessionIdentityPatch(prev, path, data.sessionId),
      pendingSessionSwitchPath: null,
      pendingNewSession: false,
      pendingProjectId: null,
      selectedFolder: null,
      selectedWorkspaceMountId: null,
      selectedWorkspaceLabel: null,
      workspaceFolders: Array.isArray(data.workspaceFolders) ? data.workspaceFolders : [],
      sessionAuthorizedFoldersByPath: {
        ...putSessionScopedStateValue(
          state,
          state.sessionAuthorizedFoldersByPath || {},
          path,
          Array.isArray(data.authorizedFolders) ? data.authorizedFolders : [],
        ),
      },
      selectedAgentId: null,
      welcomeVisible: false,
      memoryEnabled: data.memoryEnabled !== false,
      streamingSessions,
      activeSessionStreams,
      unreadOutputSessionPaths: filterSessionScopedStateList(state as Record<string, any>, state.unreadOutputSessionPaths || [], path),
      attachedFiles: sessionScopedValue(state as Record<string, any>, state.attachedFilesBySession || {}, path) || [],
      deskContextAttached: false,
      docContextAttached: false,
      ...agentPatch,
    }));

    // 缓存命中跳过了 loadMessages 时，校验修订点：会话在后台期间（如 Bridge /rc
    // 接管 + 本端 WS 断连）磁盘可能已前进，缓存不能直接当真相（issue #1610）。
    // fire-and-forget：先呈现缓存内容，补拉结果通过 store 更新自然落地。
    if (hasData) {
      void reconcileCurrentSessionMessages('session_switch');
    }

    await resetDeskForSessionWorkspace({
      cwd: data.cwd || null,
      workspaceMountId: data.workspaceMountId || null,
      workspaceLabel: data.workspaceLabel || null,
    });
    if (myVersion !== _switchVersion) return;

    // 同步浏览器状态到 keyed store（服务端返回当前 session 的 browser 状态）
    if (path) {
      setBrowserStateForPath(path, {
        running: !!data.browserRunning,
        url: data.browserUrl || null,
        thumbnail: data.browserRunning ? (browserStateForPath(state as any, path).thumbnail ?? null) : null,
      });
    }

    useStore.getState().clearQuotedSelection();

    emitSessionPermissionMode(data.permissionMode || data.accessMode);
    if (data.thinkingLevel) {
      useStore.getState().setThinkingLevel(data.thinkingLevel);
    }

    // 刷新模型列表（当前 session 的模型可能不同）
    loadModels();

    // Hydrate per-session model snapshot from switch response。
    // provider 缺失不写入——空 provider 会让 ModelSelector 的复合键匹配全错
    // （老 session 的 meta 可能没带 provider，走 migration 或下一次显式选择修复）。
    if (data.currentModelId && data.currentModelProvider) {
      useStore.getState().updateSessionModel(path, {
        id: data.currentModelId,
        name: data.currentModelName || data.currentModelId,
        provider: data.currentModelProvider,
        input: Array.isArray(data.currentModelInput) ? data.currentModelInput : undefined,
        video: data.currentModelVideo ?? undefined,
        videoTransport: data.currentModelVideoTransport ?? undefined,
        videoTransportSupported: data.currentModelVideoTransportSupported ?? undefined,
        audio: data.currentModelAudio ?? undefined,
        audioTransport: data.currentModelAudioTransport ?? undefined,
        audioTransportSupported: data.currentModelAudioTransportSupported ?? undefined,
        reasoning: data.currentModelReasoning ?? undefined,
        xhigh: data.currentModelXhigh ?? undefined,
        thinkingLevels: Array.isArray(data.currentModelThinkingLevels) ? data.currentModelThinkingLevels : undefined,
        defaultThinkingLevel: data.currentModelDefaultThinkingLevel ?? undefined,
        contextWindow: data.currentModelContextWindow ?? undefined,
      });
    }

    // #1624：服务端在 restore 时算好的工具能力漂移提示（无漂移 / 已 dismiss → null）
    useStore.getState().setSessionCapabilityDrift(path, data.capabilityDrift || null);

    await requestActiveSessionStreamResume(path, isStreaming);
    if (myVersion !== _switchVersion) return;

    // 切换会话后刷新 context ring
    useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });
    import('../services/websocket').then(({ getWebSocket }) => {
      const wsConn = getWebSocket();
      if (wsConn?.readyState === WebSocket.OPEN) {
        const sessionId = sessionIdForPathFromState(useStore.getState() as Record<string, any>, path);
        wsConn.send(JSON.stringify({
          type: 'context_usage',
          sessionPath: path,
          ...(sessionId ? { sessionId } : {}),
        }));
      }
    }).catch((err) => {
      console.warn('[session] context usage refresh skipped:', err);
    });

    // Restore input focus only if the user is still in the chat surface that initiated the switch.
    requestChatInputFocus(path);
  } catch (err) {
    if (myVersion !== _switchVersion || isAbortError(err)) return;
    useStore.setState((state: Record<string, any>) => (
      state.pendingSessionSwitchPath === path ? { pendingSessionSwitchPath: null } : {}
    ));
    console.error('[session] switch failed:', err);
    showSessionSwitchError(path, errorMessage(err));
  } finally {
    if (_switchAbortController === abortController) {
      _switchAbortController = null;
    }
  }
}

async function switchDeletedAgentSession(path: string, version: number): Promise<void> {
  const state = useStore.getState();
  const projection = findSessionProjection(path);
  const currentPath = state.currentSessionPath;
  const currentAttachments = state.attachedFiles;
  if (currentPath) {
    useStore.setState(prev => ({
      attachedFilesBySession: putSessionScopedStateValue(
        prev as Record<string, any>,
        prev.attachedFilesBySession || {},
        currentPath,
        [...currentAttachments],
      ),
    }));
  }

  useStore.setState({
    currentSessionPath: path,
    pendingSessionSwitchPath: null,
    pendingNewSession: false,
    pendingProjectId: null,
    selectedFolder: null,
    selectedWorkspaceMountId: null,
    selectedWorkspaceLabel: null,
    workspaceFolders: [],
    sessionAuthorizedFoldersByPath: {
      ...putSessionScopedStateValue(state, state.sessionAuthorizedFoldersByPath || {}, path, []),
    },
    selectedAgentId: null,
    welcomeVisible: false,
    streamingSessions: filterSessionScopedStateList(state as Record<string, any>, state.streamingSessions, path),
    activeSessionStreams: Object.fromEntries(
      Object.entries(state.activeSessionStreams || {}).filter(([sessionPath]) => {
        const key = sessionScopedKey(state as Record<string, any>, path) || path;
        return sessionPath !== key && sessionPath !== path;
      }),
    ),
    unreadOutputSessionPaths: filterSessionScopedStateList(state as Record<string, any>, state.unreadOutputSessionPaths || [], path),
    attachedFiles: sessionScopedValue(state as Record<string, any>, state.attachedFilesBySession || {}, path) || [],
    deskContextAttached: false,
    docContextAttached: false,
  });

  await resetDeskForSessionWorkspace({
    cwd: projection?.cwd || null,
    workspaceMountId: (projection as any)?.workspaceMountId || null,
    workspaceLabel: (projection as any)?.workspaceLabel || null,
  });
  if (version !== _switchVersion) return;

  useStore.getState().clearQuotedSelection();
  emitSessionPermissionMode('read_only');

  const hasData = !!sessionScopedValue(useStore.getState() as Record<string, any>, useStore.getState().chatSessions, path);
  if (!hasData) {
    await loadMessages(path);
  }
}

// ══════════════════════════════════════════════════════
// 新建 Session
// ══════════════════════════════════════════════════════

interface CreateNewSessionOptions {
  projectId?: string | null;
  cwd?: string | null;
}

export async function loadPendingNewSessionPermissionDefault(): Promise<SessionPermissionMode> {
  try {
    const res = await hanaFetch('/api/preferences/session-permission-default');
    const data = await res.json();
    const mode = normalizeSessionPermissionMode(data.permissionMode);
    if (isPendingNewSessionDraftView()) emitSessionPermissionMode(mode);
    return mode;
  } catch (err) {
    console.warn('[session] load permission default failed:', err);
    if (isPendingNewSessionDraftView()) emitSessionPermissionMode('ask');
    return 'ask';
  }
}

export async function createNewSession(options: CreateNewSessionOptions = {}): Promise<void> {
  // Entering the pending new-session workspace is a navigation boundary.
  // Any in-flight switchSession response now belongs to the previous view.
  invalidateSessionSwitches();

  // 关闭浮动面板
  if (useStore.getState().activePanel === 'activity') {
    useStore.getState().setActivePanel(null);
  }

  const s = useStore.getState();
  const requestedFolder = typeof options.cwd === 'string' && options.cwd.trim() ? options.cwd.trim() : null;
  const defaultWorkspaceMountId = requestedFolder ? null : (s.deskWorkspaceMountId || null);
  const defaultWorkspaceLabel = defaultWorkspaceMountId ? (s.deskWorkspaceLabel || null) : null;
  const defaultFolder = requestedFolder || s.homeFolder || (defaultWorkspaceMountId ? null : s.deskBasePath) || null;
  const pendingProjectId = typeof options.projectId === 'string' && options.projectId.trim()
    ? options.projectId.trim()
    : null;

  useStore.setState({
    welcomeVisible: true,
    currentSessionPath: null,
    pendingSessionSwitchPath: null,
    // 有显式 Agent home 时以 home 为准；没有绑定 workspace 的 agent
    // 以当前 session cwd 延续工作流，不从其他 agent 的 home_folder 推导。
    selectedFolder: defaultFolder,
    selectedWorkspaceMountId: defaultWorkspaceMountId,
    selectedWorkspaceLabel: defaultWorkspaceLabel,
    workspaceFolders: [],
    selectedAgentId: null,
    pendingNewSession: true,
    pendingProjectId,
    pendingNewSessionThinkingLevel: null,
    pendingNewSessionPermissionMode: null,
    attachedFiles: [],
    deskContextAttached: false,
    docContextAttached: false,
  });

  await activateWorkspaceDesk(defaultFolder, {
    mountId: defaultWorkspaceMountId,
    label: defaultWorkspaceLabel,
  });

  // 重置 context ring
  useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });
  await loadPendingNewSessionPermissionDefault();

  try {
    const res = await hanaFetch('/api/session-thinking-level?pendingNewSession=1');
    const data = await res.json();
    if (data.thinkingLevel && isPendingNewSessionDraftView()) {
      useStore.getState().setThinkingLevel(data.thinkingLevel);
      useStore.getState().setPendingNewSessionThinkingLevel(data.thinkingLevel);
    }
  } catch {
    useStore.getState().setPendingNewSessionThinkingLevel(null);
  }

  // pending 状态下刷新 model 列表，让 ModelSelector 显示 agent Chat 默认 model
  loadModels();

  requestChatInputFocus(null);
}

// ══════════════════════════════════════════════════════
// 确保 Session 存在（首次发消息时调用）
// ══════════════════════════════════════════════════════

export async function ensureSession(): Promise<boolean> {
  const s = useStore.getState();
  if (!s.pendingNewSession) return true;

  try {
    const body: Record<string, any> = { memoryEnabled: s.memoryEnabled };
    if (s.selectedWorkspaceMountId) {
      body.workspaceMountId = s.selectedWorkspaceMountId;
    } else if (s.selectedFolder) {
      body.cwd = s.selectedFolder;
    }
    if (s.workspaceFolders?.length) {
      body.workspaceFolders = s.workspaceFolders;
    }
    if (s.pendingProjectId) {
      body.projectId = s.pendingProjectId;
    }
    if (s.pendingNewSessionThinkingLevel) {
      body.thinkingLevel = s.pendingNewSessionThinkingLevel;
    }
    if (s.pendingNewSessionPermissionMode) {
      body.permissionMode = s.pendingNewSessionPermissionMode;
    }
    if (s.selectedAgentId && s.selectedAgentId !== s.currentAgentId) {
      body.agentId = s.selectedAgentId;
    }
    body.currentSessionPath = s.currentSessionPath;

    const res = await hanaFetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      throwOnHttpError: false,
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] create failed:', data.error);
      showSessionCreationError(data.error);
      return false;
    }

    const justSelected = s.selectedFolder;
    const justSelectedMount = s.selectedWorkspaceMountId;

    // 基础状态更新
    const patch: Record<string, any> = {
      pendingNewSession: false,
      pendingSessionSwitchPath: null,
      selectedFolder: null,
      selectedWorkspaceMountId: null,
      selectedWorkspaceLabel: null,
      pendingProjectId: null,
      pendingNewSessionThinkingLevel: null,
      pendingNewSessionPermissionMode: null,
      workspaceFolders: Array.isArray(data.workspaceFolders) ? data.workspaceFolders : [],
      selectedAgentId: null,
    };

    if (data.agentId) {
      const switched = data.agentId !== s.currentAgentId;
      patch.currentAgentId = data.agentId;
      if (data.agentName) patch.agentName = data.agentName;
      if (switched) {
        const ag = s.agents.find((a: any) => a.id === data.agentId);
        if (ag?.yuan) patch.agentYuan = ag.yuan;
        patch.agentAvatarUrl = null;
        window.i18n.defaultName = data.agentName || s.agentName;
        // 异步刷新头像
        hanaFetch('/api/health').then((r: Response) => r.json()).then((d: any) => {
          loadAvatarsAction(d.avatars);
        }).catch(() => {
          loadAvatarsAction();
        });
      }
    }

    if (data.path) {
      Object.assign(patch, currentSessionIdentityPatch(useStore.getState() as Record<string, any>, data.path, data.sessionId));
      patch.sessionAuthorizedFoldersByPath = {
        ...putSessionScopedStateValue(
          useStore.getState() as Record<string, any>,
          useStore.getState().sessionAuthorizedFoldersByPath || {},
          data.path,
          Array.isArray(data.authorizedFolders) ? data.authorizedFolders : [],
        ),
      };
      // 初始化空 session，ChatArea 自动渲染
      useStore.getState().initSession(data.path, [], false);
    }

    useStore.setState(patch);
    if (data.thinkingLevel) {
      useStore.getState().setThinkingLevel(data.thinkingLevel);
    }

    await resetDeskForSessionWorkspace({
      cwd: data.cwd || null,
      workspaceMountId: data.workspaceMountId || justSelectedMount || null,
      workspaceLabel: data.workspaceLabel || s.selectedWorkspaceLabel || null,
    });

    emitSessionPermissionMode(data.permissionMode || data.accessMode || s.pendingNewSessionPermissionMode);

    await loadSessions();

    // 刷新模型列表：session 创建后 activeModel 已绑定，需要同步到 UI
    loadModels();

    // 更新 cwdHistory
    if (justSelected && !justSelectedMount) {
      const currentState = useStore.getState();
      let cwdHistory = currentState.cwdHistory.filter((p: string) => p !== justSelected);
      cwdHistory = [justSelected, ...cwdHistory];
      if (cwdHistory.length > 10) cwdHistory = cwdHistory.slice(0, 10);
      useStore.setState({ cwdHistory });
    }

    return true;
  } catch (err) {
    console.error('[session] create failed:', err);
    showSessionCreationError(errorMessage(err));
    return false;
  }
}

export async function continueDeletedAgentSession(path: string): Promise<boolean> {
  try {
    const res = await hanaFetch('/api/sessions/continue-deleted-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (!res.ok || data.error || !data.path) {
      const message = data.error || res.statusText || 'continue failed';
      console.error('[session] continue deleted-agent session failed:', message);
      useStore.getState().addToast(`${tr('session.deletedAgent.continueFailed')}: ${message}`, 'error', 6000);
      return false;
    }

    await loadSessions();
    await switchSession(data.path);
    if (data.compactionError) {
      useStore.getState().addToast(
        `${tr('session.deletedAgent.continueCompactionFailed')}: ${data.compactionError}`,
        'warning',
        6000,
      );
    }
    return true;
  } catch (err) {
    console.error('[session] continue deleted-agent session failed:', err);
    useStore.getState().addToast(`${tr('session.deletedAgent.continueFailed')}: ${errorMessage(err)}`, 'error', 6000);
    return false;
  }
}

// ══════════════════════════════════════════════════════
// 归档 Session
// ══════════════════════════════════════════════════════

export async function archiveSession(path: string): Promise<void> {
  try {
    const res = await hanaFetch('/api/sessions/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] archive failed:', data.error);
      showSidebarToast(window.t('session.archiveFailed'));
      return;
    }

    const s = useStore.getState();
    const isCurrent = path === s.currentSessionPath;
    clearSessionRuntimeCaches(path);
    if (isCurrent) {
      clearChatAction();
      useStore.setState({ currentSessionPath: null });
    }

    await loadSessions();

    const updated = useStore.getState();
    if (updated.sessions.length === 0) {
      await createNewSession();
    } else if (!updated.currentSessionPath) {
      await switchSession(updated.sessions[0].path);
    }
  } catch (err) {
    console.error('[session] archive failed:', err);
    showSidebarToast(window.t('session.archiveFailed'));
  }
}

// ══════════════════════════════════════════════════════
// 归档管理：列出 / 恢复 / 永久删 / 批量清理
// ══════════════════════════════════════════════════════

export interface ArchivedSession {
  path: string;
  title: string | null;
  archivedAt: string;
  sizeBytes: number;
  agentId: string;
  agentName: string;
}

export type RestoreResult = 'ok' | 'conflict' | 'error';

export async function listArchivedSessions(): Promise<ArchivedSession[]> {
  try {
    const res = await hanaFetch('/api/sessions/archived');
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error('[archived] list failed:', err);
    return [];
  }
}

export async function restoreSession(path: string): Promise<RestoreResult> {
  try {
    const res = await hanaFetch('/api/sessions/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (res.status === 409) return 'conflict';
    if (!res.ok) return 'error';
    return 'ok';
  } catch (err) {
    console.error('[archived] restore failed:', err);
    return 'error';
  }
}

export async function deleteArchivedSession(path: string): Promise<boolean> {
  try {
    const res = await hanaFetch('/api/sessions/archived/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    return res.ok;
  } catch (err) {
    console.error('[archived] delete failed:', err);
    return false;
  }
}

export async function cleanupArchivedSessions(maxAgeDays: 30 | 90): Promise<{ deleted: number }> {
  try {
    const res = await hanaFetch('/api/sessions/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgeDays }),
    });
    if (!res.ok) return { deleted: 0 };
    const data = await res.json();
    return { deleted: data.deleted ?? 0 };
  } catch (err) {
    console.error('[archived] cleanup failed:', err);
    return { deleted: 0 };
  }
}

// ══════════════════════════════════════════════════════
// 重命名 Session
// ══════════════════════════════════════════════════════

export async function renameSession(path: string, title: string): Promise<boolean> {
  try {
    const res = await hanaFetch('/api/sessions/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, title }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] rename failed:', data.error);
      return false;
    }
    // 乐观更新 store 中的 title
    const sessions = useStore.getState().sessions.map(s =>
      s.path === path ? { ...s, title } : s,
    );
    useStore.setState({ sessions });
    return true;
  } catch (err) {
    console.error('[session] rename failed:', err);
    return false;
  }
}

// ══════════════════════════════════════════════════════
// 置顶 / 取消置顶 Session
// ══════════════════════════════════════════════════════

export async function pinSession(path: string, pinned: boolean): Promise<boolean> {
  try {
    const localSessionId = sessionIdForPathFromState(useStore.getState() as Record<string, any>, path);
    const res = await hanaFetch('/api/sessions/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path,
        ...(localSessionId ? { sessionId: localSessionId } : {}),
        pinned,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      console.error('[session] pin failed:', data.error || res.statusText);
      showSidebarToast(window.t(pinned ? 'session.pinFailed' : 'session.unpinFailed'));
      return false;
    }

    const pinnedAt = typeof data.pinnedAt === 'string' ? data.pinnedAt : null;
    const responseSessionId = normalizeSessionId(data.sessionId) || localSessionId;
    const sessions = useStore.getState().sessions.map(s =>
      (responseSessionId && normalizeSessionId(s.sessionId) === responseSessionId) || s.path === path
        ? { ...s, pinnedAt }
        : s,
    );
    useStore.setState({ sessions });
    return true;
  } catch (err) {
    console.error('[session] pin failed:', err);
    showSidebarToast(window.t(pinned ? 'session.pinFailed' : 'session.unpinFailed'));
    return false;
  }
}

// ══════════════════════════════════════════════════════
// #1624 工具能力漂移：dismiss / 显式刷新（fresh compact）
// ══════════════════════════════════════════════════════

/** 关闭当前 fingerprint 的提示；服务端持久化在 session-meta，指纹再变才重新提示 */
export async function dismissSessionCapabilityDrift(path: string, fingerprint: string): Promise<boolean> {
  // 乐观隐藏：dismiss 是低风险操作，失败时恢复提示
  const prevDrift = sessionScopedValue(
    useStore.getState() as Record<string, any>,
    useStore.getState().capabilityDriftBySession,
    path,
  ) || null;
  useStore.getState().setSessionCapabilityDrift(path, null);
  try {
    const res = await hanaFetch('/api/sessions/capability-drift/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, fingerprint }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || res.statusText);
    return true;
  } catch (err) {
    console.warn('[session] capability drift dismiss failed:', err);
    useStore.getState().setSessionCapabilityDrift(path, prevDrift);
    return false;
  }
}

/**
 * 显式刷新 Agent 工具：fresh compact——旧对话压缩成摘要 checkpoint，
 * 用当前配置重建 prompt/工具快照。成功后重新拉取消息（jsonl 多了 compact 记录）。
 */
export async function refreshSessionCapabilities(path: string): Promise<boolean> {
  const store = useStore.getState();
  if (sessionScopedListIncludes(store as Record<string, any>, store.capabilityRefreshingSessions, path)) return false;
  store.setSessionCapabilityRefreshing(path, true);
  try {
    const res = await hanaFetch('/api/sessions/fresh-compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
      // Fresh compact runs an LLM summarization over the whole conversation;
      // long sessions routinely exceed the 30s hanaFetch default. A premature
      // abort here surfaces a false failure while the server keeps compacting.
      timeout: 180_000,
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || res.statusText);
    useStore.getState().setSessionCapabilityDrift(path, data.capabilityDrift || null);
    await loadMessages(path);
    return true;
  } catch (err) {
    console.error('[session] capability refresh failed:', err);
    const state = useStore.getState();
    state.setInlineError?.(path, `${tr('session.capabilityDrift.refreshFailed')}: ${errorMessage(err)}`, 6000);
    return false;
  } finally {
    useStore.getState().setSessionCapabilityRefreshing(path, false);
  }
}

// ══════════════════════════════════════════════════════
// Toast
// ══════════════════════════════════════════════════════

export function showSidebarToast(text: string, duration = 3000): void {
  useStore.getState().addToast(text, 'info', duration);
}

function tr(key: string): string {
  return typeof window !== 'undefined' && typeof window.t === 'function'
    ? window.t(key)
    : key;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || 'Unknown error');
}

function showSessionCreationError(detail: unknown): void {
  const label = tr('session.createFailed');
  const message = `${label}: ${errorMessage(detail)}`;
  const state = useStore.getState();
  state.setInlineError?.(state.currentSessionPath || '', message, 6000);
  state.addToast(message, 'error', 6000);
}

function showSessionSwitchError(targetPath: string, detail: unknown): void {
  const label = tr('session.switchFailed');
  const message = `${label}: ${errorMessage(detail)}`;
  const state = useStore.getState();
  state.setInlineError?.(state.currentSessionPath || targetPath || '', message, 6000);
  state.addToast(message, 'error', 6000);
}
