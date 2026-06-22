/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { WorkflowInlineCard } from '../WorkflowInlineCard';

const mk = (over: any) => ({
  taskId: 'w1', taskTitle: '三行晨诗', streamStatus: 'running',
  startedAt: 1000, finishedAt: null, ...over,
});

describe('WorkflowInlineCard', () => {
  it('显示 workflow 名 + 静态运行状态', () => {
    const { container } = render(<WorkflowInlineCard block={mk({ streamStatus: 'running' })} />);
    expect(container.textContent).toContain('三行晨诗');
    expect(container.textContent).toContain('◐ 运行中');
    expect(container.querySelector('[data-chat-resource-card]')).toBeTruthy();
  });

  it('done 显示完成图标 + 耗时', () => {
    (window as any).t = (k: string, vars?: any) => (k === 'activity.duration' ? `耗时 ${vars?.text}` : k);
    const { container } = render(<WorkflowInlineCard block={mk({ streamStatus: 'done', startedAt: 1000, finishedAt: 6000 })} />);
    expect(container.textContent).toContain('✓ 已完成');
    expect(container.textContent).toContain('5s');
    delete (window as any).t;
  });

  it('failed 显示失败图标', () => {
    const { container } = render(<WorkflowInlineCard block={mk({ streamStatus: 'failed', finishedAt: 2000 })} />);
    expect(container.textContent).toContain('✗ 失败');
  });
});
