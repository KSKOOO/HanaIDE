import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore, type StoreState } from '../../stores';

const mockHanaFetch = vi.fn();

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: mockHanaFetch,
}));

describe('remote file preview workbench refs', () => {
  beforeEach(() => {
    useStore.setState({
      previewItems: [],
      openTabs: [],
    } as Partial<StoreState>);
    mockHanaFetch.mockReset();
    mockHanaFetch.mockResolvedValue({
      json: async () => ({ ok: true, version: { mtimeMs: 1, size: 4 } }),
    });
  });

  it('saves remote workbench content by mountId instead of producing a legacy rootId-only request', async () => {
    const { saveRemoteWorkbenchContent } = await import('../../utils/remote-file-preview');

    await saveRemoteWorkbenchContent({
      kind: 'workbench-file',
      mountId: 'mount_docs',
      subdir: 'notes',
      name: 'remote.md',
      contentPath: '/api/workbench/content?mountId=mount_docs&subdir=notes&name=remote.md',
    } as any, 'body');

    expect(mockHanaFetch).toHaveBeenCalledWith(
      '/api/workbench/actions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'writeText',
          mountId: 'mount_docs',
          subdir: 'notes',
          name: 'remote.md',
          content: 'body',
          expectedVersion: null,
        }),
      }),
    );
    expect(String(mockHanaFetch.mock.calls[0][1].body)).not.toContain('"rootId"');
  });

  it('retries remote workbench refresh when the first cache-busted read is unchanged', async () => {
    const { refreshPreviewItemsFromRemoteWorkbenchTarget } = await import('../../utils/remote-file-preview');
    const target = {
      kind: 'workbench-file',
      mountId: 'mount_docs',
      subdir: 'notes',
      name: 'remote.md',
      contentPath: '/api/workbench/content?mountId=mount_docs&subdir=notes&name=remote.md',
      version: { mtimeMs: 2, size: 8 },
    } as any;
    useStore.setState({
      previewItems: [{
        id: 'remote-note',
        type: 'markdown',
        title: 'remote.md',
        content: 'old',
        storageKind: 'remote-content',
        remoteContentRef: {
          ...target,
          version: { mtimeMs: 1, size: 3 },
        },
      }],
    } as Partial<StoreState>);
    mockHanaFetch
      .mockResolvedValueOnce(new Response('old', { status: 200 }))
      .mockResolvedValueOnce(new Response('new', { status: 200 }));

    await refreshPreviewItemsFromRemoteWorkbenchTarget(target, {
      retryUnchanged: true,
      retryDelaysMs: [0],
    });

    const item = useStore.getState().previewItems[0];
    expect(mockHanaFetch).toHaveBeenCalledTimes(2);
    expect(item.content).toBe('new');
    expect(item.fileVersion).toEqual({ mtimeMs: 2, size: 8 });
    expect(item.remoteContentRef?.version).toEqual({ mtimeMs: 2, size: 8 });
  });
});
