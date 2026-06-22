/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockResponse = { json: () => Promise<any> };

const hanaFetchMock = vi.fn(async (_url: string, _opts?: RequestInit): Promise<MockResponse> => ({
  json: async () => ({
    agentId: 'hana',
    status: 'degraded',
    reason: null,
    failedSteps: ['deepMemory'],
    maxFailCount: 2,
    lastSuccessAt: '2026-06-01T10:05:00.000Z',
    lastErrorAt: '2026-06-01T10:10:00.000Z',
    steps: {
      deepMemory: {
        lastSuccessAt: null,
        lastErrorAt: '2026-06-01T10:10:00.000Z',
        lastErrorMsg: 'LLM timeout',
        failCount: 2,
      },
    },
  }),
}));

vi.mock('../../settings/api', () => ({
  hanaFetch: (url: string, opts?: RequestInit) => hanaFetchMock(url, opts),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string, params?: Record<string, any>) => {
    const messages: Record<string, string> = {
      'settings.memory.sectionTitle': '记忆',
      'settings.memory.needsUtilityModel': '需要先配置 Utility 模型',
      'settings.memory.health.degraded': '记忆整理有延迟',
      'settings.memory.health.failedSteps': `异常步骤：${params?.steps}`,
      'settings.memory.health.lastError': `最近错误：${params?.time}`,
      'settings.memory.health.errorMessage': `错误：${params?.message}`,
      'settings.memory.health.steps.deepMemory': '深层记忆',
      'settings.pins.title': '置顶记忆',
      'settings.pins.hint': '优先保留',
      'settings.pins.empty': '没有置顶记忆',
      'settings.pins.addPlaceholder': '添加置顶记忆',
      'settings.memory.compiled': '当下记忆',
      'settings.memory.compiledHint': '助手记住的重要内容',
      'settings.memory.compiledView': '查看当下记忆',
      'settings.memory.allMemories': '所有记忆',
      'settings.memory.actions.view': '查看记忆',
      'settings.memory.actions.clear': '清除记忆',
    };
    return messages[key] ?? key;
  },
  autoSaveConfig: vi.fn(async () => true),
  savePins: vi.fn(),
}));

describe('Agent memory settings health notice', () => {
  beforeEach(() => {
    hanaFetchMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows a memory failure notice in the Agent memory section', async () => {
    const { MemorySection } = await import('../../settings/tabs/agent/AgentMemory');

    render(
      <MemorySection
        agentId="hana"
        hasUtilityModel
        memoryEnabled
        currentPins={[]}
      />,
    );

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith(
        '/api/memories/health?agentId=hana',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(await screen.findByText('记忆整理有延迟')).toBeInTheDocument();
    expect(screen.getByText('异常步骤：深层记忆')).toBeInTheDocument();
    expect(screen.getByText('错误：LLM timeout')).toBeInTheDocument();
  });
});
