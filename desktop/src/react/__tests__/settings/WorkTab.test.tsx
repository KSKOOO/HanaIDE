/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockState = Record<string, any>;

const mockState: MockState = {};
const mockHanaFetch = vi.fn();
const autoSaveConfigMock = vi.fn(async (_partial?: unknown, _options?: unknown) => {});

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

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: (partial: unknown, options?: unknown) => (
    options === undefined ? autoSaveConfigMock(partial) : autoSaveConfigMock(partial, options)
  ),
}));

vi.mock('../../settings/tabs/bridge/AgentSelect', () => ({
  AgentSelect: ({ value }: { value: string | null }) => (
    <div data-testid="agent-select">{value}</div>
  ),
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

describe('WorkTab workspace persistence', () => {
  beforeEach(() => {
    Object.keys(mockState).forEach(key => delete mockState[key]);
    Object.assign(mockState, {
      settingsConfig: { desk: {} },
      currentAgentId: 'agent-a',
      showToast: vi.fn(),
    });
    mockHanaFetch.mockReset();
    autoSaveConfigMock.mockClear();
    mockHanaFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url === '/api/agents/agent-a/config' && !options?.method) {
        return Promise.resolve(jsonResponse({
          desk: {
            home_folder: '/old-home',
            heartbeat_enabled: true,
            heartbeat_interval: 17,
          },
          workspace_context: {
            inject_agents_md: false,
            inject_claude_md: true,
          },
        }));
      }
      if (url === '/api/agents/agent-a/config' && options?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    window.platform = {
      selectFolder: vi.fn(async () => '/new-home'),
      settingsChanged: vi.fn(),
    } as unknown as typeof window.platform;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the current agent desk settings from settingsConfig on the first paint', async () => {
    mockState.settingsConfig = {
      desk: {
        home_folder: '/snapshot-home',
        heartbeat_master: true,
        heartbeat_enabled: false,
        heartbeat_interval: 23,
      },
      workspace_context: {
        inject_agents_md: true,
        inject_claude_md: false,
      },
    };
    mockState.settingsSnapshot = { data: { agentId: 'agent-a' } };
    const { WorkTab } = await import('../../settings/tabs/WorkTab');

    render(<WorkTab />);

    expect(screen.getByDisplayValue('/snapshot-home')).toBeTruthy();
    expect(screen.getByDisplayValue('23')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'settings.work.injectAgentsMd' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'settings.work.injectClaudeMd' }).getAttribute('aria-checked')).toBe('false');
  });

  it('saves the selected agent workspace without sending frontend business IPC', async () => {
    const { WorkTab } = await import('../../settings/tabs/WorkTab');

    render(<WorkTab />);

    fireEvent.click(await screen.findByDisplayValue('/old-home'));

    await waitFor(() => {
      expect(mockHanaFetch).toHaveBeenCalledWith('/api/agents/agent-a/config', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ desk: { home_folder: '/new-home' } }),
      }));
    });
    expect(window.platform.settingsChanged).not.toHaveBeenCalled();
  });

  it('clears the selected agent workspace without sending frontend business IPC', async () => {
    const { WorkTab } = await import('../../settings/tabs/WorkTab');

    render(<WorkTab />);

    fireEvent.click(await screen.findByTitle('settings.work.homeFolderClear'));

    await waitFor(() => {
      expect(mockHanaFetch).toHaveBeenCalledWith('/api/agents/agent-a/config', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ desk: { home_folder: '' } }),
      }));
    });
    expect(window.platform.settingsChanged).not.toHaveBeenCalled();
  });

  it('shows 31 minutes when the agent config omits the patrol interval', async () => {
    mockHanaFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url === '/api/agents/agent-a/config' && !options?.method) {
        return Promise.resolve(jsonResponse({
          desk: {
            home_folder: '/old-home',
            heartbeat_enabled: false,
          },
        }));
      }
      if (url === '/api/agents/agent-a/config' && options?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const { WorkTab } = await import('../../settings/tabs/WorkTab');

    render(<WorkTab />);

    expect(await screen.findByDisplayValue('31')).toBeTruthy();
  });

  it('treats a missing per-agent heartbeat flag as off after loading the agent config', async () => {
    mockHanaFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url === '/api/agents/agent-a/config' && !options?.method) {
        return Promise.resolve(jsonResponse({
          desk: {
            home_folder: '/old-home',
            heartbeat_interval: 31,
          },
        }));
      }
      if (url === '/api/agents/agent-a/config' && options?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const { WorkTab } = await import('../../settings/tabs/WorkTab');

    render(<WorkTab />);

    const interval = await screen.findByDisplayValue('31') as HTMLInputElement;
    expect(interval.disabled).toBe(true);
  });

  it('warns that patrol mode can operate in the workspace', async () => {
    const { WorkTab } = await import('../../settings/tabs/WorkTab');

    render(<WorkTab />);

    expect(await screen.findByText('settings.work.heartbeatOperationalNotice')).toBeTruthy();
    expect(screen.getByText('settings.work.automationPermissionModeDesc')).toBeTruthy();
  });

  it('keeps global work switches loading until settings config is ready', async () => {
    mockState.settingsConfig = null;
    const { WorkTab } = await import('../../settings/tabs/WorkTab');

    render(<WorkTab />);

    const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
    expect(switches).toHaveLength(1);
    expect(switches[0].getAttribute('aria-checked')).toBe('mixed');
    expect(switches[0].disabled).toBe(true);
    expect((screen.getByRole('button', { name: /common\.loading/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('uses automation.permissionMode and does not render the removed cron auto-approve row', async () => {
    mockState.settingsConfig = {
      desk: { heartbeat_master: true, cron_auto_approve: true },
      automation: { permissionMode: 'read_only' },
    };
    const { WorkTab } = await import('../../settings/tabs/WorkTab');

    render(<WorkTab />);

    expect(screen.queryByText('settings.work.cronAutoApprove')).toBeNull();
    expect(screen.getByText('settings.work.automationPermissionMode')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /settings\.bridge\.permissionModeReadOnly/ }));
    fireEvent.click(screen.getByRole('option', { name: /settings\.bridge\.permissionModeOperate/ }));

    expect(autoSaveConfigMock).toHaveBeenCalledWith({ automation: { permissionMode: 'operate' } });
    expect(autoSaveConfigMock).not.toHaveBeenCalledWith(expect.objectContaining({
      desk: expect.objectContaining({ cron_auto_approve: expect.anything() }),
    }));
  });

  it('saves the selected agent AGENTS.md injection toggle', async () => {
    const { WorkTab } = await import('../../settings/tabs/WorkTab');

    render(<WorkTab />);

    fireEvent.click(await screen.findByRole('switch', { name: 'settings.work.injectAgentsMd' }));

    await waitFor(() => {
      expect(mockHanaFetch).toHaveBeenCalledWith('/api/agents/agent-a/config', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ workspace_context: { inject_agents_md: true } }),
      }));
    });
    expect(window.platform.settingsChanged).not.toHaveBeenCalled();
  });

  it('saves the selected agent CLAUDE.md injection toggle', async () => {
    const { WorkTab } = await import('../../settings/tabs/WorkTab');

    render(<WorkTab />);

    fireEvent.click(await screen.findByRole('switch', { name: 'settings.work.injectClaudeMd' }));

    await waitFor(() => {
      expect(mockHanaFetch).toHaveBeenCalledWith('/api/agents/agent-a/config', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ workspace_context: { inject_claude_md: false } }),
      }));
    });
    expect(window.platform.settingsChanged).not.toHaveBeenCalled();
  });
});
