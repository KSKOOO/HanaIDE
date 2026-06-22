import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChatSlice, type ChatSlice } from '../../stores/chat-slice';
import type { ChatListItem, SessionModel } from '../../stores/chat-types';
import { registerStreamBufferInvalidator, registerStreamResumeMetaInvalidator } from '../../stores/stream-invalidator';

function makeSlice(initial: Record<string, unknown> = {}): ChatSlice {
  let state: ChatSlice & Record<string, unknown>;
  const set = (partial: Partial<ChatSlice> | ((s: ChatSlice) => Partial<ChatSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state;
  state = { ...createChatSlice(set as never, get), ...initial };
  return new Proxy({} as ChatSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

const MODEL: SessionModel = {
  id: 'claude-opus-4-6',
  name: 'Claude Opus 4.6',
  provider: 'anthropic',
  input: ['text', 'image'],
  reasoning: true,
  contextWindow: 1_000_000,
};

function interludeItem(id: string): ChatListItem {
  return {
    type: 'interlude',
    id,
    data: {
      type: 'interlude',
      id,
      variant: 'deferred_result',
      status: 'success',
      text: '后台回复已抵达',
    },
  };
}

describe('chat-slice', () => {
  let slice: ChatSlice;

  beforeEach(() => {
    slice = makeSlice();
  });

  it('初始状态：chatSessions / sessionModelsByPath / _loadMessagesVersion 均为空', () => {
    expect(slice.chatSessions).toEqual({});
    expect(slice.sessionModelsByPath).toEqual({});
    expect(slice._loadMessagesVersion).toEqual({});
  });

  it('有 sessionId locator 时，消息、模型、registry 和清理都使用 sessionId key', () => {
    slice = makeSlice({
      currentSessionId: 'sess_chat',
      currentSessionPath: '/sessions/moved.jsonl',
      sessions: [{ sessionId: 'sess_chat', path: '/sessions/moved.jsonl' }],
      sessionLocatorsById: { sess_chat: { path: '/sessions/moved.jsonl' } },
    });

    slice.initSession('/sessions/moved.jsonl', [], false);
    slice.updateSessionModel('/sessions/moved.jsonl', MODEL);
    slice.setSessionRegistryFiles('/sessions/moved.jsonl', [{
      fileId: 'sf_1',
      filePath: '/tmp/out.md',
      label: 'out.md',
      mime: 'text/markdown',
      status: 'available',
    }]);

    expect(slice.chatSessions.sess_chat).toBeDefined();
    expect(slice.chatSessions['/sessions/moved.jsonl']).toBeUndefined();
    expect(slice.sessionModelsByPath.sess_chat).toEqual(MODEL);
    expect(slice.sessionRegistryFilesByPath.sess_chat).toHaveLength(1);

    slice.clearSession('/sessions/moved.jsonl');
    expect(slice.chatSessions.sess_chat).toBeUndefined();
    expect(slice.sessionModelsByPath.sess_chat).toBeUndefined();
    expect(slice.sessionRegistryFilesByPath.sess_chat).toBeUndefined();
  });

  describe('updateSessionModel', () => {
    it('uncached session 不在 chatSessions 里创建 stub（#405 核心回归）', () => {
      slice.updateSessionModel('/a', MODEL);
      expect(slice.chatSessions).toEqual({});
      expect(slice.sessionModelsByPath).toEqual({ '/a': MODEL });
    });

    it('顺序无关：先 updateSessionModel 再 initSession，最终状态 chatSessions 存在 且 model 保留', () => {
      slice.updateSessionModel('/a', MODEL);
      slice.initSession('/a', [], false);
      expect(slice.chatSessions['/a']).toBeDefined();
      expect(slice.chatSessions['/a']?.items).toEqual([]);
      expect(slice.sessionModelsByPath['/a']).toEqual(MODEL);
    });

    it('顺序无关：先 initSession 再 updateSessionModel，二者各自独立', () => {
      slice.initSession('/a', [], false);
      slice.updateSessionModel('/a', MODEL);
      expect(slice.chatSessions['/a']).toBeDefined();
      expect(slice.sessionModelsByPath['/a']).toEqual(MODEL);
    });

    it('多次 updateSessionModel 覆盖之前的值', () => {
      slice.updateSessionModel('/a', MODEL);
      const newer: SessionModel = { ...MODEL, id: 'claude-sonnet-4-6' };
      slice.updateSessionModel('/a', newer);
      expect(slice.sessionModelsByPath['/a']).toEqual(newer);
    });
  });

  describe('initSession', () => {
    it('不复用 chatSessions 中已有的 model 字段（model 已独立）', () => {
      // 即使下面这行在旧代码里会从 chatSessions[path].model 复用，
      // 新代码根本不会去碰 sessionModelsByPath
      slice.initSession('/a', [], false);
      expect(slice.chatSessions['/a']).toEqual({
        items: [],
        hasMore: false,
        loadingMore: false,
        oldestId: undefined,
        revision: null,
      });
    });

    it('记录 hydrate 时的磁盘修订点，缺省为 null', () => {
      slice.initSession('/a', [], false, '4096:1765500000000');
      expect(slice.chatSessions['/a']?.revision).toBe('4096:1765500000000');

      slice.initSession('/b', [], false);
      expect(slice.chatSessions['/b']?.revision).toBeNull();
    });

    it('oldestId 取第一条 message，不被前置幕间条目占位', () => {
      slice.initSession('/a', [
        interludeItem('deferred:task-1:success'),
        { type: 'message', data: { id: 'a1', role: 'assistant', blocks: [] } },
      ], true);

      expect(slice.chatSessions['/a']?.oldestId).toBe('a1');
    });

    it('LRU 淘汰只影响 chatSessions，不动 sessionModelsByPath', () => {
      // 填满 8 个，且每个都写一份模型
      for (let i = 0; i < 9; i++) {
        const p = `/s${i}`;
        slice.updateSessionModel(p, MODEL);
        slice.initSession(p, [], false);
      }
      // chatSessions 最多 8 条
      expect(Object.keys(slice.chatSessions).length).toBeLessThanOrEqual(8);
      // 模型快照全量保留
      expect(Object.keys(slice.sessionModelsByPath).length).toBe(9);
    });
  });

  describe('bumpLoadMessagesVersion', () => {
    it('第一次返回 1，后续递增', () => {
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(1);
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(2);
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(3);
    });

    it('不同 path 的版本独立', () => {
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(1);
      expect(slice.bumpLoadMessagesVersion('/b')).toBe(1);
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(2);
      expect(slice._loadMessagesVersion).toEqual({ '/a': 2, '/b': 1 });
    });
  });

  describe('clearSession', () => {
    it('同时清掉 chatSessions / sessionModelsByPath / _loadMessagesVersion', () => {
      slice.updateSessionModel('/a', MODEL);
      slice.initSession('/a', [], false);
      slice.bumpLoadMessagesVersion('/a');
      slice.saveScrollPosition('/a', 128);
      slice.clearSession('/a');
      expect(slice.chatSessions['/a']).toBeUndefined();
      expect(slice.sessionModelsByPath['/a']).toBeUndefined();
      expect(slice._loadMessagesVersion['/a']).toBeUndefined();
      expect(slice.scrollPositions['/a']).toBeUndefined();
    });

    it('只清目标 path，别的不动', () => {
      slice.updateSessionModel('/a', MODEL);
      slice.updateSessionModel('/b', MODEL);
      slice.clearSession('/a');
      expect(slice.sessionModelsByPath['/a']).toBeUndefined();
      expect(slice.sessionModelsByPath['/b']).toEqual(MODEL);
    });

    it('通知 streamBufferManager invalidate 对应 session（归属方主动清）', () => {
      const invalidator = vi.fn();
      registerStreamBufferInvalidator(invalidator);
      slice.initSession('/a', [], false);
      slice.clearSession('/a');
      expect(invalidator).toHaveBeenCalledWith('/a');
    });

    it('通知 stream resume meta invalidate 对应 session（避免丢渲染缓存后从旧 seq 续传）', () => {
      const invalidator = vi.fn();
      registerStreamResumeMetaInvalidator(invalidator);
      slice.initSession('/a', [], false);
      slice.clearSession('/a');
      expect(invalidator).toHaveBeenCalledWith('/a');
    });

    it('LRU eviction 时也 invalidate 被淘汰 session 的 streamBuffer', () => {
      const invalidator = vi.fn();
      registerStreamBufferInvalidator(invalidator);
      for (let i = 0; i < 8; i++) {
        slice.saveScrollPosition(`/s${i}`, i);
      }
      for (let i = 0; i < 9; i++) {
        slice.initSession(`/s${i}`, [], false);
      }
      // 第 9 次 initSession 会淘汰最老的 /s0（keys.find(k => k !== path)）
      expect(invalidator).toHaveBeenCalledWith('/s0');
      expect(slice.scrollPositions['/s0']).toBeUndefined();
    });

    it('LRU eviction 时也 invalidate 被淘汰 session 的 stream resume meta', () => {
      const invalidator = vi.fn();
      registerStreamResumeMetaInvalidator(invalidator);
      for (let i = 0; i < 9; i++) {
        slice.initSession(`/s${i}`, [], false);
      }
      expect(invalidator).toHaveBeenCalledWith('/s0');
    });
  });

  describe('insertInterludeItemNearTaskResult', () => {
    it('workflow 幕间插到同一轮连续 assistant 片段之后', () => {
      slice.initSession('/a', [
        { type: 'message', data: { id: 'u1', role: 'user', text: 'run workflow' } },
        {
          type: 'message',
          data: {
            id: 'a-card',
            role: 'assistant',
            blocks: [{
              type: 'workflow',
              taskId: 'workflow-1',
              taskTitle: '冒烟测试',
              streamStatus: 'running',
            }],
          },
        },
        {
          type: 'message',
          data: {
            id: 'a-text',
            role: 'assistant',
            blocks: [{ type: 'text', html: '<p>Workflow 已经提交后台运行了。</p>' }],
          },
        },
      ], false);

      const inserted = slice.insertInterludeItemNearTaskResult('/a', 'workflow-1', {
        type: 'interlude',
        id: 'deferred:workflow-1:success',
        variant: 'deferred_result',
        taskId: 'workflow-1',
        status: 'success',
        sourceKind: 'workflow',
        text: 'Hanako 收到了来自 冒烟测试 workflow 的结果',
      });

      expect(inserted).toBe(true);
      expect(slice.chatSessions['/a']?.items.map((item) => (
        item.type === 'message' ? item.data.id : item.id
      ))).toEqual(['u1', 'a-card', 'a-text', 'deferred:workflow-1:success']);
    });

    it('媒体结果幕间仍然插到结果文件前', () => {
      slice.initSession('/a', [
        { type: 'message', data: { id: 'u1', role: 'user', text: 'draw' } },
        {
          type: 'message',
          data: {
            id: 'a-media',
            role: 'assistant',
            blocks: [{
              type: 'file',
              replacesTaskId: 'task-img',
              filePath: '/tmp/image.png',
              label: 'image.png',
              ext: 'png',
            }],
          },
        },
      ], false);

      const inserted = slice.insertInterludeItemNearTaskResult('/a', 'task-img', {
        type: 'interlude',
        id: 'deferred:task-img:success',
        variant: 'deferred_result',
        taskId: 'task-img',
        status: 'success',
        sourceKind: 'tool',
        text: '图片结果已抵达',
      });

      expect(inserted).toBe(true);
      expect(slice.chatSessions['/a']?.items.map((item) => (
        item.type === 'message' ? item.data.id : item.id
      ))).toEqual(['u1', 'deferred:task-img:success', 'a-media']);
    });
  });

  describe('truncateSessionFromMessage', () => {
    it('只截断目标 session 从指定消息开始的尾部，其它 session 不动', () => {
      slice.initSession('/a', [
        { type: 'message', data: { id: 'u1', role: 'user', text: 'old' } },
        { type: 'message', data: { id: 'a1', role: 'assistant', blocks: [] } },
        { type: 'message', data: { id: 'u2', role: 'user', text: 'retry' } },
        { type: 'message', data: { id: 'a2', role: 'assistant', blocks: [] } },
      ], false);
      slice.initSession('/b', [
        { type: 'message', data: { id: 'b1', role: 'user', text: 'keep' } },
      ], false);

      expect(slice.truncateSessionFromMessage('/a', 'u2')).toBe(true);

      expect(slice.chatSessions['/a']?.items.map(item => item.type === 'message' ? item.data.id : item.id)).toEqual(['u1', 'a1']);
      expect(slice.chatSessions['/b']?.items.map(item => item.type === 'message' ? item.data.id : item.id)).toEqual(['b1']);
    });

    it('找不到消息时保持原状态并返回 false', () => {
      slice.initSession('/a', [
        { type: 'message', data: { id: 'u1', role: 'user', text: 'old' } },
      ], false);

      expect(slice.truncateSessionFromMessage('/a', 'missing')).toBe(false);
      expect(slice.chatSessions['/a']?.items).toHaveLength(1);
    });
  });

  describe('resolveBlockByTaskId', () => {
    it('按 sessionPath + taskId 替换任意 assistant 消息里的媒体生成占位', () => {
      slice.initSession('/a', [
        { type: 'message', data: { id: 'u1', role: 'user', text: 'draw' } },
        {
          type: 'message',
          data: {
            id: 'a1',
            role: 'assistant',
            blocks: [{
              type: 'media_generation',
              taskId: 'task-img',
              kind: 'image',
              status: 'pending',
              prompt: 'a moonlit room',
            }],
          },
        },
        { type: 'message', data: { id: 'u2', role: 'user', text: 'next' } },
      ], false);

      expect(slice.resolveBlockByTaskId('/a', 'task-img', {
        type: 'file',
        replacesTaskId: 'task-img',
        fileId: 'sf_img',
        filePath: '/tmp/generated.png',
        label: 'generated.png',
        ext: 'png',
        mime: 'image/png',
        kind: 'image',
      })).toBe(true);

      const message = slice.chatSessions['/a']?.items[1];
      expect(message?.type).toBe('message');
      if (message?.type !== 'message') throw new Error('expected message item');
      expect(message.data.blocks).toEqual([
        expect.objectContaining({
          type: 'file',
          fileId: 'sf_img',
          filePath: '/tmp/generated.png',
        }),
      ]);
      expect(slice.chatSessions['/a']?.items).toHaveLength(3);
    });

    it('重复收到同一个 taskId 的完成块时视为已消费，不追加重复文件', () => {
      slice.initSession('/a', [{
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          blocks: [{
            type: 'file',
            replacesTaskId: 'task-img',
            fileId: 'sf_img',
            filePath: '/tmp/generated.png',
            label: 'generated.png',
            ext: 'png',
          }],
        },
      }], false);

      expect(slice.resolveBlockByTaskId('/a', 'task-img', {
        type: 'file',
        replacesTaskId: 'task-img',
        fileId: 'sf_img_2',
        filePath: '/tmp/generated-2.png',
        label: 'generated-2.png',
        ext: 'png',
      })).toBe(true);

      const message = slice.chatSessions['/a']?.items[0];
      expect(message?.type).toBe('message');
      if (message?.type !== 'message') throw new Error('expected message item');
      expect(message.data.blocks).toEqual([
        expect.objectContaining({
          type: 'file',
          fileId: 'sf_img',
          filePath: '/tmp/generated.png',
        }),
      ]);
    });

    it('允许重试后的完成块替换失败的媒体生成块', () => {
      slice.initSession('/a', [{
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          blocks: [{
            type: 'media_generation',
            taskId: 'task-img',
            kind: 'image',
            status: 'failed',
            reason: 'API returned no images',
            prompt: 'a moonlit room',
          }],
        },
      }], false);

      expect(slice.resolveBlockByTaskId('/a', 'task-img', {
        type: 'file',
        replacesTaskId: 'task-img',
        fileId: 'sf_retry',
        filePath: '/tmp/retry.png',
        label: 'retry.png',
        ext: 'png',
      })).toBe(true);

      const message = slice.chatSessions['/a']?.items[0];
      expect(message?.type).toBe('message');
      if (message?.type !== 'message') throw new Error('expected message item');
      expect(message.data.blocks).toEqual([
        expect.objectContaining({
          type: 'file',
          fileId: 'sf_retry',
          filePath: '/tmp/retry.png',
        }),
      ]);
    });

    it('不在错误 session 或非 assistant 消息里替换', () => {
      slice.initSession('/a', [{
        type: 'message',
        data: {
          id: 'u1',
          role: 'user',
          blocks: [{
            type: 'media_generation',
            taskId: 'task-img',
            kind: 'image',
            status: 'pending',
          }],
        } as never,
      }], false);
      slice.initSession('/b', [], false);

      expect(slice.resolveBlockByTaskId('/b', 'task-img', {
        type: 'file',
        replacesTaskId: 'task-img',
        fileId: 'sf_img',
        filePath: '/tmp/generated.png',
        label: 'generated.png',
        ext: 'png',
      })).toBe(false);
      expect(slice.resolveBlockByTaskId('/a', 'task-img', {
        type: 'file',
        replacesTaskId: 'task-img',
        fileId: 'sf_img',
        filePath: '/tmp/generated.png',
        label: 'generated.png',
        ext: 'png',
      })).toBe(false);
    });
  });
});
