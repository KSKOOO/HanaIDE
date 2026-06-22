// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../components/chat/AssistantMessage';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

describe('AssistantMessage media generation placeholder', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    (window as any).platform = {
      getFileUrl: (filePath: string) => `file://${filePath}`,
      startDrag: vi.fn(),
    };
    useStore.setState({
      agents: [],
      agentName: 'Hanako',
      agentYuan: 'hanako',
      mediaViewer: null,
      streamingSessions: [],
      selectedMessageIdsBySession: {},
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders a grey image placeholder with inline status text and cycling dot slot', () => {
    const { container } = render(
      <AssistantMessage
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'a1',
          role: 'assistant',
          blocks: [{
            type: 'media_generation',
            taskId: 'task-img',
            kind: 'image',
            status: 'pending',
            prompt: 'Low-poly 3D illustration of a Chinese college student character sitting at the front row of a classroom',
          }],
        }}
      />,
    );

    expect(screen.getByLabelText('chat.media.generationInProgress...')).toBeInTheDocument();
    expect(container.querySelector('[class*="mediaGenerationDots"]')).toBeInTheDocument();
    expect(screen.getByText(/^Low-poly 3D illustration/)).toBeInTheDocument();
  });

  it('retries a failed image placeholder in place without sending a new agent turn', async () => {
    const resolveBlockByTaskId = vi.fn(() => true);
    useStore.setState({
      resolveBlockByTaskId,
    } as never);
    vi.mocked(hanaFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      placeholder: {
        type: 'media_generation',
        taskId: 'task-img',
        kind: 'image',
        status: 'pending',
        prompt: 'same prompt',
      },
    }), { status: 200 }));

    render(
      <AssistantMessage
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        message={{
          id: 'a1',
          role: 'assistant',
          blocks: [{
            type: 'media_generation',
            taskId: 'task-img',
            kind: 'image',
            status: 'failed',
            reason: 'API returned no images',
            prompt: 'same prompt',
          }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'chat.media.retryLabel' }));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/media/tasks/task-img/retry', {
        method: 'POST',
      });
    });
    expect(resolveBlockByTaskId).toHaveBeenCalledWith('/sessions/main.jsonl', 'task-img', expect.objectContaining({
      type: 'media_generation',
      taskId: 'task-img',
      kind: 'image',
      status: 'pending',
      prompt: 'same prompt',
    }));
  });

  it('renders generated video files as media cards that open the media viewer and drag out the file', async () => {
    const startDrag = vi.fn();
    (window as any).platform = {
      getFileUrl: (filePath: string) => `file://${filePath}`,
      startDrag,
    };

    render(
      <AssistantMessage
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        message={{
          id: 'a1',
          role: 'assistant',
          blocks: [{
            type: 'file',
            fileId: 'sf_video',
            filePath: '/tmp/generated/agnes.mp4',
            label: 'agnes.mp4',
            ext: 'mp4',
            mime: 'video/mp4',
            kind: 'video',
          }],
        }}
      />,
    );

    const card = await screen.findByTestId('video-output-card');
    expect(card.querySelector('video')).toBeInTheDocument();

    fireEvent.click(card);
    await waitFor(() => {
      expect(useStore.getState().mediaViewer?.currentId).toContain('/tmp/generated/agnes.mp4');
    });

    fireEvent.dragStart(card);
    expect(startDrag).toHaveBeenCalledWith('/tmp/generated/agnes.mp4');
  });

  it('isolates a malformed rich block without hiding sibling message blocks', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(
      <AssistantMessage
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'a1',
          role: 'assistant',
          blocks: [
            { type: 'text', html: '<p>before bad block</p>' },
            { type: 'plugin_card' } as never,
            { type: 'text', html: '<p>after bad block</p>' },
          ],
        }}
      />,
    )).not.toThrow();

    expect(screen.getByText('before bad block')).toBeInTheDocument();
    expect(screen.getByText('after bad block')).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });
});
