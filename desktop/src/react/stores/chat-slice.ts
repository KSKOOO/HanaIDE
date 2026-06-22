/**
 * chat-slice.ts — Per-session 消息数据 + 滚动位置
 */

import type { ChatListItem, ChatMessage, ContentBlock, SessionMessages, SessionModel, SessionRegistryFile } from './chat-types';
import { invalidateSessionCache } from './selectors/file-refs';
import { invalidateStreamBuffer, invalidateStreamResumeMeta } from './stream-invalidator';
import { bumpMessageLiveVersion, clearMessageLiveVersion } from './message-live-version';
import { sessionScopedKey, sessionScopedValue } from './session-slice';

export interface ChatSlice {
  chatSessions: Record<string, SessionMessages>;
  sessionRegistryFilesByPath: Record<string, SessionRegistryFile[]>;
  /**
   * Per-session 模型快照。与 chatSessions 解耦：模型可以独立于消息状态存在，
   * 避免 updateSessionModel 在 chatSessions 里写 stub 骗过 hasData 判据（issue #405）。
   */
  sessionModelsByPath: Record<string, SessionModel>;
  /**
   * loadMessages 的 per-path 版本号，用于拒绝 stale 响应 clobber 新状态
   * （rapid switch / duplicate load 竞态护栏，pattern 来自 todosLiveVersionBySession）。
   */
  _loadMessagesVersion: Record<string, number>;
  scrollPositions: Record<string, number>;

  initSession: (path: string, items: ChatListItem[], hasMore: boolean, revision?: string | null) => void;
  prependItems: (path: string, items: ChatListItem[], hasMore: boolean) => void;
  appendItem: (path: string, item: ChatListItem) => void;
  appendOptimisticUserMessage: (path: string, message: ChatMessage) => void;
  confirmOptimisticUserMessage: (path: string, clientMessageId: string, message: ChatMessage) => boolean;
  markOptimisticUserMessageFailed: (path: string, clientMessageId: string, error: string) => boolean;
  updateLastMessage: (path: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  updateMessageById: (path: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => boolean;
  truncateSessionFromMessage: (path: string, messageId: string) => boolean;
  insertInterludeItemNearTaskResult: (sessionPath: string, taskId: string | null, block: Extract<ContentBlock, { type: 'interlude' }>) => boolean;
  resolveBlockByTaskId: (sessionPath: string, taskId: string, resolution: ContentBlock) => boolean;
  patchBlockByTaskId: (sessionPath: string, taskId: string, patch: Record<string, any>) => void;
  _pendingBlockPatches: Record<string, Record<string, any>>;
  setSessionRegistryFiles: (path: string, files: SessionRegistryFile[]) => void;
  upsertSessionRegistryFile: (path: string, file: SessionRegistryFile) => void;

  updateSessionModel: (path: string, model: SessionModel) => void;
  bumpLoadMessagesVersion: (path: string) => number;
  setLoadingMore: (path: string, loading: boolean) => void;
  clearSession: (path: string) => void;
  saveScrollPosition: (path: string, scrollTop: number) => void;
}

const MAX_CACHED_SESSIONS = 8;

function keyForSession(state: Record<string, any>, path: string): string {
  return sessionScopedKey(state, path) || path;
}

function scopedMapValue<T>(state: Record<string, any>, map: Record<string, T>, path: string): T | undefined {
  return sessionScopedValue(state, map, path) as T | undefined;
}

function putScopedMapValue<T>(
  state: Record<string, any>,
  map: Record<string, T>,
  path: string,
  value: T,
): Record<string, T> {
  const key = keyForSession(state, path);
  const next = { ...map, [key]: value };
  if (key !== path) delete next[path];
  return next;
}

function deleteScopedMapValue<T>(
  state: Record<string, any>,
  map: Record<string, T>,
  path: string,
): Record<string, T> {
  const key = keyForSession(state, path);
  const next = { ...map };
  delete next[key];
  if (key !== path) delete next[path];
  return next;
}

export const createChatSlice = (
  set: (partial: Partial<ChatSlice> | ((s: ChatSlice) => Partial<ChatSlice>)) => void,
  get: () => ChatSlice,
): ChatSlice => ({
  chatSessions: {},
  sessionRegistryFilesByPath: {},
  sessionModelsByPath: {},
  _loadMessagesVersion: {},
  scrollPositions: {},

  initSession: (path, items, hasMore, revision = null) => set((s) => {
    const key = keyForSession(s as any, path);
    const sessions = { ...s.chatSessions };
    const registryFiles = { ...s.sessionRegistryFilesByPath };
    const scrollPositions = { ...s.scrollPositions };
    sessions[key] = {
      items,
      hasMore,
      loadingMore: false,
      oldestId: firstMessageId(items),
      revision,
    };
    if (key !== path) delete sessions[path];
    // LRU 淘汰：只淘汰消息缓存，不动模型快照（模型是轻量常驻数据）。
    // 被淘汰的 session 的 FileRef 缓存（含 inlineData base64）必须同步清，
    // 否则模块顶层的 cachedSession 会让载荷在 renderer 里滞留。
    const keys = Object.keys(sessions);
    if (keys.length > MAX_CACHED_SESSIONS) {
      const oldest = keys.find(k => k !== key);
      if (oldest) {
        delete sessions[oldest];
        delete registryFiles[oldest];
        delete scrollPositions[oldest];
        invalidateSessionCache(oldest);
        invalidateStreamBuffer(oldest);
        invalidateStreamResumeMeta(oldest);
      }
    }
    return { chatSessions: sessions, sessionRegistryFilesByPath: registryFiles, scrollPositions };
  }),

  prependItems: (path, items, hasMore) => set((s) => {
    const session = scopedMapValue<SessionMessages>(s as any, s.chatSessions, path);
    if (!session) return {};
    const merged = [...items, ...session.items];
    return {
      chatSessions: putScopedMapValue(s as any, s.chatSessions, path, {
          ...session,
          items: merged,
          hasMore,
          loadingMore: false,
          oldestId: firstMessageId(items) || session.oldestId,
        }),
    };
  }),

  appendItem: (path, item) => set((s) => {
    const session = scopedMapValue<SessionMessages>(s as any, s.chatSessions, path);
    if (!session) return {};
    return {
      chatSessions: putScopedMapValue(s as any, s.chatSessions, path, { ...session, items: [...session.items, item] }),
    };
  }),

  appendOptimisticUserMessage: (path, message) => {
    bumpMessageLiveVersion(path);
    set((s) => {
      const session = scopedMapValue<SessionMessages>(s as any, s.chatSessions, path) || {
        items: [],
        hasMore: false,
        loadingMore: false,
        oldestId: undefined,
        revision: null,
      };
      const existingIdx = session.items.findIndex((item) =>
        item.type === 'message' &&
        item.data.role === 'user' &&
        item.data.id === message.id,
      );
      const nextItem: ChatListItem = { type: 'message', data: message };
      const items = existingIdx >= 0 ? [...session.items] : [...session.items, nextItem];
      if (existingIdx >= 0) items[existingIdx] = nextItem;
      return {
        chatSessions: putScopedMapValue(s as any, s.chatSessions, path, {
            ...session,
            items,
            oldestId: session.oldestId || firstMessageId(items),
          }),
      };
    });
  },

  confirmOptimisticUserMessage: (path, clientMessageId, message) => {
    let consumed = false;
    set((s) => {
      const session = scopedMapValue<SessionMessages>(s as any, s.chatSessions, path);
      if (!session) return {};
      const targetIdx = session.items.findIndex((item) =>
        item.type === 'message' &&
        item.data.role === 'user' &&
        item.data.id === clientMessageId,
      );
      if (targetIdx < 0) return {};
      const items = [...session.items];
      const current = items[targetIdx];
      if (current.type !== 'message' || current.data.role !== 'user') return {};
      const nextData: ChatMessage = {
        ...current.data,
        ...message,
        id: current.data.id,
        sourceEntryId: message.sourceEntryId ?? current.data.sourceEntryId,
      };
      delete nextData.sendStatus;
      delete nextData.sendError;
      items[targetIdx] = { type: 'message', data: nextData };
      consumed = true;
      return {
        chatSessions: putScopedMapValue(s as any, s.chatSessions, path, { ...session, items }),
      };
    });
    return consumed;
  },

  markOptimisticUserMessageFailed: (path, clientMessageId, error) => {
    let consumed = false;
    set((s) => {
      const session = scopedMapValue<SessionMessages>(s as any, s.chatSessions, path);
      if (!session) return {};
      const targetIdx = session.items.findIndex((item) =>
        item.type === 'message' &&
        item.data.role === 'user' &&
        item.data.id === clientMessageId,
      );
      if (targetIdx < 0) return {};
      const items = [...session.items];
      const current = items[targetIdx];
      if (current.type !== 'message' || current.data.role !== 'user') return {};
      items[targetIdx] = {
        type: 'message',
        data: {
          ...current.data,
          sendStatus: 'failed',
          sendError: error,
        },
      };
      consumed = true;
      return {
        chatSessions: putScopedMapValue(s as any, s.chatSessions, path, { ...session, items }),
      };
    });
    if (consumed) bumpMessageLiveVersion(path);
    return consumed;
  },

  updateLastMessage: (path, updater) => set((s) => {
    const session = scopedMapValue<SessionMessages>(s as any, s.chatSessions, path);
    if (!session || session.items.length === 0) return {};
    const items = [...session.items];
    const lastIdx = items.length - 1;
    const last = items[lastIdx];
    if (last.type !== 'message') return {};
    items[lastIdx] = { type: 'message', data: updater(last.data) };
    return {
      chatSessions: putScopedMapValue(s as any, s.chatSessions, path, { ...session, items }),
    };
  }),

  updateMessageById: (path, messageId, updater) => {
    const session = scopedMapValue<SessionMessages>(get() as any, get().chatSessions, path);
    if (!session) return false;
    const targetIdx = session.items.findIndex((item) =>
      item.type === 'message' &&
      item.data.id === messageId &&
      item.data.role === 'assistant',
    );
    if (targetIdx < 0) return false;

    set((s) => {
      const latest = scopedMapValue<SessionMessages>(s as any, s.chatSessions, path);
      if (!latest) return {};
      const latestIdx = latest.items.findIndex((item) =>
        item.type === 'message' &&
        item.data.id === messageId &&
        item.data.role === 'assistant',
      );
      if (latestIdx < 0) return {};
      const items = [...latest.items];
      const current = items[latestIdx];
      if (current.type !== 'message' || current.data.role !== 'assistant') return {};
      items[latestIdx] = { type: 'message', data: updater(current.data) };
      return {
        chatSessions: putScopedMapValue(s as any, s.chatSessions, path, { ...latest, items }),
      };
    });
    return true;
  },

  truncateSessionFromMessage: (path, messageId) => {
    const session = scopedMapValue<SessionMessages>(get() as any, get().chatSessions, path);
    if (!session) return false;

    const targetIdx = session.items.findIndex((item) =>
      item.type === 'message' &&
      (item.data.id === messageId || item.data.sourceEntryId === messageId),
    );
    if (targetIdx < 0) return false;

    set((s) => {
      const latest = scopedMapValue<SessionMessages>(s as any, s.chatSessions, path);
      if (!latest) return {};
      const latestIdx = latest.items.findIndex((item) =>
        item.type === 'message' &&
        (item.data.id === messageId || item.data.sourceEntryId === messageId),
      );
      if (latestIdx < 0) return {};
      const items = latest.items.slice(0, latestIdx);
      invalidateSessionCache(path);
      invalidateStreamBuffer(path);
      invalidateStreamResumeMeta(path);
      return {
        chatSessions: putScopedMapValue(s as any, s.chatSessions, path, {
            ...latest,
            items,
            oldestId: firstMessageId(items),
          }),
      };
    });
    return true;
  },

  // 缓存：block_update 到达时 block 可能还没添加到 store（时序竞争）
  _pendingBlockPatches: {} as Record<string, Record<string, any>>,

  insertInterludeItemNearTaskResult: (sessionPath, taskId, block) => {
    if (!scopedMapValue<SessionMessages>(get() as any, get().chatSessions, sessionPath)) return false;

    let consumed = false;
    set((s) => {
      const session = scopedMapValue<SessionMessages>(s as any, s.chatSessions, sessionPath);
      if (!session) return {};
      const items = [...session.items];

      if (hasEquivalentInterludeItem(items, block)) {
        consumed = true;
        return {};
      }

      let insertAt = items.length;
      let foundAnchor = !taskId;
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.type !== 'message' || item.data.role !== 'assistant') continue;
        const blocks = item.data.blocks;
        if (!blocks) continue;
        if (!taskId) continue;

        const blockIdx = blocks.findIndex((existing) => isInterludeResultAnchorBlock(existing, taskId));
        if (blockIdx < 0) continue;

        foundAnchor = true;
        insertAt = shouldPlaceInterludeBeforeAnchor(blocks[blockIdx])
          ? i
          : insertAfterAssistantRun(items, i);
        break;
      }

      if (!foundAnchor) return {};

      items.splice(insertAt, 0, { type: 'interlude', id: block.id, data: block });
      consumed = true;
      invalidateSessionCache(sessionPath);
      return {
        chatSessions: putScopedMapValue(s as any, s.chatSessions, sessionPath, { ...session, items }),
      };
    });

    return consumed;
  },

  resolveBlockByTaskId: (sessionPath, taskId, resolution) => {
    if (!scopedMapValue<SessionMessages>(get() as any, get().chatSessions, sessionPath)) return false;

    let consumed = false;
    set((s) => {
      const session = scopedMapValue<SessionMessages>(s as any, s.chatSessions, sessionPath);
      if (!session) return {};
      const items = [...session.items];

      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.type !== 'message' || item.data.role !== 'assistant') continue;
        const blocks = item.data.blocks;
        if (!blocks) continue;
        const blockIdx = blocks.findIndex((block) => (
          isPendingMediaGenerationBlock(block, taskId) ||
          isResolvedTaskBlock(block, taskId)
        ));
        if (blockIdx < 0) continue;

        consumed = true;
        if (isResolvedFileTaskBlock(blocks[blockIdx], taskId)) {
          return {};
        }

        const nextBlocks = [...blocks];
        nextBlocks[blockIdx] = resolution;
        items[i] = { ...item, data: { ...item.data, blocks: nextBlocks } };
        invalidateSessionCache(sessionPath);
        return {
          chatSessions: putScopedMapValue(s as any, s.chatSessions, sessionPath, { ...session, items }),
        };
      }

      return {};
    });

    return consumed;
  },

  setSessionRegistryFiles: (path, files) => set((s) => {
    invalidateSessionCache(path);
    const key = sessionScopedKey(s as any, path) || path;
    const sessionRegistryFilesByPath = {
      ...s.sessionRegistryFilesByPath,
      [key]: [...files],
    };
    if (key !== path) delete sessionRegistryFilesByPath[path];
    return {
      sessionRegistryFilesByPath,
    };
  }),

  upsertSessionRegistryFile: (path, file) => set((s) => {
    const key = registryFileKey(file);
    if (!key) return {};
    const sessionKey = sessionScopedKey(s as any, path) || path;
    const files = sessionScopedValue(s as any, s.sessionRegistryFilesByPath, path) || [];
    const idx = files.findIndex(existing => registryFileKey(existing) === key);
    const next = idx >= 0 ? [...files] : [...files, file];
    if (idx >= 0) next[idx] = { ...files[idx], ...file };
    invalidateSessionCache(path);
    const sessionRegistryFilesByPath = {
      ...s.sessionRegistryFilesByPath,
      [sessionKey]: next,
    };
    if (sessionKey !== path) delete sessionRegistryFilesByPath[path];
    return {
      sessionRegistryFilesByPath,
    };
  }),

  patchBlockByTaskId: (sessionPath, taskId, patch) => {
    const session = scopedMapValue<SessionMessages>(get() as any, get().chatSessions, sessionPath);
    if (!session) {
      // session 还没初始化，缓存 patch
      const pending = (get() as any)._pendingBlockPatches;
      pending[taskId] = { ...(pending[taskId] || {}), ...patch };
      return;
    }
    const items = [...session.items];
    let found = false;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type !== 'message' || item.data.role !== 'assistant') continue;
      const blocks = item.data.blocks;
      if (!blocks) continue;
      const blockIdx = blocks.findIndex((b: any) => (b.type === 'subagent' || b.type === 'workflow') && b.taskId === taskId);
      if (blockIdx === -1) continue;
      const newBlocks = [...blocks];
      newBlocks[blockIdx] = { ...newBlocks[blockIdx], ...patch };
      const newItems = [...items];
      newItems[i] = { ...item, data: { ...item.data, blocks: newBlocks } };
      set((s) => ({
        chatSessions: putScopedMapValue(
          s as any,
          s.chatSessions,
          sessionPath,
          { ...(scopedMapValue<SessionMessages>(s as any, s.chatSessions, sessionPath) || session), items: newItems },
        ),
      }));
      found = true;
      break;
    }
    if (!found) {
      // block 还没被添加到 store，缓存 patch 等 content_block 到达后 apply
      const pending = (get() as any)._pendingBlockPatches;
      pending[taskId] = { ...(pending[taskId] || {}), ...patch };
    }
  },

  updateSessionModel: (path, model) => {
    // 纪律：SessionModel 的 provider 必须非空。缺 provider 的 model 会让
    // ModelSelector 的复合键匹配退化，导致多 provider 同 id 场景全亮（见 bug #model-ref）。
    // 此处直接拒绝，让上游调用方暴露问题。
    if (!model?.id || !model?.provider) {
      console.warn('[chat-slice] updateSessionModel 拒绝：model 缺 id 或 provider', path, model);
      return;
    }
    // 只写 sessionModelsByPath，不碰 chatSessions。
    // chatSessions[path] 的存在性仍然是"消息状态已初始化"的单一语义。
    set((s) => ({
      sessionModelsByPath: putScopedMapValue(s as any, s.sessionModelsByPath, path, model),
    }));
  },

  bumpLoadMessagesVersion: (path) => {
    const current = scopedMapValue<number>(get() as any, (get() as any)._loadMessagesVersion || {}, path) ?? 0;
    const next = current + 1;
    set((s) => ({
      _loadMessagesVersion: putScopedMapValue(s as any, s._loadMessagesVersion, path, next),
    }));
    return next;
  },

  setLoadingMore: (path, loading) => set((s) => {
    const session = scopedMapValue<SessionMessages>(s as any, s.chatSessions, path);
    if (!session) return {};
    return {
      chatSessions: putScopedMapValue(s as any, s.chatSessions, path, { ...session, loadingMore: loading }),
    };
  }),

  clearSession: (path) => set((s) => {
    const sessions = deleteScopedMapValue(s as any, s.chatSessions, path);
    const registryFiles = deleteScopedMapValue(s as any, s.sessionRegistryFilesByPath, path);
    const models = deleteScopedMapValue(s as any, s.sessionModelsByPath, path);
    const versions = deleteScopedMapValue(s as any, s._loadMessagesVersion, path);
    const scrollPositions = deleteScopedMapValue(s as any, s.scrollPositions, path);
    const pendingConfirmations = { ...((s as any).pendingSessionConfirmationsByPath || {}) };
    const pendingSessionConfirmationsByPath = deleteScopedMapValue(s as any, pendingConfirmations, path);
    // FileRef 缓存和 streamBuffer 都绑定 session 生命周期，归属方主动清
    invalidateSessionCache(path);
    invalidateStreamBuffer(path);
    invalidateStreamResumeMeta(path);
    clearMessageLiveVersion(path);
    return {
      chatSessions: sessions,
      sessionRegistryFilesByPath: registryFiles,
      sessionModelsByPath: models,
      _loadMessagesVersion: versions,
      scrollPositions,
      pendingSessionConfirmationsByPath,
    } as any;
  }),

  saveScrollPosition: (path, scrollTop) => set((s) => ({
    scrollPositions: putScopedMapValue(s as any, s.scrollPositions, path, scrollTop),
  })),
});

function registryFileKey(file: SessionRegistryFile): string | null {
  const fileId = file.fileId || file.id;
  if (fileId) return `id:${fileId}`;
  const filePath = file.filePath || file.realPath;
  return filePath ? `path:${filePath}` : null;
}

function firstMessageId(items: ChatListItem[]): string | undefined {
  return items.find((item) => item.type === 'message')?.data.id;
}

function isPendingMediaGenerationBlock(block: ContentBlock, taskId: string): boolean {
  return block.type === 'media_generation' &&
    block.taskId === taskId &&
    block.status === 'pending';
}

function isResolvedTaskBlock(block: ContentBlock, taskId: string): boolean {
  if (block.type === 'file') return block.replacesTaskId === taskId;
  return block.type === 'media_generation' &&
    block.taskId === taskId &&
    block.status !== 'pending';
}

function isResolvedFileTaskBlock(block: ContentBlock, taskId: string): boolean {
  return block.type === 'file' && block.replacesTaskId === taskId;
}

function isInterludeBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'interlude' }> {
  return block.type === 'interlude';
}

function hasEquivalentInterludeBlock(blocks: ContentBlock[], block: ContentBlock): boolean {
  if (!isInterludeBlock(block)) return false;
  return blocks.some((existing) => (
    isInterludeBlock(existing) &&
    (
      (block.id && existing.id === block.id) ||
      (!!block.taskId && existing.taskId === block.taskId && existing.status === block.status)
    )
  ));
}

function hasEquivalentInterludeItem(items: ChatListItem[], block: ContentBlock): boolean {
  if (!isInterludeBlock(block)) return false;
  return items.some((item) => {
    if (item.type === 'interlude') {
      return isEquivalentInterlude(item.data, block);
    }
    if (item.type !== 'message' || item.data.role !== 'assistant') return false;
    return hasEquivalentInterludeBlock(item.data.blocks || [], block);
  });
}

function isEquivalentInterlude(existing: Extract<ContentBlock, { type: 'interlude' }>, block: Extract<ContentBlock, { type: 'interlude' }>): boolean {
  return (
    (block.id && existing.id === block.id) ||
    (!!block.taskId && existing.taskId === block.taskId && existing.status === block.status)
  );
}

function isMediaTaskAnchorBlock(block: ContentBlock, taskId: string): boolean {
  return (
    (block.type === 'media_generation' && block.taskId === taskId) ||
    (block.type === 'file' && block.replacesTaskId === taskId)
  );
}

function isInterludeResultAnchorBlock(block: ContentBlock, taskId: string): boolean {
  return (
    isMediaTaskAnchorBlock(block, taskId) ||
    ((block.type === 'subagent' || block.type === 'workflow') && block.taskId === taskId)
  );
}

function shouldPlaceInterludeBeforeAnchor(block: ContentBlock): boolean {
  return block.type === 'media_generation' || block.type === 'file';
}

function insertAfterAssistantRun(items: ChatListItem[], anchorIndex: number): number {
  let insertAt = anchorIndex + 1;
  while (insertAt < items.length) {
    const item = items[insertAt];
    if (item.type !== 'message' || item.data.role !== 'assistant') break;
    insertAt += 1;
  }
  return insertAt;
}
