// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { switchTab } from '../../components/channels/ChannelTabBar';
import { useStore } from '../../stores';

describe('ChannelTabBar switchTab', () => {
  let localStorageData: Record<string, string>;

  beforeEach(() => {
    localStorageData = {};
    const storage = {
      getItem: vi.fn((key: string) => localStorageData[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStorageData[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete localStorageData[key];
      }),
      clear: vi.fn(() => {
        localStorageData = {};
      }),
    };
    vi.stubGlobal('localStorage', storage);
    Object.defineProperty(window, 'localStorage', {
      value: storage,
      configurable: true,
    });
    useStore.setState({
      currentTab: 'coding',
      sidebarOpen: true,
      sidebarAutoCollapsed: false,
      jianOpen: true,
      jianAutoCollapsed: false,
      activePanel: null,
    } as never);
  });

  it('normalizes removed chat and channel tabs back to coding mode', () => {
    switchTab('chat');
    expect(useStore.getState().currentTab).toBe('coding');
    expect(localStorage.getItem('hana-tab')).toBe('coding');

    switchTab('channels');
    expect(useStore.getState().currentTab).toBe('coding');
    expect(localStorage.getItem('hana-tab')).toBe('coding');
  });

  it('keeps the right workspace companion state independent from tab switches', () => {
    localStorage.setItem('hana-jian-plugin:hanako-hyperframes', 'closed');
    localStorage.setItem('hana-jian-plugin:other-plugin', 'open');

    switchTab('plugin:hanako-hyperframes');

    expect(useStore.getState().currentTab).toBe('plugin:hanako-hyperframes');
    expect(useStore.getState().jianOpen).toBe(true);

    switchTab('plugin:other-plugin');

    expect(useStore.getState().currentTab).toBe('plugin:other-plugin');
    expect(useStore.getState().jianOpen).toBe(true);
  });
});
