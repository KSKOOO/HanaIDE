// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsNav } from '../SettingsNav';
import { useSettingsStore } from '../store';

const translations: Record<string, string> = {
  'settings.settingsSearch.placeholder': 'Search settings',
  'settings.settingsSearch.clear': 'Clear search',
  'settings.settingsSearch.results': 'Search results',
  'settings.settingsSearch.noResults': 'No settings found',
  'settings.tabs.agent': 'Assistant',
  'settings.tabs.me': 'Profile',
  'settings.tabs.interface': 'Interface',
  'settings.tabs.general': 'General',
  'settings.tabs.browser': 'Browser',
  'settings.tabs.work': 'Work',
  'settings.tabs.skills': 'Skills',
  'settings.tabs.bridge': 'Bridge',
  'settings.tabs.providers': 'Models',
  'settings.tabs.media': 'Media',
  'settings.tabs.sharing': 'Sharing',
  'settings.tabs.access': 'Access',
  'settings.tabs.plugins': 'Plugins',
  'settings.tabs.experiments': 'Experiments',
  'settings.tabs.security': 'Security',
  'settings.tabs.about': 'About',
  'settings.api.apiKey': 'API Key',
  'settings.api.searchProvider': 'Search provider',
  'settings.appearance.theme': 'Theme',
};

describe('SettingsNav search', () => {
  beforeEach(() => {
    window.t = ((key: string) => translations[key] || key) as typeof window.t;
    window.i18n = {
      locale: 'zh-CN',
      defaultName: 'Hana',
      _data: {},
      _agentOverrides: {},
      load: vi.fn(async () => {}),
      setAgentOverrides: vi.fn(),
      t: ((key: string) => translations[key] || key) as typeof window.t,
    };
    useSettingsStore.setState({
      activeTab: 'agent',
      pluginSettingsTabs: [
        {
          pluginId: 'native',
          id: 'native-settings',
          title: { zh: 'Plugin Panel', en: 'Native Panel' },
          nativeComponent: 'unknown-native-tab',
        },
      ],
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('switches from the tab list to iOS-style search results and opens the result tab', () => {
    const onTabChange = vi.fn();
    render(React.createElement(SettingsNav, { onTabChange }));

    const input = screen.getByPlaceholderText('Search settings');
    fireEvent.change(input, { target: { value: 'api key' } });

    expect(screen.getByText('Search results')).toBeTruthy();
    expect(screen.getByRole('button', { name: /API Key/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Assistant' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /API Key/ }));

    expect(useSettingsStore.getState().activeTab).toBe('providers');
    expect(onTabChange).toHaveBeenCalledWith('providers');
  });

  it('renders only coding-focused settings tabs', () => {
    const { container } = render(React.createElement(SettingsNav));

    const tabIds = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-tab]'))
      .map(button => button.dataset.tab);

    expect(tabIds).toEqual([
      'agent',
      'interface',
      'general',
      'work',
      'skills',
      'providers',
      'plugins',
      'security',
      'about',
    ]);
    expect(tabIds).not.toContain('me');
    expect(tabIds).not.toContain('browser');
    expect(tabIds).not.toContain('bridge');
    expect(tabIds).not.toContain('media');
    expect(tabIds).not.toContain('sharing');
    expect(tabIds).not.toContain('access');
    expect(tabIds).not.toContain('experiments');
  });

  it('does not search hidden non-coding settings tabs', () => {
    const { container } = render(React.createElement(SettingsNav));
    const input = container.querySelector('input[type="search"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();

    fireEvent.change(input as HTMLInputElement, { target: { value: 'telegram' } });

    expect(screen.getByText('No settings found')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /telegram|bridge/i })).toBeNull();
  });

  it('clears back to the normal tab list', () => {
    render(React.createElement(SettingsNav));

    fireEvent.change(screen.getByPlaceholderText('Search settings'), { target: { value: 'theme' } });
    expect(screen.getByText('Search results')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Clear search'));

    expect((screen.getByPlaceholderText('Search settings') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Assistant' })).toBeTruthy();
  });

  it('does not expose standalone quick chat settings in search', () => {
    const { container } = render(React.createElement(SettingsNav));
    const input = container.querySelector('input');
    expect(input).toBeTruthy();

    fireEvent.change(input as HTMLInputElement, { target: { value: 'quick chat' } });

    expect(screen.queryByText('settings.general.quickChat.title')).toBeNull();
  });
});
