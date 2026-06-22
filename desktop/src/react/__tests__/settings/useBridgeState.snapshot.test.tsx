/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBridgeState } from '../../settings/tabs/bridge/useBridgeState';

type MockState = Record<string, any>;

const mockState: MockState = {};
const mockHanaFetch = vi.fn();
const mockUpdateSettingsSnapshot = vi.fn((mutator: (snapshot: MockState) => MockState) => {
  const snapshot = mockState.settingsSnapshot?.data;
  if (!snapshot) return;
  mockState.settingsSnapshot.data = mutator(snapshot);
});

vi.mock('../../settings/store', () => {
  const hook: any = (selector?: (s: MockState) => unknown) =>
    selector ? selector(mockState) : mockState;
  hook.getState = () => mockState;
  hook.setState = (partial: Partial<MockState>) => Object.assign(mockState, partial);
  return { useSettingsStore: hook };
});

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mockHanaFetch(...args),
}));

vi.mock('../../settings/actions', () => ({
  loadSettingsConfig: vi.fn(async () => {}),
  updateSettingsSnapshot: (mutator: (snapshot: MockState) => MockState) => mockUpdateSettingsSnapshot(mutator),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

function BridgeProbe() {
  const { status, tgToken, publicIshiki } = useBridgeState();
  return (
    <div>
      <span data-testid="telegram-enabled">{String(status?.telegram?.enabled)}</span>
      <span data-testid="permission-mode">{status?.permissionMode || 'none'}</span>
      <span data-testid="rich-streaming">{String(status?.richStreamingEnabled)}</span>
      <span data-testid="telegram-token">{tgToken}</span>
      <span data-testid="public-ishiki">{publicIshiki}</span>
    </div>
  );
}

function BridgeEditorProbe() {
  const { publicIshiki, setPublicIshiki, savePublicIshiki } = useBridgeState();
  return (
    <div>
      <textarea
        data-testid="public-ishiki-input"
        value={publicIshiki}
        onChange={(event) => setPublicIshiki(event.target.value)}
      />
      <button type="button" onClick={savePublicIshiki}>save</button>
    </div>
  );
}

describe('useBridgeState snapshot hydration', () => {
  beforeEach(() => {
    Object.keys(mockState).forEach(key => delete mockState[key]);
    Object.assign(mockState, {
      currentAgentId: 'hana',
      showToast: vi.fn(),
      settingsSnapshot: {
        key: 'local:snapshot:hana',
        status: 'ready',
        data: {
          agentId: 'hana',
          publicIshiki: 'snapshot-public-ishiki',
          bridgeStatus: {
            agentId: 'hana',
            telegram: {
              enabled: true,
              configured: true,
              status: 'connected',
              token: 'masked-token',
              agentId: 'hana',
            },
            feishu: { enabled: false, status: 'disconnected', agentId: 'hana' },
            whatsapp: { enabled: false, status: 'disconnected', agentId: 'hana' },
            qq: { enabled: false, status: 'disconnected', agentId: 'hana' },
            wechat: { enabled: false, status: 'disconnected', token: '', agentId: 'hana' },
            permissionMode: 'operate',
            readOnly: false,
            receiptEnabled: true,
            richStreamingEnabled: true,
            knownUsers: {},
            owner: {},
          },
        },
        error: null,
        requestId: 1,
        updatedAt: Date.now(),
      },
    });
    mockHanaFetch.mockReset();
    mockUpdateSettingsSnapshot.mockClear();
    mockHanaFetch.mockImplementation((url: string) => {
      if (url === '/api/bridge/status?agentId=hana') {
        return new Promise<Response>(() => {});
      }
      throw new Error(`unexpected request: ${url}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('uses snapshot bridge status before the status refresh request settles', () => {
    render(<BridgeProbe />);

    expect(screen.getByTestId('telegram-enabled')).toHaveTextContent('true');
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('operate');
    expect(screen.getByTestId('rich-streaming')).toHaveTextContent('true');
    expect(screen.getByTestId('telegram-token')).toHaveTextContent('masked-token');
    expect(screen.getByTestId('public-ishiki')).toHaveTextContent('snapshot-public-ishiki');
    expect(mockHanaFetch).toHaveBeenCalledWith(
      '/api/bridge/status?agentId=hana',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('keeps saved public ishiki in the settings snapshot for remounts', async () => {
    mockState.settingsSnapshot.data.publicIshiki = '';
    mockHanaFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/bridge/status?agentId=hana') {
        return new Promise<Response>(() => {});
      }
      if (url === '/api/agents/hana/public-ishiki') {
        expect(opts).toMatchObject({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'saved public ishiki' }),
        });
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const first = render(<BridgeEditorProbe />);

    fireEvent.change(screen.getByTestId('public-ishiki-input'), {
      target: { value: 'saved public ishiki' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => {
      expect(mockState.showToast).toHaveBeenCalledWith('settings.saved', 'success');
    });
    expect(mockState.settingsSnapshot.data.publicIshiki).toBe('saved public ishiki');

    first.unmount();
    render(<BridgeEditorProbe />);

    expect(screen.getByTestId('public-ishiki-input')).toHaveValue('saved public ishiki');
  });
});
