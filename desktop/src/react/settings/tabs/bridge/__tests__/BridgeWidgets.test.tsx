/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BridgeStatusDot, BridgeStatusText } from '../BridgeWidgets';

vi.mock('../../../helpers', () => ({
  t: (key: string) => key,
}));

describe('Bridge status widgets', () => {
  it('renders loading status instead of disconnected while bridge status is unknown', () => {
    render(
      <div>
        <BridgeStatusDot status={undefined} />
        <BridgeStatusText status={undefined} />
      </div>,
    );

    expect(screen.getByText('common.loading')).toBeTruthy();
    expect(screen.queryByText('settings.bridge.disconnected')).toBeNull();
    expect(document.querySelector('.bridge-status-dot')?.getAttribute('aria-busy')).toBe('true');
  });
});
