import { describe, expect, it, vi } from 'vitest';
import { buildWorkspaceContextMenuItems } from '../../components/shared/workspace-context-menu';

const t = (key: string) => key;

describe('buildWorkspaceContextMenuItems', () => {
  it('builds the shared coding workspace file menu in a stable order', () => {
    const actions = {
      open: vi.fn(),
      openWith: vi.fn(),
      revealInExplorer: vi.fn(),
      openInTerminal: vi.fn(),
      compare: vi.fn(),
      addToAssistant: vi.fn(),
      copy: vi.fn(),
      copyPath: vi.fn(),
      copyRelativePath: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
    };

    const items = buildWorkspaceContextMenuItems({
      t,
      target: {
        name: 'README.md',
        isDirectory: false,
        absolutePath: 'D:/repo/README.md',
        relativePath: 'README.md',
      },
      actions,
    });

    expect(items.map(item => item.divider ? '---' : item.label)).toEqual([
      'workspace.context.open',
      'workspace.context.openWith',
      'workspace.context.revealInExplorer',
      'workspace.context.openInTerminal',
      '---',
      'workspace.context.compare',
      'workspace.context.addToAssistant',
      '---',
      'workspace.context.cut',
      'workspace.context.copy',
      'workspace.context.copyPath',
      'workspace.context.copyRelativePath',
      '---',
      'workspace.context.rename',
      'workspace.context.delete',
    ]);

    const disabledLabels = items
      .filter(item => item.disabled)
      .map(item => item.label);
    expect(disabledLabels).toEqual(['workspace.context.cut']);
  });

  it('disables actions that have no backing capability and exposes Maven only when pom.xml is present', () => {
    const items = buildWorkspaceContextMenuItems({
      t,
      target: {
        name: 'src',
        isDirectory: true,
        absolutePath: '',
        relativePath: 'src',
        hasPomXml: true,
      },
      actions: {
        open: vi.fn(),
        copyRelativePath: vi.fn(),
        maven: vi.fn(),
      },
    });

    expect(items.find(item => item.label === 'workspace.context.openWith')?.disabled).toBe(true);
    expect(items.find(item => item.label === 'workspace.context.revealInExplorer')?.disabled).toBe(true);
    expect(items.find(item => item.label === 'workspace.context.copyPath')?.disabled).toBe(true);
    expect(items.find(item => item.label === 'workspace.context.maven')).toBeTruthy();
  });
});
