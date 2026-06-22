/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hanaFetchMock = vi.fn();
const showToastMock = vi.fn();

function response(body: unknown): Response {
  return { json: async () => body } as Response;
}

const experimentsPayload = {
  experiments: [{
    id: 'memory.cache_snapshot_reflection',
    titleKey: 'settings.experiments.cacheSnapshot.title',
    descriptionKey: 'settings.experiments.cacheSnapshot.description',
    owner: 'memory',
    scope: 'global',
    value: 'off',
    defaultValue: 'off',
    valueSchema: {
      type: 'enum',
      presentation: { type: 'paired_toggles' },
      options: [
        { value: 'off', labelKey: 'settings.experiments.cacheSnapshot.off' },
        { value: 'shadow', labelKey: 'settings.experiments.cacheSnapshot.shadow' },
        { value: 'write', labelKey: 'settings.experiments.cacheSnapshot.write' },
      ],
    },
    status: 'beta',
    risk: 'medium',
    restartPolicy: 'new_session',
    targetHome: { tab: 'agent', section: 'memory' },
  }],
};

const observationPayload = {
  observation: {
    status: 'success',
    createdAt: '2026-06-03T00:00:00.000Z',
    sessionPath: '/tmp/session.jsonl',
    trigger: 'threshold',
    usage: { model: 'test-model', cachedTokens: 10, missTokens: 1, latencyMs: 30 },
    summaryPreview: '### 重要事实\n- 无',
    memoryMdPreview: '## 重要事实\n- 候选记忆',
  },
};

vi.mock('../../settings/api', () => ({
  hanaFetch: (url: string, opts?: RequestInit) => hanaFetchMock(url, opts),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => ({
    'settings.experiments.title': '实验',
    'settings.experiments.description': '前沿功能会先放在这里观察。',
    'settings.experiments.owner.memory': '记忆',
    'settings.experiments.cacheSnapshot.title': '缓存记忆系统',
    'settings.experiments.cacheSnapshot.description': '使用缓存快照生成 rolling summary。',
    'settings.experiments.cacheSnapshot.observeOnly': '只观察，不写入记忆',
    'settings.experiments.cacheSnapshot.observationNote': '观察模式不会对正式记忆产生任何影响。它只用于观察新的记忆系统是否达到预期效果。',
    'settings.experiments.cacheSnapshot.writeWarning': '当前会写入正式记忆。',
    'settings.experiments.cacheSnapshot.previewTitle': 'Memory MD Preview',
    'settings.experiments.cacheSnapshot.summaryTitle': 'Rolling Summary Preview',
    'settings.experiments.cacheSnapshot.emptyPreview': '暂无观察结果',
    'settings.experiments.cacheSnapshot.clearObservation': '清除观察结果',
    'settings.experiments.status.beta': 'Beta',
    'settings.experiments.risk.medium': '中风险',
    'settings.experiments.restart.new_session': '新会话生效',
    'settings.autoSaved': '已保存',
  }[key] || key),
}));

vi.mock('../../settings/store', () => {
  const state = {
    agents: [
      { id: 'hana', name: 'Hana', yuan: 'hanako', isPrimary: false },
      { id: 'primary', name: 'Primary', yuan: 'hanako', isPrimary: true },
    ],
    getSettingsAgentId: () => 'hana',
    showToast: showToastMock,
  };
  type SettingsStoreHook = {
    (selector?: (s: typeof state) => unknown): unknown;
    getState: () => typeof state;
  };
  const hook = ((selector?: (s: typeof state) => unknown) => (
    selector ? selector(state) : state
  )) as SettingsStoreHook;
  hook.getState = () => state;
  return { useSettingsStore: hook };
});

vi.mock('../../utils/markdown', () => ({
  renderMarkdown: (md: string) => `<p>${md}</p>`,
}));

describe('ExperimentsTab', () => {
  beforeEach(() => {
    hanaFetchMock.mockReset();
    showToastMock.mockClear();
    hanaFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') {
        return response({ ok: true, value: JSON.parse(String(opts.body)).value });
      }
      if (url === '/api/experiments') return response(experimentsPayload);
      if (url === '/api/experiments/memory/cache-snapshot-reflection/observation?agentId=primary') {
        return response(observationPayload);
      }
      return response({ observation: null });
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('maps the dual toggles to shadow by default and write when observe-only is off', async () => {
    const { ExperimentsTab } = await import('../../settings/tabs/ExperimentsTab');
    render(<ExperimentsTab />);

    const main = await screen.findByRole('switch', { name: '缓存记忆系统' });
    expect(main).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(main);

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith(
        '/api/experiments/memory.cache_snapshot_reflection',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ value: 'shadow' }),
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getAllByText(/观察模式不会对正式记忆产生任何影响/)).toHaveLength(1);
      expect(hanaFetchMock).toHaveBeenCalledWith(
        '/api/experiments/memory/cache-snapshot-reflection/observation?agentId=primary',
        undefined,
      );
    });

    const observeOnly = await screen.findByRole('switch', { name: '只观察，不写入记忆' });
    expect(observeOnly).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(observeOnly);

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith(
        '/api/experiments/memory.cache_snapshot_reflection',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ value: 'write' }),
        }),
      );
    });
    expect(screen.getByText(/当前会写入正式记忆/)).toBeInTheDocument();
  });
});
