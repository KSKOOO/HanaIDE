/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import type { DeskSearchResult } from '../../types';

const mocks = vi.hoisted(() => ({
    loadDeskFiles: vi.fn(async () => {}),
    loadDeskTreeFiles: vi.fn(async () => {}),
    deskCreateFileInSubdir: vi.fn(async () => true),
    deskMkdirInSubdir: vi.fn(async () => true),
    deskMoveTreeFiles: vi.fn(async () => {}),
    deskRenameTreeItem: vi.fn(async () => true),
    deskTrashTreeItems: vi.fn(async () => true),
    searchDeskFiles: vi.fn(async (): Promise<DeskSearchResult[]> => []),
  jumpToDeskSearchResult: vi.fn(async () => {}),
}));

function pendingCreateInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[data-desk-pending-create] input');
  if (!input) throw new Error('pending create input not found');
  return input;
}

vi.mock('../../stores/desk-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/desk-actions')>();
  return {
    ...actual,
    loadDeskFiles: mocks.loadDeskFiles,
    loadDeskTreeFiles: mocks.loadDeskTreeFiles,
    deskCreateFileInSubdir: mocks.deskCreateFileInSubdir,
    deskMkdirInSubdir: mocks.deskMkdirInSubdir,
    deskMoveTreeFiles: mocks.deskMoveTreeFiles,
    deskRenameTreeItem: mocks.deskRenameTreeItem,
    deskTrashTreeItems: mocks.deskTrashTreeItems,
    searchDeskFiles: mocks.searchDeskFiles,
    jumpToDeskSearchResult: mocks.jumpToDeskSearchResult,
  };
});

describe('DeskSection workspace watching', () => {
  let emitWorkspaceChanged: ((event: {
    rootPath: string;
    changedPath: string;
    affectedDir: string;
    eventType: string;
  }) => void) | null;
  let watchFile: ReturnType<typeof vi.fn>;
  let unwatchFile: ReturnType<typeof vi.fn>;
  let watchWorkspace: ReturnType<typeof vi.fn>;
  let unwatchWorkspace: ReturnType<typeof vi.fn>;
  let localStorageData: Record<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorageData = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => localStorageData[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStorageData[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete localStorageData[key];
      }),
      clear: vi.fn(() => {
        localStorageData = {};
      }),
    });
    emitWorkspaceChanged = null;
    watchFile = vi.fn(async () => true);
    unwatchFile = vi.fn(async () => true);
    watchWorkspace = vi.fn(async () => true);
    unwatchWorkspace = vi.fn(async () => true);
    window.t = ((key: string) => key === 'desk.workspaceTitle' ? '工作台' : key) as typeof window.t;
    window.platform = {
      watchFile,
      unwatchFile,
      onFileChanged: vi.fn(),
      watchWorkspace,
      unwatchWorkspace,
      onWorkspaceChanged: vi.fn((callback: (event: {
        rootPath: string;
        changedPath: string;
        affectedDir: string;
        eventType: string;
      }) => void) => {
        emitWorkspaceChanged = callback;
      }),
      startDrag: vi.fn(),
      trashItem: vi.fn(async () => true),
    } as unknown as typeof window.platform;
    window.confirm = vi.fn(() => true);
    useStore.setState({
      serverPort: 62950,
      deskBasePath: '/tmp/hana-desk',
      deskCurrentPath: 'notes',
      deskFiles: [],
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [],
      },
      deskExpandedPaths: ['notes'],
      deskSelectedPath: '',
      deskJianContent: null,
      currentTab: 'chat',
      jianOpen: true,
      jianView: 'desk',
      deskDirtyTreePaths: [],
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('watches the workspace root plus expanded folders and reloads visible dirty tree keys from workspace events', async () => {
    const { DeskSection } = await import('../../components/DeskSection');
    const { WorkspaceFileWatchBridge } = await import('../../components/right-workspace/WorkspaceFileWatchBridge');

    render(
      <>
        <WorkspaceFileWatchBridge />
        <DeskSection />
      </>,
    );

    expect(watchWorkspace).toHaveBeenCalledWith('/tmp/hana-desk');
    expect(watchWorkspace).toHaveBeenCalledWith('/tmp/hana-desk/notes');
    mocks.loadDeskTreeFiles.mockClear();

    await act(async () => {
      emitWorkspaceChanged?.({
        rootPath: '/tmp/hana-desk/notes',
        changedPath: '/tmp/hana-desk/notes/new.md',
        affectedDir: '/tmp/hana-desk/notes',
        eventType: 'add',
      });
    });

    expect(mocks.loadDeskTreeFiles).toHaveBeenCalledWith('notes', { force: true });
  });

  it('debounces expanded folder watcher changes and clears watchers when the workspace is removed', async () => {
    const { WorkspaceFileWatchBridge } = await import('../../components/right-workspace/WorkspaceFileWatchBridge');

    render(<WorkspaceFileWatchBridge />);

    expect(watchWorkspace).toHaveBeenCalledWith('/tmp/hana-desk');
    expect(watchWorkspace).toHaveBeenCalledWith('/tmp/hana-desk/notes');

    await act(async () => {
      useStore.setState({ deskExpandedPaths: [] } as never);
    });

    expect(unwatchWorkspace).not.toHaveBeenCalledWith('/tmp/hana-desk/notes');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(160);
    });

    expect(unwatchWorkspace).toHaveBeenCalledWith('/tmp/hana-desk/notes');
    unwatchWorkspace.mockClear();

    await act(async () => {
      useStore.setState({ deskBasePath: '' } as never);
    });

    expect(unwatchWorkspace).toHaveBeenCalledWith('/tmp/hana-desk');
  });

  it('flushes dirty expanded tree paths when the workspace tree mounts', async () => {
    const { DeskSection } = await import('../../components/DeskSection');
    useStore.setState({
      deskDirtyTreePaths: ['notes'],
      deskExpandedPaths: ['notes'],
    } as never);

    render(<DeskSection />);

    expect(mocks.loadDeskTreeFiles).toHaveBeenCalledWith('notes', { force: true });
    expect(useStore.getState().deskDirtyTreePaths).toEqual([]);
  });

  it('renders a single-column tree and expands folders by explicit subdir', async () => {
    useStore.setState({
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [
          { name: 'notes', isDir: true },
          { name: 'root.md', isDir: false },
        ],
      },
      deskExpandedPaths: [],
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');

    render(<DeskSection />);

    expect(screen.getByRole('tree')).toBeTruthy();
    fireEvent.click(screen.getByRole('treeitem', { name: /notes/ }));

    expect(mocks.loadDeskTreeFiles).toHaveBeenCalledWith('notes');
    expect(useStore.getState().deskExpandedPaths).toEqual(['notes']);

    act(() => {
      useStore.setState({
        deskTreeFilesByPath: {
          '': [
            { name: 'notes', isDir: true },
            { name: 'root.md', isDir: false },
          ],
          notes: [{ name: 'chapter.md', isDir: false }],
        },
      } as never);
    });

    expect(screen.getByText('chapter.md')).toBeTruthy();
  });

  it('shows cached folder children immediately and refreshes them in the background', async () => {
    useStore.setState({
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [{ name: 'old.md', isDir: false }],
      },
      deskExpandedPaths: [],
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');

    render(<DeskSection />);
    mocks.loadDeskTreeFiles.mockClear();

    fireEvent.click(screen.getByRole('treeitem', { name: /notes/ }));

    expect(screen.getByText('old.md')).toBeTruthy();
    expect(mocks.loadDeskTreeFiles).not.toHaveBeenCalledWith('notes', { force: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(mocks.loadDeskTreeFiles).toHaveBeenCalledWith('notes', { force: true });
  });

  it('matches Windows workspace watch events case-insensitively', async () => {
    const { DeskSection } = await import('../../components/DeskSection');
    const { WorkspaceFileWatchBridge } = await import('../../components/right-workspace/WorkspaceFileWatchBridge');

    useStore.setState({
      deskBasePath: 'C:\\Users\\me\\Desk',
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'Notes', isDir: true }],
        Notes: [],
      },
      deskExpandedPaths: ['Notes'],
      deskDirtyTreePaths: [],
    } as never);

    render(
      <>
        <WorkspaceFileWatchBridge />
        <DeskSection />
      </>,
    );
    mocks.loadDeskTreeFiles.mockClear();

    await act(async () => {
      emitWorkspaceChanged?.({
        rootPath: 'c:\\users\\me\\desk\\notes',
        changedPath: 'c:\\users\\me\\desk\\notes\\new.md',
        affectedDir: 'c:\\users\\me\\desk\\notes',
        eventType: 'add',
      });
    });

    expect(mocks.loadDeskTreeFiles).toHaveBeenCalledWith('Notes', { force: true });
  });

  it('starts an app file drag from tree rows so workspace files can be moved or attached', async () => {
    useStore.setState({
      deskCurrentPath: 'drafts',
      deskTreeFilesByPath: {
        '': [
          { name: 'notes', isDir: true },
          { name: 'root.md', isDir: false },
        ],
      },
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');
    const { getActiveAppFileDragPayload } = await import('../../utils/app-file-drag');

    render(<DeskSection />);

    const rootFile = screen.getByRole('treeitem', { name: /root.md/ });
    fireEvent.dragStart(rootFile);

    expect(window.platform?.startDrag).toHaveBeenCalledWith('/tmp/hana-desk/root.md');
    expect(getActiveAppFileDragPayload()).toEqual(expect.objectContaining({
      source: 'workspace',
      files: [{
        id: 'workspace:root.md',
        name: 'root.md',
        path: '/tmp/hana-desk/root.md',
        sourceSubdir: '',
        isDirectory: false,
      }],
    }));
  });

  it('does not move a nested file to the workspace root when dropped back on its own row', async () => {
    useStore.setState({
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [{ name: 'chapter.md', isDir: false }],
      },
      deskExpandedPaths: ['notes'],
      deskSelectedPath: '',
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');
    const { clearAppFileDragPayload } = await import('../../utils/app-file-drag');

    render(<DeskSection />);

    const chapter = screen.getByRole('treeitem', { name: /chapter.md/ });
    fireEvent.dragStart(chapter);
    fireEvent.drop(chapter);

    expect(mocks.deskMoveTreeFiles).not.toHaveBeenCalled();
    clearAppFileDragPayload();
  });

  it('uses shift ranges and command/control additive selection when dragging tree rows', async () => {
    useStore.setState({
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [
          { name: 'a.md', isDir: false },
          { name: 'b.md', isDir: false },
          { name: 'c.md', isDir: false },
          { name: 'd.md', isDir: false },
        ],
      },
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');
    const { clearAppFileDragPayload, getActiveAppFileDragPayload } = await import('../../utils/app-file-drag');

    render(<DeskSection />);

    fireEvent.click(screen.getByRole('treeitem', { name: /a.md/ }));
    fireEvent.click(screen.getByRole('treeitem', { name: /c.md/ }), { shiftKey: true });
    fireEvent.click(screen.getByRole('treeitem', { name: /d.md/ }), { ctrlKey: true });
    fireEvent.click(screen.getByRole('treeitem', { name: /b.md/ }), { metaKey: true });
    fireEvent.dragStart(screen.getByRole('treeitem', { name: /c.md/ }));

    expect(getActiveAppFileDragPayload()?.files.map(file => file.name)).toEqual(['a.md', 'c.md', 'd.md']);
    expect(window.platform?.startDrag).toHaveBeenCalledWith([
      '/tmp/hana-desk/a.md',
      '/tmp/hana-desk/c.md',
      '/tmp/hana-desk/d.md',
    ]);
    clearAppFileDragPayload();
  });

  it('renames a tree item from the context menu', async () => {
    useStore.setState({
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [{ name: 'chapter.md', isDir: false }],
      },
      deskExpandedPaths: ['notes'],
      deskSelectedPath: '',
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');

    render(<DeskSection />);

    const chapter = screen.getByRole('treeitem', { name: /chapter.md/ });
    fireEvent.contextMenu(chapter, { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByText('desk.ctx.rename'));
    const input = screen.getByDisplayValue('chapter.md');
    fireEvent.change(input, { target: { value: 'renamed.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mocks.deskRenameTreeItem).toHaveBeenCalledWith('notes', 'chapter.md', 'renamed.md', false);
  });

  it('starts a markdown create draft from blank workspace space and writes only after naming', async () => {
    useStore.setState({
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
      },
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');

    render(<DeskSection />);

    fireEvent.contextMenu(screen.getByRole('tree'), { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByText('desk.ctx.newMdFile'));

    expect(mocks.deskCreateFileInSubdir).not.toHaveBeenCalled();

    const input = pendingCreateInput();
    fireEvent.change(input, { target: { value: 'idea.md' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
    });

    expect(mocks.deskCreateFileInSubdir).toHaveBeenCalledWith('', 'idea.md', '');
    expect(useStore.getState().deskSelectedPath).toBe('idea.md');
  });

  it('cancels a folder create draft with a blank name instead of writing to disk', async () => {
    useStore.setState({
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [],
      },
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');

    render(<DeskSection />);

    fireEvent.contextMenu(screen.getByRole('tree'), { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByText('desk.ctx.newFolder'));

    const input = pendingCreateInput();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mocks.deskMkdirInSubdir).not.toHaveBeenCalled();
    expect(document.querySelector('[data-desk-pending-create] input')).toBeNull();
  });

  it('creates a markdown draft inside a folder from that folder context menu', async () => {
    useStore.setState({
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [{ name: 'old.md', isDir: false }],
      },
      deskExpandedPaths: ['notes'],
      deskSelectedPath: '',
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');

    render(<DeskSection />);

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: /notes/ }), { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByText('desk.ctx.newMdFile'));

    const input = pendingCreateInput();
    fireEvent.change(input, { target: { value: 'child.md' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
    });

    expect(mocks.deskCreateFileInSubdir).toHaveBeenCalledWith('notes', 'child.md', '');
    expect(useStore.getState().deskSelectedPath).toBe('notes/child.md');
  });

  it('expands a collapsed folder before creating a child draft inside it', async () => {
    useStore.setState({
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
      },
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');

    render(<DeskSection />);

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: /notes/ }), { clientX: 10, clientY: 20 });
    await act(async () => {
      fireEvent.click(screen.getByText('desk.ctx.newFolder'));
      await Promise.resolve();
    });

    expect(useStore.getState().deskExpandedPaths).toEqual(['notes']);
    expect(mocks.loadDeskTreeFiles).toHaveBeenCalledWith('notes');

    const input = pendingCreateInput();
    fireEvent.change(input, { target: { value: 'drafts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mocks.deskMkdirInSubdir).toHaveBeenCalledWith('notes', 'drafts');
  });

  it('starts inline rename for the selected tree item when Enter is pressed', async () => {
    useStore.setState({
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'chapter.md', isDir: false }],
      },
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');

    render(<DeskSection />);

    const chapter = screen.getByRole('treeitem', { name: /chapter.md/ });
    fireEvent.click(chapter);
    fireEvent.keyDown(chapter, { key: 'Enter' });

    expect(screen.getByDisplayValue('chapter.md')).toBeTruthy();
  });

  it('clears the highlighted tree item when clicking blank tree space', async () => {
    useStore.setState({
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [
          { name: 'chapter.md', isDir: false },
          { name: 'draft.md', isDir: false },
        ],
      },
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');

    render(<DeskSection />);

    const chapter = screen.getByRole('treeitem', { name: /chapter.md/ });
    fireEvent.click(chapter);
    expect(chapter.getAttribute('data-selected')).toBe('true');

    fireEvent.click(screen.getByRole('tree'));

    expect(chapter.getAttribute('data-selected')).toBe('false');
    expect(useStore.getState().deskSelectedPath).toBe('');
  });

  it('sends context-menu deletes through the system trash action', async () => {
    useStore.setState({
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [{ name: 'chapter.md', isDir: false }],
      },
      deskExpandedPaths: ['notes'],
      deskSelectedPath: '',
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');

    render(<DeskSection />);

    const chapter = screen.getByRole('treeitem', { name: /chapter.md/ });
    fireEvent.contextMenu(chapter, { clientX: 10, clientY: 20 });
    fireEvent.click(screen.getByText('desk.ctx.delete'));

    expect(window.confirm).toHaveBeenCalled();
    expect(mocks.deskTrashTreeItems).toHaveBeenCalledWith([
      { sourceSubdir: 'notes', name: 'chapter.md', isDirectory: false },
    ]);
  });

  it('filters workspace tree files by checked file types while keeping folders navigable', async () => {
    useStore.setState({
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [
          { name: 'notes', isDir: true },
          { name: 'photo.png', isDir: false },
          { name: 'story.md', isDir: false },
          { name: 'clip.mp4', isDir: false },
        ],
      },
      deskExpandedPaths: [],
    } as never);
    const { DeskSection } = await import('../../components/DeskSection');

    render(<DeskSection />);

    fireEvent.click(screen.getByRole('button', { name: 'desk.filter.label' }));
    fireEvent.click(screen.getByText('desk.filter.images'));

    expect(screen.getByRole('treeitem', { name: /notes/ })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: /photo.png/ })).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: /story.md/ })).toBeNull();
    expect(screen.queryByRole('treeitem', { name: /clip.mp4/ })).toBeNull();
  });

  it('searches workspace files and jumps to the selected result', async () => {
    mocks.searchDeskFiles.mockResolvedValueOnce([
      { name: 'DeskTree.tsx', relativePath: 'src/DeskTree.tsx', parentSubdir: 'src', isDir: false },
    ]);
    const { DeskSection } = await import('../../components/DeskSection');

    render(<DeskSection />);

    fireEvent.change(screen.getByPlaceholderText('desk.search.placeholder'), { target: { value: 'Desk' } });
    act(() => {
      vi.advanceTimersByTime(220);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByText('DeskTree.tsx'));

    expect(mocks.searchDeskFiles).toHaveBeenCalledWith('Desk');
    expect(mocks.jumpToDeskSearchResult).toHaveBeenCalledWith({
      name: 'DeskTree.tsx',
      relativePath: 'src/DeskTree.tsx',
      parentSubdir: 'src',
      isDir: false,
    });
  });

  it('marks the right workspace card with the Jian drawer state for overlay layout', async () => {
    useStore.setState({ jianDrawerOpen: true } as never);
    const { RightWorkspacePanel } = await import('../../components/right-workspace/RightWorkspacePanel');

    render(<RightWorkspacePanel />);

    expect(document.querySelector('[data-right-workspace-card]')?.getAttribute('data-jian-open')).toBe('true');
  });

  it('uses the visible workspace root name as the sidebar title', async () => {
    const { DeskSection } = await import('../../components/DeskSection');

    render(<DeskSection />);

    expect(screen.getByText('工作台 · hana-desk')).toBeTruthy();

    act(() => {
      useStore.setState({ deskBasePath: '/workspace/Desktop', deskCurrentPath: '' } as never);
    });

    expect(screen.getByText('工作台 · Desktop')).toBeTruthy();
  });

  it('keeps dirty workspace paths until their tree directory becomes visible', async () => {
    const { DeskSection } = await import('../../components/DeskSection');

    useStore.setState({
      deskDirtyTreePaths: ['archive'],
      deskTreeFilesByPath: {
        '': [
          { name: 'notes', isDir: true },
          { name: 'archive', isDir: true },
        ],
        notes: [],
      },
      deskExpandedPaths: ['notes'],
    } as never);
    render(<DeskSection />);
    mocks.loadDeskTreeFiles.mockClear();

    await act(async () => {
      useStore.setState({
        deskExpandedPaths: ['notes', 'archive'],
      } as never);
    });

    expect(mocks.loadDeskTreeFiles).toHaveBeenCalledWith('archive', { force: true });
    expect(useStore.getState().deskDirtyTreePaths).toEqual([]);
  });
});
