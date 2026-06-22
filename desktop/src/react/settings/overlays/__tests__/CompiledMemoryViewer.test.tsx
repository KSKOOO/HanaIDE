// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompiledMemoryViewer } from '../CompiledMemoryViewer';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';

vi.mock('../../api', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../../hooks/use-mermaid-diagrams', () => ({
  useMermaidDiagrams: vi.fn(),
}));

describe('CompiledMemoryViewer editable facts', () => {
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
    useSettingsStore.setState({
      currentAgentId: 'hana',
      agents: [{ id: 'hana', name: 'Hana', isPrimary: true }],
    } as never);
    vi.mocked(hanaFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/memories/compiled?agentId=hana' && !init) {
        return new Response(JSON.stringify({
          editableFactsEnabled: true,
          sections: {
            facts: '用户喜欢清晰边界。',
            today: '今天只读。',
            week: '本周只读。',
            longterm: '长期只读。',
          },
          content: '',
        }));
      }
      if (url === '/api/memories/compiled/facts?agentId=hana' && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true, facts: '用户喜欢清晰边界。\n用户关注记忆系统。' }));
      }
      throw new Error(`unexpected request ${url}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders editable facts above read-only timeline sections and saves edits', async () => {
    render(React.createElement(CompiledMemoryViewer));

    window.dispatchEvent(new Event('hana-view-compiled-memory'));

    const factsInput = await screen.findByLabelText('settings.memory.editableFactsLabel');
    expect(factsInput).toHaveValue('用户喜欢清晰边界。');
    expect(screen.getByText('settings.memory.readonlyTimelineTitle')).toBeTruthy();
    expect(screen.getByText('今天只读。')).toBeTruthy();
    expect(screen.getByText('本周只读。')).toBeTruthy();
    expect(screen.getByText('长期只读。')).toBeTruthy();

    fireEvent.change(factsInput, {
      target: { value: '用户喜欢清晰边界。\n用户关注记忆系统。' },
    });
    fireEvent.click(screen.getByText('settings.memory.saveFacts'));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/memories/compiled/facts?agentId=hana', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facts: '用户喜欢清晰边界。\n用户关注记忆系统。' }),
      });
    });
  });
});
