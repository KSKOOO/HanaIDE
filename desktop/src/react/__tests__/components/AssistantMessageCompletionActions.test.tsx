// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../components/chat/AssistantMessage';
import { useStore } from '../../stores';
import type { ChatMessage } from '../../stores/chat-types';

const replayMock = vi.fn(async (_sessionPath: string, _message: unknown) => true);

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'common.copyText': '复制文本',
      'common.screenshot': '截图',
      'common.selectMessage': '选择消息',
      'common.selectAllMessages': '全选消息',
    }[key] || key),
  }),
}));

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

vi.mock('../../stores/message-turn-actions', () => ({
  replayLatestUserMessage: (sessionPath: string, message: unknown) =>
    replayMock(sessionPath, message),
}));

describe('AssistantMessage completion actions', () => {
  const sessionPath = '/session/a.jsonl';
  const userMessage: ChatMessage = {
    id: 'u1',
    sourceEntryId: 'entry-u1',
    role: 'user',
    text: '讲讲月亮',
    textHtml: '<p>讲讲月亮</p>',
  };
  const assistantMessage: ChatMessage = {
    id: 'a1',
    role: 'assistant',
    timestamp: new Date(2026, 4, 7, 5, 43).getTime(),
    blocks: [{ type: 'text', html: '<p>月亮很好。</p>' }],
  };

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, {
      t: (key: string) => ({
        'common.regenerate': '重新生成',
      }[key] || key),
    });
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => undefined) },
    });
    useStore.setState({
      agents: [],
      agentName: 'Hana',
      agentYuan: 'hana',
      selectedIdsBySession: {},
      streamingSessions: [],
      chatSessions: {
        [sessionPath]: {
          hasMore: false,
          loadingMore: false,
          items: [
            { type: 'message', data: userMessage },
            { type: 'message', data: assistantMessage },
          ],
        },
      },
    } as never);
  });

  it('shows completed time and retry for the latest finished assistant reply', async () => {
    render(
      <AssistantMessage
        message={assistantMessage}
        showAvatar={false}
        sessionPath={sessionPath}
        isLatestAssistantMessage
        retrySourceMessage={userMessage}
      />,
    );

    expect(screen.getByText('05:43')).toBeInTheDocument();
    const footer = screen.getByTestId('assistant-completion-actions');
    expect(footer.className).not.toContain('messageFooterActionsVisible');
    expect(footer.className).toContain('messageFooterActionsTimePersistent');
    expect(within(footer).queryByTitle('复制文本')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('重新生成'));

    expect(replayMock).toHaveBeenCalledWith(sessionPath, userMessage);
  });

  it('hides time for older assistant replies that are not the turn ending', () => {
    render(
      <AssistantMessage
        message={assistantMessage}
        showAvatar={false}
        sessionPath={sessionPath}
        isLatestAssistantMessage={false}
        retrySourceMessage={userMessage}
      />,
    );

    expect(screen.queryByText('05:43')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-completion-actions')).not.toBeInTheDocument();
    expect(screen.queryByTitle('重新生成')).not.toBeInTheDocument();
  });

  it('keeps time available for older turn-ending assistant replies without retry controls', () => {
    render(
      <AssistantMessage
        message={assistantMessage}
        showAvatar={false}
        sessionPath={sessionPath}
        isLatestAssistantMessage={false}
        showTurnCompletionTime
        retrySourceMessage={userMessage}
      />,
    );

    expect(screen.getByText('05:43')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-completion-actions').className).not.toContain('messageFooterActionsTimePersistent');
    expect(screen.queryByTitle('重新生成')).not.toBeInTheDocument();
  });

  it('hides retry while the assistant reply is still streaming but keeps the timestamp available', () => {
    useStore.setState({ streamingSessions: [sessionPath] } as never);

    render(
      <AssistantMessage
        message={assistantMessage}
        showAvatar={false}
        sessionPath={sessionPath}
        isLatestAssistantMessage
        retrySourceMessage={userMessage}
      />,
    );

    expect(screen.getByText('05:43')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-completion-actions').className).not.toContain('messageFooterActionsTimePersistent');
    expect(screen.queryByTitle('重新生成')).not.toBeInTheDocument();
  });
});
