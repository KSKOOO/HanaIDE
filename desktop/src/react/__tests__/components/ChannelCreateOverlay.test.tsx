// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelCreateOverlay } from '../../components/channels/ChannelCreateOverlay';
import { createChannel } from '../../stores/channel-actions';

const setVisible = vi.fn();

const storeState = {
  agents: [
    { id: 'alice', name: 'Alice', yuan: '', isPrimary: true },
    { id: 'bob', name: 'Bob', yuan: '', isPrimary: false },
  ],
  channelCreateOverlayVisible: true,
  setChannelCreateOverlayVisible: setVisible,
};

vi.mock('../../stores', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../../stores/channel-actions', () => ({
  createChannel: vi.fn(),
}));

vi.mock('../../utils/agent-display', () => ({
  AgentAvatar: () => <span data-testid="avatar" />,
  refreshAgentAvatarVersion: vi.fn(),
  resolveAgentDisplayInfo: ({ id, fallbackAgentName }: { id: string; fallbackAgentName?: string }) => ({
    id,
    name: fallbackAgentName || id,
  }),
}));

vi.mock('../../ui', () => ({
  Overlay: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div>{children}</div> : null,
}));

describe('ChannelCreateOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.agents = [
      { id: 'alice', name: 'Alice', yuan: '', isPrimary: true },
      { id: 'bob', name: 'Bob', yuan: '', isPrimary: false },
    ];
    storeState.channelCreateOverlayVisible = true;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps create disabled until a name and at least two agent members are selected', async () => {
    storeState.agents = [{ id: 'alice', name: 'Alice', yuan: '', isPrimary: true }];

    render(<ChannelCreateOverlay />);
    fireEvent.change(screen.getByPlaceholderText('channel.createNamePlaceholder'), {
      target: { value: 'solo' },
    });

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'channel.createConfirm' }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect(screen.getByText('channel.minMembers')).toBeTruthy();
  });

  it('keeps the overlay open and shows the backend rejection message', async () => {
    vi.mocked(createChannel).mockRejectedValueOnce(new Error('Agent not found: ghost'));

    render(<ChannelCreateOverlay />);
    fireEvent.change(screen.getByPlaceholderText('channel.createNamePlaceholder'), {
      target: { value: 'mixed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'channel.createConfirm' }));

    await waitFor(() => {
      expect(screen.getByText('Agent not found: ghost')).toBeTruthy();
    });
    expect(setVisible).not.toHaveBeenCalledWith(false);
  });
});
