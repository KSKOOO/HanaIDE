/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCardStack, calculateAgentCardGeometry } from '../../settings/tabs/agent/AgentCardStack';

vi.mock('../../settings/store', () => ({
  useSettingsStore: Object.assign(vi.fn(), { setState: vi.fn() }),
}));

vi.mock('../../settings/api', () => ({
  hanaFetch: vi.fn(),
  hanaUrl: (path: string) => path,
  yuanFallbackAvatar: (yuan?: string) => `fallback:${yuan || 'hanako'}`,
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../../settings/actions', () => ({
  loadAgents: vi.fn(),
}));

const agents = [
  { id: 'hana', name: '小花', yuan: 'hanako', isPrimary: true, hasAvatar: false },
  { id: 'deepseek', name: 'DeepSeek', yuan: 'deepseek', isPrimary: false, hasAvatar: false },
  { id: 'maomao', name: '毛毛', yuan: 'maomao', isPrimary: false, hasAvatar: false },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AgentCardStack geometry', () => {
  it('centers a one-agent stack when it expands', () => {
    const geometry = calculateAgentCardGeometry(2);

    expect(geometry.spreadWidth).toBe(260);
    expect(geometry.positions).toEqual([63, 135]);
    expect(geometry.positions[0] + geometry.groupWidth / 2).toBe(130);
  });

  it('centers a two-agent stack when it expands', () => {
    const geometry = calculateAgentCardGeometry(3);

    expect(geometry.spreadWidth).toBe(260);
    expect(geometry.positions).toEqual([27, 99, 171]);
    expect(geometry.positions[0] + geometry.groupWidth / 2).toBe(130);
  });

  it('uses the natural group width once the expanded stack is wider than compact width', () => {
    const geometry = calculateAgentCardGeometry(5);

    expect(geometry.spreadWidth).toBe(386);
    expect(geometry.positions).toEqual([18, 90, 162, 234, 306]);
  });

  it('adds edge bleed before the expanded cards touch the scroll boundary', () => {
    const geometry = calculateAgentCardGeometry(4);

    expect(geometry.spreadWidth).toBe(314);
    expect(geometry.positions).toEqual([18, 90, 162, 234]);
  });
});

describe('AgentCardStack actions', () => {
  it('lets the page own wheel scrolling while the stack is collapsed and captures horizontal stack scrolling only after expansion', () => {
    render(React.createElement(AgentCardStack, {
      agents,
      selectedId: 'hana',
      currentAgentId: 'hana',
      onSelect: vi.fn(),
      onAvatarClick: vi.fn(),
      onSetPrimary: vi.fn(),
      onDelete: vi.fn(),
      onExport: vi.fn(),
      onAdd: vi.fn(),
    }));

    const stack = screen.getByText('DeepSeek').closest('[class*="agent-cards"]') as HTMLElement;
    expect(stack).not.toBeNull();
    Object.defineProperty(stack, 'scrollWidth', { configurable: true, value: 900 });
    Object.defineProperty(stack, 'clientWidth', { configurable: true, value: 260 });

    const collapsedWheel = new WheelEvent('wheel', { deltaY: 48, cancelable: true });
    stack.dispatchEvent(collapsedWheel);
    expect(collapsedWheel.defaultPrevented).toBe(false);
    expect(stack.scrollLeft).toBe(0);

    fireEvent.pointerEnter(stack);

    const expandedWheel = new WheelEvent('wheel', { deltaY: 48, cancelable: true });
    stack.dispatchEvent(expandedWheel);
    expect(expandedWheel.defaultPrevented).toBe(true);
    expect(stack.scrollLeft).toBe(48);
  });

  it('shows quiet actions below the selected non-primary agent and calls explicit targets', () => {
    const onSetPrimary = vi.fn();
    const onDelete = vi.fn();
    const onExport = vi.fn();

    render(React.createElement(AgentCardStack, {
      agents,
      selectedId: 'deepseek',
      currentAgentId: 'hana',
      onSelect: vi.fn(),
      onAvatarClick: vi.fn(),
      onSetPrimary,
      onDelete,
      onExport,
      onAdd: vi.fn(),
    }));

    fireEvent.click(screen.getByRole('button', { name: 'settings.agent.setPrimary' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.agent.exportAgent' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.agent.deleteBtn' }));

    expect(onSetPrimary).toHaveBeenCalledWith('deepseek');
    expect(onExport).toHaveBeenCalledWith('deepseek');
    expect(onDelete).toHaveBeenCalledWith('deepseek');
  });

  it('does not show set-primary or delete actions for the primary agent', () => {
    render(React.createElement(AgentCardStack, {
      agents,
      selectedId: 'hana',
      currentAgentId: 'hana',
      onSelect: vi.fn(),
      onAvatarClick: vi.fn(),
      onSetPrimary: vi.fn(),
      onDelete: vi.fn(),
      onExport: vi.fn(),
      onAdd: vi.fn(),
    }));

    expect(screen.queryByRole('button', { name: 'settings.agent.setPrimary' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings.agent.exportAgent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'settings.agent.deleteBtn' })).not.toBeInTheDocument();
  });

  it('does not open agent actions from right click', () => {
    render(React.createElement(AgentCardStack, {
      agents,
      selectedId: 'hana',
      currentAgentId: 'hana',
      onSelect: vi.fn(),
      onAvatarClick: vi.fn(),
      onSetPrimary: vi.fn(),
      onDelete: vi.fn(),
      onExport: vi.fn(),
      onAdd: vi.fn(),
    }));

    const deepseekCard = screen.getByText('DeepSeek').closest('[data-agent-id="deepseek"]');
    expect(deepseekCard).not.toBeNull();
    fireEvent.contextMenu(deepseekCard as HTMLElement);

    expect(screen.queryByRole('button', { name: 'settings.agent.setPrimary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'settings.agent.deleteBtn' })).not.toBeInTheDocument();
  });

  it('keeps the delete action available for a selected non-primary agent that is also the current agent (#1301)', () => {
    const onDelete = vi.fn();

    render(React.createElement(AgentCardStack, {
      agents,
      selectedId: 'deepseek',
      currentAgentId: 'deepseek', // 新建 agent 会被自动切为 current；删除不应因此被隐藏
      onSelect: vi.fn(),
      onAvatarClick: vi.fn(),
      onSetPrimary: vi.fn(),
      onDelete,
      onExport: vi.fn(),
      onAdd: vi.fn(),
    }));

    fireEvent.click(screen.getByRole('button', { name: 'settings.agent.deleteBtn' }));
    expect(onDelete).toHaveBeenCalledWith('deepseek');
  });
});
