// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  appendChannelMessageMock,
  markChannelMessagesDirtyMock,
  loadChannelsMock,
  openChannelMock,
  upsertConversationAgentActivityMock,
} = vi.hoisted(() => ({
  appendChannelMessageMock: vi.fn(),
  markChannelMessagesDirtyMock: vi.fn(),
  loadChannelsMock: vi.fn(),
  openChannelMock: vi.fn(),
  upsertConversationAgentActivityMock: vi.fn(),
}));

vi.mock('../../hooks/use-stream-buffer', () => ({
  streamBufferManager: {
    handle: vi.fn(),
  },
}));

vi.mock('../../services/stream-key-dispatcher', () => ({
  dispatchStreamKey: vi.fn(),
}));

vi.mock('../../stores/session-actions', () => ({
  loadSessions: vi.fn(),
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
}));

vi.mock('../../stores/channel-actions', () => ({
  appendChannelMessage: appendChannelMessageMock,
  markChannelMessagesDirty: markChannelMessagesDirtyMock,
  loadChannels: loadChannelsMock,
  openChannel: openChannelMock,
  upsertConversationAgentActivity: upsertConversationAgentActivityMock,
}));

vi.mock('../../stores/preview-actions', () => ({
  handleLegacyArtifactBlock: vi.fn(),
}));

vi.mock('../../services/app-event-actions', () => ({
  handleAppEvent: vi.fn(),
}));

vi.mock('../../services/stream-resume', () => ({
  replayStreamResume: vi.fn(),
  isStreamResumeRebuilding: () => null,
  isStreamScopedMessage: () => false,
  updateSessionStreamMeta: vi.fn(),
}));

import { useStore } from '../../stores';
import { handleServerMessage } from '../../services/ws-message-handler';

describe('channel_new_message websocket routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentTab: 'channels',
      currentChannel: 'ch_crew',
      channels: [{ id: 'ch_crew', name: 'Crew' }],
      channelMessages: [
        { sender: 'user', timestamp: '2026-05-07 17:00:00', body: 'old' },
      ],
    } as never);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  it('appends a complete message event for the visible channel without reopening it', () => {
    const message = {
      sender: 'hanako',
      timestamp: '2026-05-07 17:01:00',
      body: 'new reply',
    };

    handleServerMessage({
      type: 'channel_new_message',
      channelName: 'ch_crew',
      sender: 'hanako',
      message,
    });

    expect(appendChannelMessageMock).toHaveBeenCalledWith('ch_crew', message, { markRead: true });
    expect(openChannelMock).not.toHaveBeenCalled();
    expect(loadChannelsMock).not.toHaveBeenCalled();
  });

  it('updates the current channel cache while chat tab is active without marking read', () => {
    useStore.setState({
      currentTab: 'chat',
      currentChannel: 'ch_crew',
      channelMessages: [
        { sender: 'user', timestamp: '2026-05-07 17:00:00', body: 'old' },
      ],
    } as never);
    const message = {
      sender: 'hanako',
      timestamp: '2026-05-07 17:01:00',
      body: 'new reply',
    };

    handleServerMessage({
      type: 'channel_new_message',
      channelName: 'ch_crew',
      sender: 'hanako',
      message,
    });

    expect(appendChannelMessageMock).toHaveBeenCalledWith('ch_crew', message, { markRead: false });
    expect(openChannelMock).not.toHaveBeenCalled();
    expect(loadChannelsMock).not.toHaveBeenCalled();
  });

  it('does not mark a visible current channel read while the document is hidden', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    const message = {
      sender: 'hanako',
      timestamp: '2026-05-07 17:01:00',
      body: 'new reply',
    };

    handleServerMessage({
      type: 'channel_new_message',
      channelName: 'ch_crew',
      sender: 'hanako',
      message,
    });

    expect(appendChannelMessageMock).toHaveBeenCalledWith('ch_crew', message, { markRead: false });
    expect(openChannelMock).not.toHaveBeenCalled();
  });

  it('reloads the channel list when a message arrives for an unknown channel', () => {
    useStore.setState({
      currentTab: 'chat',
      currentChannel: 'ch_crew',
      channels: [{ id: 'ch_crew', name: 'Crew' }],
    } as never);
    const message = {
      sender: 'hanako',
      timestamp: '2026-05-07 17:02:00',
      body: 'new channel message',
    };

    handleServerMessage({
      type: 'channel_new_message',
      channelName: 'ch_new',
      sender: 'hanako',
      message,
    });

    expect(loadChannelsMock).toHaveBeenCalledOnce();
    expect(appendChannelMessageMock).toHaveBeenCalledWith('ch_new', message, { markRead: false });
  });

  it('reloads the channel list when the host reports a created channel', () => {
    handleServerMessage({
      type: 'channel_created',
      channelName: 'ch_new',
    });

    expect(loadChannelsMock).toHaveBeenCalledOnce();
  });

  it('marks message-less channel events dirty for the keyed channel cache', () => {
    useStore.setState({
      currentTab: 'chat',
      currentChannel: 'ch_crew',
    } as never);

    handleServerMessage({
      type: 'channel_new_message',
      channelName: 'ch_crew',
      sender: 'hanako',
    });

    expect(markChannelMessagesDirtyMock).toHaveBeenCalledWith('ch_crew');
    expect(loadChannelsMock).toHaveBeenCalledOnce();
    expect(openChannelMock).not.toHaveBeenCalled();
  });
});

describe('dm_new_message websocket routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentTab: 'channels',
      currentAgentId: 'alice',
      currentChannel: 'dm:bob',
      channelMessages: [],
    } as never);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  it('routes a DM event to the peer of the current agent when the current agent is the sender', () => {
    handleServerMessage({
      type: 'dm_new_message',
      from: 'alice',
      to: 'bob',
    });

    expect(openChannelMock).toHaveBeenCalledWith('dm:bob', true);
    expect(loadChannelsMock).not.toHaveBeenCalled();
  });

  it('routes a primary-owned visible DM even when chat focus is another agent', () => {
    useStore.setState({
      currentTab: 'channels',
      currentAgentId: 'dana',
      agents: [
        { id: 'alice', name: 'Alice', yuan: 'hanako', isPrimary: true },
        { id: 'bob', name: 'Bob', yuan: 'ming', isPrimary: false },
        { id: 'dana', name: 'Dana', yuan: 'ming', isPrimary: false },
      ],
      channels: [{
        id: 'dm:bob',
        name: 'Bob',
        members: ['bob'],
        lastMessage: '',
        lastSender: '',
        lastTimestamp: '',
        newMessageCount: 0,
        isDM: true,
        peerId: 'bob',
        peerName: 'Bob',
        dmOwnerId: 'alice',
      }],
      currentChannel: 'dm:bob',
    } as never);

    handleServerMessage({
      type: 'dm_new_message',
      from: 'alice',
      to: 'bob',
    });

    expect(openChannelMock).toHaveBeenCalledWith('dm:bob', true);
    expect(loadChannelsMock).not.toHaveBeenCalled();
  });
});

describe('conversation_agent_activity websocket routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores agent phone activity updates from the backend', () => {
    const activity = {
      conversationId: 'ch_crew',
      conversationType: 'channel',
      agentId: 'hana',
      state: 'replying',
      summary: '正在组织回复',
      timestamp: '2026-05-12T12:00:00.000Z',
    };

    handleServerMessage({
      type: 'conversation_agent_activity',
      activity,
    });

    expect(upsertConversationAgentActivityMock).toHaveBeenCalledWith(activity);
  });
});
