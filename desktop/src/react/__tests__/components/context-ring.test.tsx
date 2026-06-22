// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import { fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextRing } from '../../components/input/ContextRing';
import { useStore } from '../../stores';
import { refreshSessionCapabilities } from '../../stores/session-actions';

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: vi.fn(() => ({ readyState: 1, send: sendMock })),
}));

vi.mock('../../stores/session-actions', () => ({
  refreshSessionCapabilities: vi.fn(() => Promise.resolve(true)),
}));

describe('ContextRing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      agentYuan: 'hanako',
      currentSessionPath: '/session/a.jsonl',
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      contextBySession: {},
      compactingSessions: ['/session/a.jsonl'],
    } as never);
  });

  afterEach(() => {
    cleanup();
    useStore.setState({
      currentSessionPath: null,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      contextBySession: {},
      compactingSessions: [],
    } as never);
  });

  it('stays visible while the current session is compacting before usage arrives', async () => {
    const { container } = render(<ContextRing />);

    await waitFor(() => {
      const button = container.querySelector('button');
      expect(button).toBeTruthy();
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('is visible for an active session but hides the token label below 100k', async () => {
    useStore.setState({
      contextBySession: {
        '/session/a.jsonl': { tokens: 12_345, window: 200_000, percent: 6 },
      },
      compactingSessions: [],
    } as never);

    const { container, queryByText } = render(<ContextRing />);

    await waitFor(() => {
      expect(container.querySelector('button')).toBeTruthy();
    });
    expect(queryByText('12k')).toBeNull();
  });

  it('shows the token label from 100k', async () => {
    useStore.setState({
      contextBySession: {
        '/session/a.jsonl': { tokens: 100_000, window: 200_000, percent: 50 },
      },
      compactingSessions: [],
    } as never);

    const { getByText } = render(<ContextRing />);

    await waitFor(() => {
      expect(getByText('100k')).toBeTruthy();
    });
  });

  it('opens a two-action menu instead of compacting immediately', async () => {
    useStore.setState({
      compactingSessions: [],
    } as never);

    const { container } = render(<ContextRing />);
    const button = container.querySelector('button') as HTMLButtonElement;
    fireEvent.click(button);

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('input.refreshAndCompact')).toBeInTheDocument();
    expect(screen.getByText('input.compact')).toBeInTheDocument();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('runs fresh compact from the update action', async () => {
    useStore.setState({
      compactingSessions: [],
    } as never);

    const { container } = render(<ContextRing />);
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    fireEvent.click(screen.getByText('input.refreshAndCompact'));

    expect(refreshSessionCapabilities).toHaveBeenCalledWith('/session/a.jsonl');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('shows a tooltip for the update action', async () => {
    useStore.setState({
      compactingSessions: [],
    } as never);

    const { container } = render(<ContextRing />);
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    fireEvent.mouseEnter(screen.getByText('input.refreshAndCompact'));

    await waitFor(() => {
      expect(screen.getByText('input.refreshAndCompactTooltip')).toBeInTheDocument();
    });
  });

  it('runs ordinary compact from the compact action', async () => {
    useStore.setState({
      compactingSessions: [],
    } as never);

    const { container } = render(<ContextRing />);
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    fireEvent.click(screen.getByText('input.compact'));

    expect(sendMock).toHaveBeenCalledWith(JSON.stringify({ type: 'compact', sessionPath: '/session/a.jsonl' }));
    expect(refreshSessionCapabilities).not.toHaveBeenCalled();
  });
});
