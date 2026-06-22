/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useSettingsStore } from '../../store';

const hanaFetch = vi.fn();

vi.mock('../../api', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetch(...args),
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

describe('PluginsTab settings switches', () => {
  beforeEach(() => {
    vi.resetModules();
    hanaFetch.mockResolvedValue(jsonResponse([]));
    window.t = ((key: string) => key) as typeof window.t;
    window.platform = {
      selectFile: vi.fn(),
      selectDirectory: vi.fn(),
      showInFinder: vi.fn(),
    } as unknown as typeof window.platform;
    useSettingsStore.setState({
      pluginAllowFullAccess: undefined,
      pluginDevToolsEnabled: undefined,
      pluginUserDir: '',
      toastMessage: '',
      toastType: '',
      toastVisible: false,
    } as never);
  });

  afterEach(() => {
    cleanup();
    hanaFetch.mockReset();
    vi.unstubAllGlobals();
    useSettingsStore.setState({
      pluginAllowFullAccess: undefined,
      pluginDevToolsEnabled: undefined,
      pluginUserDir: '',
    } as never);
  });

  it('keeps permission toggles loading until plugin settings are ready', async () => {
    const { PluginsTab } = await import('../PluginsTab');

    render(<PluginsTab />);

    const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
    expect(switches.slice(-2)).toHaveLength(2);
    for (const item of switches.slice(-2)) {
      expect(item.getAttribute('aria-checked')).toBe('mixed');
      expect(item.getAttribute('aria-busy')).toBe('true');
      expect(item.disabled).toBe(true);
    }
  });
});
