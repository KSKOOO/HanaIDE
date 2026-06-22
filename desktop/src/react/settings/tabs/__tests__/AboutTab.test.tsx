/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
}));

import { AboutTab } from '../AboutTab';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function installHana() {
  vi.stubGlobal('window', Object.assign(window, {
    hana: {
      getAppVersion: vi.fn().mockResolvedValue('0.160.2'),
      openExternal: vi.fn(),
    },
  }));
}

describe('AboutTab', () => {
  it('does not expose application update controls', () => {
    installHana();

    render(<AboutTab />);

    expect(screen.queryByText('settings.about.autoCheckUpdates')).toBeNull();
    expect(screen.queryByText('settings.about.betaUpdates')).toBeNull();
    expect(screen.queryByText('settings.about.updateCheckBtn')).toBeNull();
    expect(screen.queryByText('settings.general.launchAtLogin')).toBeNull();
    expect(screen.queryByText('settings.general.keepAwake')).toBeNull();
  });

  it('does not expose a GitHub link in the about panel', () => {
    installHana();

    render(<AboutTab />);

    expect(screen.queryByText('GitHub')).toBeNull();
    expect(screen.queryByText(/github\.com/i)).toBeNull();
  });

  it('shows the updated copyright holders', () => {
    installHana();

    render(<AboutTab />);

    expect(screen.getByText('(c) 2026 liliMozi, kskooo')).toBeTruthy();
  });
});
