// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserMessage } from '../../components/chat/UserMessage';
import { useStore } from '../../stores';

const replayMock = vi.fn(async (_sessionPath: string, _message: unknown, _replacementText?: string) => true);

vi.mock('../../stores/message-turn-actions', () => ({
  replayLatestUserMessage: (sessionPath: string, message: unknown, replacementText?: string) =>
    replayMock(sessionPath, message, replacementText),
}));

describe('UserMessage Codex-style actions', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, {
      t: (key: string) => ({
        'common.me': '我',
        'common.copyText': '复制文本',
        'common.selectMessage': '选择消息',
        'common.regenerate': '重新生成',
        'common.edit': '编辑',
        'common.cancel': '取消',
        'common.confirm': '确认',
      }[key] || key),
    });
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => undefined) },
    });
    useStore.setState({
      userAvatarUrl: null,
      userName: '小黎',
      selectedIdsBySession: {},
      streamingSessions: [],
      chatSessions: {
        '/session/a.jsonl': {
          hasMore: false,
          loadingMore: false,
          items: [
            { type: 'message', data: { id: 'u1', role: 'user', text: '旧消息', textHtml: '<p>旧消息</p>' } },
          ],
        },
      },
    } as never);
  });

  it('shows regenerate and edit controls only for the latest user message', () => {
    const message = { id: 'u1', role: 'user' as const, text: '旧消息', textHtml: '<p>旧消息</p>', timestamp: new Date(2026, 4, 7, 5, 42).getTime() };

    render(
      <UserMessage
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage
      />,
    );

    expect(screen.getAllByTitle('复制文本')).toHaveLength(1);
    expect(screen.getByTitle('选择消息')).toBeInTheDocument();
    expect(screen.getByTitle('重新生成')).toBeInTheDocument();
    expect(screen.getByTitle('编辑')).toBeInTheDocument();
    expect(screen.getByText('05:42')).toBeInTheDocument();
  });

  it('renders the message selection action in the user footer and toggles selection', () => {
    const message = { id: 'u1', role: 'user' as const, text: '旧消息', textHtml: '<p>旧消息</p>', timestamp: new Date(2026, 4, 7, 5, 42).getTime() };

    render(
      <UserMessage
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage={false}
      />,
    );

    const select = screen.getByTitle('选择消息');

    fireEvent.click(select);

    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toEqual(['u1']);
    expect(select).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(select);

    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toBeUndefined();
  });

  it('keeps the timestamp available for older user messages without latest-turn controls', () => {
    const message = { id: 'u1', role: 'user' as const, text: '旧消息', textHtml: '<p>旧消息</p>', timestamp: new Date(2026, 4, 7, 5, 42).getTime() };

    render(
      <UserMessage
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage={false}
      />,
    );

    expect(screen.getByText('05:42')).toBeInTheDocument();
    expect(screen.getByTitle('复制文本')).toBeInTheDocument();
    expect(screen.getByTitle('选择消息')).toBeInTheDocument();
    expect(screen.queryByTitle('重新生成')).not.toBeInTheDocument();
    expect(screen.queryByTitle('编辑')).not.toBeInTheDocument();
  });

  it('submits inline edits through the latest-turn replay action', async () => {
    const message = { id: 'u1', sourceEntryId: 'entry-u1', role: 'user' as const, text: '旧消息', textHtml: '<p>旧消息</p>' };

    render(
      <UserMessage
        message={message}
        showAvatar={false}
        sessionPath="/session/a.jsonl"
        isLatestUserMessage
      />,
    );

    fireEvent.click(screen.getByTitle('编辑'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '新消息' } });
    fireEvent.click(screen.getByTitle('确认'));

    expect(replayMock).toHaveBeenCalledWith('/session/a.jsonl', message, '新消息');
  });
});
