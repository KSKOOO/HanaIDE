// @vitest-environment jsdom

/**
 * #1624 工具能力漂移提示 chip：
 *  - 文案按 added / removed+invalid / promptChanged 组装
 *  - 刷新走两步确认（诚实告知压缩会丢细节），确认后才调 refreshSessionCapabilities
 *  - 忽略回传当前 fingerprint
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityDriftNotice } from '../../components/input/CapabilityDriftNotice';
import {
  dismissSessionCapabilityDrift,
  refreshSessionCapabilities,
} from '../../stores/session-actions';
import type { SessionCapabilityDrift } from '../../types';

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (
      params ? `${key}:${JSON.stringify(params)}` : key
    ),
  }),
}));

vi.mock('../../stores/session-actions', () => ({
  dismissSessionCapabilityDrift: vi.fn(() => Promise.resolve(true)),
  refreshSessionCapabilities: vi.fn(() => Promise.resolve(true)),
}));

function makeDrift(overrides: Partial<SessionCapabilityDrift> = {}): SessionCapabilityDrift {
  return {
    version: 1,
    fingerprint: 'fp-live',
    frozenFingerprint: 'fp-frozen',
    addedToolNames: ['office'],
    removedToolNames: [],
    invalidToolNames: [],
    promptChanged: false,
    hasDrift: true,
    ...overrides,
  };
}

describe('CapabilityDriftNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders added tools count and the title', () => {
    render(<CapabilityDriftNotice sessionPath="/tmp/s.jsonl" drift={makeDrift()} />);
    expect(screen.getByText('session.capabilityDrift.title')).toBeInTheDocument();
    expect(screen.getByText(/addedTools:\{"count":1\}/)).toBeInTheDocument();
  });

  it('merges removed and invalid tool counts into the unavailable segment', () => {
    render(<CapabilityDriftNotice
      sessionPath="/tmp/s.jsonl"
      drift={makeDrift({
        addedToolNames: [],
        removedToolNames: ['browser'],
        invalidToolNames: ['retired_tool'],
      })}
    />);
    expect(screen.getByText(/removedTools:\{"count":2\}/)).toBeInTheDocument();
  });

  it('shows the prompt-updated segment when promptChanged', () => {
    render(<CapabilityDriftNotice
      sessionPath="/tmp/s.jsonl"
      drift={makeDrift({ addedToolNames: [], promptChanged: true })}
    />);
    expect(screen.getByText(/promptUpdated/)).toBeInTheDocument();
  });

  it('dismiss passes the live fingerprint through', () => {
    render(<CapabilityDriftNotice sessionPath="/tmp/s.jsonl" drift={makeDrift()} />);
    fireEvent.click(screen.getByText('session.capabilityDrift.dismissButton'));
    expect(dismissSessionCapabilityDrift).toHaveBeenCalledWith('/tmp/s.jsonl', 'fp-live');
  });

  it('refresh requires an explicit confirmation step before calling the action', () => {
    render(<CapabilityDriftNotice sessionPath="/tmp/s.jsonl" drift={makeDrift()} />);
    fireEvent.click(screen.getByText('session.capabilityDrift.refreshButton'));
    // 第一步只切换到确认态，不触发刷新
    expect(refreshSessionCapabilities).not.toHaveBeenCalled();
    expect(screen.getByText('session.capabilityDrift.confirmText')).toBeInTheDocument();

    fireEvent.click(screen.getByText('session.capabilityDrift.confirmButton'));
    expect(refreshSessionCapabilities).toHaveBeenCalledWith('/tmp/s.jsonl');
  });

  it('cancel backs out of the confirmation step', () => {
    render(<CapabilityDriftNotice sessionPath="/tmp/s.jsonl" drift={makeDrift()} />);
    fireEvent.click(screen.getByText('session.capabilityDrift.refreshButton'));
    fireEvent.click(screen.getByText('session.capabilityDrift.cancelButton'));
    expect(screen.getByText('session.capabilityDrift.title')).toBeInTheDocument();
    expect(refreshSessionCapabilities).not.toHaveBeenCalled();
  });

});
