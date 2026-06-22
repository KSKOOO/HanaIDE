// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelInput, ChannelMembers, requestChannelComposerFocus } from '../../components/ChannelsPanel';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

function seedChannelState() {
  useStore.setState({
    currentChannel: 'ch_crew',
    channels: [{
      id: 'ch_crew',
      name: 'Crew',
      members: ['alice', 'bob', 'carol'],
      lastMessage: '',
      lastSender: '',
      lastTimestamp: '',
      newMessageCount: 0,
      isDM: false,
    }],
    channelMembers: ['alice', 'bob', 'carol'],
    channelIsDM: false,
    agents: [
      { id: 'alice', name: 'Alice', yuan: '', isPrimary: false },
      { id: 'bob', name: 'Bob', yuan: '', isPrimary: false },
      { id: 'carol', name: 'Carol', yuan: '', isPrimary: false },
    ],
    userName: 'User',
    userAvatarUrl: '',
    currentAgentId: 'alice',
  } as never);
}

describe('ChannelInput focus restoration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.t = ((key: string) => key) as typeof window.t;
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    seedChannelState();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('focuses the channel composer only for the active channel', async () => {
    render(<ChannelInput />);
    const input = screen.getByPlaceholderText('channel.inputPlaceholder') as HTMLTextAreaElement;

    requestChannelComposerFocus('other_channel');
    expect(document.activeElement).not.toBe(input);

    requestChannelComposerFocus('ch_crew');

    await waitFor(() => {
      expect(input).toHaveFocus();
    });
  });

  it('returns focus to the composer after removing a channel member', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, members: ['bob', 'carol'] }),
    } as Response);

    render(
      <>
        <ChannelMembers />
        <ChannelInput />
      </>,
    );

    const input = screen.getByPlaceholderText('channel.inputPlaceholder') as HTMLTextAreaElement;
    const removeButtons = screen.getAllByTitle('channel.removeMember');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/channels/ch_crew/members/alice', { method: 'DELETE' });
      expect(input).toHaveFocus();
    });
  });
});
