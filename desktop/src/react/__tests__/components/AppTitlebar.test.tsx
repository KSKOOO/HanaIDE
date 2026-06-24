// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppTitlebar } from '../../components/app/AppTitlebar';

vi.mock('../../components/channels/ChannelTabBar', () => ({
  ChannelTabBar: () => <div data-testid="channel-tabs" />,
}));

vi.mock('../../components/plugin/WidgetButtons', () => ({
  WidgetButtons: () => <div data-testid="widget-buttons" />,
}));

vi.mock('../../components/WindowControls', () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?\\}`));
  return match?.[0] ?? '';
}

describe('AppTitlebar', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render the file preview toggle by default on desktop', () => {
    render(
      <AppTitlebar
        sidebarOpen={false}
        jianOpen={false}
        onToggleSidebar={vi.fn()}
        onToggleJian={vi.fn()}
      />,
    );

    expect(screen.queryByTitle('preview.toggle')).not.toBeInTheDocument();
    expect(screen.getByTitle('sidebar.jian')).toBeInTheDocument();
  });

  it('renders a file preview toggle next to the right workspace toggle when enabled', () => {
    const onTogglePreview = vi.fn();

    render(
      <AppTitlebar
        sidebarOpen={false}
        jianOpen={false}
        previewOpen={false}
        showPreviewToggle
        onToggleSidebar={vi.fn()}
        onToggleJian={vi.fn()}
        onTogglePreview={onTogglePreview}
      />,
    );

    const previewToggle = screen.getByTitle('preview.toggle');
    const rightToggle = screen.getByTitle('sidebar.jian');
    expect(previewToggle.compareDocumentPosition(rightToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(previewToggle).not.toHaveClass('active');

    fireEvent.click(previewToggle);
    expect(onTogglePreview).toHaveBeenCalledTimes(1);
  });

  it('marks the file preview toggle active while the preview panel is open', () => {
    render(
      <AppTitlebar
        sidebarOpen={false}
        jianOpen={false}
        previewOpen={true}
        showPreviewToggle
        onToggleSidebar={vi.fn()}
        onToggleJian={vi.fn()}
        onTogglePreview={vi.fn()}
      />,
    );

    expect(screen.getByTitle('preview.toggle')).toHaveClass('active');
  });

  it('opens titlebar menus and dispatches coding commands from menu items', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    render(
      <AppTitlebar
        sidebarOpen={false}
        jianOpen={false}
        onToggleSidebar={vi.fn()}
        onToggleJian={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('menuitem', { name: 'titlebar.menu.file' }));
    const openFolder = screen.getByRole('menuitem', { name: 'titlebar.menu.openFolder' });
    fireEvent.click(openFolder);

    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'hana:coding-command',
      detail: { action: 'workspace.openFolder', command: undefined },
    }));
  });

  it('keeps titlebar menu panels clickable outside the native drag region', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'desktop/src/styles.css'), 'utf8');
    const panelRule = cssRule(css, '.tb-menu-panel');
    const itemRule = cssRule(css, '.tb-menu-item');
    const winMenuRule = cssRule(css, 'html[data-platform="win32"] .tb-menu-bar,\nhtml[data-platform="linux"] .tb-menu-bar');

    expect(panelRule).toMatch(/pointer-events:\s*auto;/);
    expect(panelRule).toMatch(/-webkit-app-region:\s*no-drag;/);
    expect(itemRule).toMatch(/pointer-events:\s*auto;/);
    expect(itemRule).toMatch(/-webkit-app-region:\s*no-drag;/);
    expect(winMenuRule).toMatch(/overflow:\s*visible;/);
    expect(winMenuRule).not.toMatch(/overflow:\s*hidden;/);
  });
});
