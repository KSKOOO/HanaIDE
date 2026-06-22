// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsContent } from '../SettingsContent';
import { useSettingsStore } from '../store';

vi.mock('../actions', () => ({
  loadAgents: vi.fn(async () => {}),
  loadAvatars: vi.fn(async () => {}),
  loadSettingsConfig: vi.fn(async () => {}),
  loadSettingsSnapshot: vi.fn(async () => {}),
  loadPluginSettings: vi.fn(async () => {}),
  updateSettingsSnapshot: vi.fn(),
}));

vi.mock('../api', () => ({
  hanaFetch: vi.fn(async (url: string) => {
    if (url === '/api/config') {
      return new Response(JSON.stringify({ locale: 'zh-CN' }));
    }
    return new Response(JSON.stringify({ experiments: [] }));
  }),
}));

describe('SettingsContent tab heading', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    window.i18n = {
      locale: 'zh-CN',
      defaultName: 'Hana',
      _data: {},
      _agentOverrides: {},
      load: vi.fn(async () => {}),
      setAgentOverrides: vi.fn(),
      t: ((key: string) => key) as typeof window.t,
    };
    window.platform = {
      getServerPort: vi.fn(async () => 3000),
      getServerToken: vi.fn(async () => null),
      getPlatform: vi.fn(async () => 'darwin'),
      onSwitchTab: vi.fn(),
      onSettingsChanged: vi.fn(),
      onServerRestarted: vi.fn(),
    } as unknown as typeof window.platform;
    useSettingsStore.setState({
      activeTab: 'agent',
      platformName: 'darwin',
      pluginSettingsTabs: [],
      ready: true,
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('normalizes the removed experiments tab to general settings', async () => {
    useSettingsStore.setState({ activeTab: 'experiments' } as never);

    render(React.createElement(SettingsContent, { variant: 'window' }));

    await waitFor(() => {
      expect(useSettingsStore.getState().activeTab).toBe('general');
    });
    expect(screen.getByRole('heading', { name: 'settings.tabs.general' })).toBeTruthy();
    expect(screen.queryByText('settings.experiments.description')).toBeNull();
  });

  it('normalizes the removed browser tab to general settings', async () => {
    useSettingsStore.setState({
      activeTab: 'browser',
      settingsSnapshot: {
        status: 'ready',
        key: 'snapshot:browser',
        requestId: 1,
        data: {
          agentId: 'hana',
          config: {},
          identity: '',
          ishiki: '',
          publicIshiki: '',
          userProfile: '',
          experience: '',
          pinned: { pins: [] },
          globalModels: {},
          preferences: {
            quickChat: {},
            notifications: {},
            bridge: { permissionMode: 'auto', readOnly: false, receiptEnabled: true },
            speechRecognition: {},
            experiments: [],
            browser: { acceptCookies: true, agentOpenBehavior: 'smart' },
          },
          plugins: {
            allowFullAccess: false,
            devToolsEnabled: false,
            userDir: '',
            settingsTabs: [],
          },
        },
      },
    } as never);

    render(React.createElement(SettingsContent, { variant: 'window' }));

    await waitFor(() => {
      expect(useSettingsStore.getState().activeTab).toBe('general');
    });
    expect(screen.getByRole('heading', { name: 'settings.tabs.general' })).toBeTruthy();
    expect(screen.queryByText('settings.tabs.browser')).toBeNull();
    expect(screen.queryByText('settings.browser.acceptCookies')).toBeNull();
  });
});
