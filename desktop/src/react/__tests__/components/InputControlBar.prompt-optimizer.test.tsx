// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputControlBar } from '../../components/input/InputControlBar';

const baseProps = {
  t: (key: string) => key,
  onAttach: vi.fn(),
  slashBtnRef: { current: null },
  onSlashToggle: vi.fn(),
  permissionMode: 'auto' as const,
  onPermissionModeChange: vi.fn(),
  planModeLocked: false,
  showThinking: false,
  thinkingLevel: 'auto' as const,
  onThinkingChange: vi.fn(),
  availableThinkingLevels: ['auto' as const],
  models: [],
  isStreaming: false,
  hasInput: true,
  canSend: true,
  showAudioInput: false,
  audioRecordingActive: false,
  audioRecordingBusy: false,
  onAudioToggle: vi.fn(),
  onSend: vi.fn(),
  onSteer: vi.fn(),
  onStop: vi.fn(),
};

describe('InputControlBar prompt optimizer', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows a coding prompt optimization control in the chat box toolbar when input exists', () => {
    const onOptimizePrompt = vi.fn();
    render(<InputControlBar {...baseProps} onOptimizePrompt={onOptimizePrompt} />);

    const button = screen.getByRole('button', { name: 'input.optimizePrompt' });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    expect(onOptimizePrompt).toHaveBeenCalledTimes(1);
  });

  it('keeps the prompt optimization control visible but disabled for empty input', () => {
    const onOptimizePrompt = vi.fn();
    render(<InputControlBar {...baseProps} hasInput={false} onOptimizePrompt={onOptimizePrompt} />);

    const button = screen.getByRole('button', { name: 'input.optimizePrompt' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onOptimizePrompt).not.toHaveBeenCalled();
  });
});
