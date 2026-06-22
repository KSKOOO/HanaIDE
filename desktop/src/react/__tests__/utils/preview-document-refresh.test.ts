import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore, type StoreState } from '../../stores';
import type { PreviewItem, RemoteWorkbenchContentRef } from '../../types';

const mocks = vi.hoisted(() => ({
  refreshPreviewItemsFromFile: vi.fn(async () => undefined),
  refreshPreviewItemsFromRemoteWorkbenchTarget: vi.fn(async () => undefined),
}));

vi.mock('../../utils/preview-file-refresh', () => ({
  PREVIEW_FILE_CHANGE_REFRESH_OPTIONS: Object.freeze({
    retryMissing: true,
    retryUnchanged: true,
  }),
  PREVIEW_FILE_CATCH_UP_REFRESH_OPTIONS: Object.freeze({
    retryMissing: true,
  }),
  refreshPreviewItemsFromFile: mocks.refreshPreviewItemsFromFile,
}));

vi.mock('../../utils/remote-file-preview', () => ({
  isRemoteWorkbenchContentRef: (value: unknown) => {
    if (!value || typeof value !== 'object') return false;
    const ref = value as Record<string, unknown>;
    return (ref.kind === 'workbench-file' || ref.kind === 'mobile-workbench')
      && (typeof ref.mountId === 'string' || typeof ref.rootId === 'string')
      && typeof ref.subdir === 'string'
      && typeof ref.name === 'string';
  },
  normalizeWorkbenchContentRef: (ref: RemoteWorkbenchContentRef) => {
    const mountId = ref.mountId || ref.rootId || 'default';
    return {
      ...ref,
      kind: 'workbench-file',
      mountId,
      rootId: ref.rootId || mountId,
      subdir: ref.subdir || '',
    };
  },
  refreshPreviewItemsFromRemoteWorkbenchTarget: mocks.refreshPreviewItemsFromRemoteWorkbenchTarget,
}));

function localItem(id: string, filePath: string): PreviewItem {
  return {
    id,
    type: 'markdown',
    title: `${id}.md`,
    content: '# Demo',
    filePath,
  };
}

function remoteRef(name: string, mountId = 'mount_docs'): RemoteWorkbenchContentRef {
  return {
    kind: 'workbench-file',
    mountId,
    subdir: 'notes',
    name,
    contentPath: `/api/workbench/content?mountId=${mountId}&subdir=notes&name=${name}`,
  };
}

function remoteItem(id: string, ref: RemoteWorkbenchContentRef): PreviewItem {
  return {
    id,
    type: 'markdown',
    title: ref.name,
    content: '# Remote',
    storageKind: 'remote-content',
    remoteContentRef: ref,
  };
}

describe('preview document refresh', () => {
  beforeEach(() => {
    mocks.refreshPreviewItemsFromFile.mockClear();
    mocks.refreshPreviewItemsFromRemoteWorkbenchTarget.mockClear();
    useStore.setState({
      previewItems: [],
      openTabs: [],
      deskBasePath: '',
      deskWorkspaceMountId: null,
    } as Partial<StoreState>);
  });

  it('routes local and remote document targets through the same refresh contract', async () => {
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshPreviewDocumentTarget,
    } = await import('../../utils/preview-document-refresh');
    const target = remoteRef('remote.md');

    await refreshPreviewDocumentTarget({ kind: 'local-file', filePath: '/tmp/note.md' });
    await refreshPreviewDocumentTarget({ kind: 'workbench-file', target });

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/tmp/note.md',
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      target,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('refreshes only open preview documents across local files and remote workbench targets', async () => {
    const sharedRemote = remoteRef('remote.md');
    useStore.setState({
      previewItems: [
        localItem('open-local', '/tmp/open.md'),
        localItem('duplicate-local', '/tmp/open.md'),
        localItem('closed-local', '/tmp/closed.md'),
        remoteItem('open-remote', sharedRemote),
        remoteItem('duplicate-remote', { ...sharedRemote, rootId: sharedRemote.mountId }),
        remoteItem('closed-remote', remoteRef('closed.md')),
      ],
      openTabs: ['open-local', 'duplicate-local', 'open-remote', 'duplicate-remote'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
      refreshOpenPreviewDocuments,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocuments();

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/tmp/open.md',
      PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
    );
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      sharedRemote,
      PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
    );
  });

  it('falls back to open preview documents when a change target does not match an open preview identity', async () => {
    const openRemote = remoteRef('open.md');
    useStore.setState({
      previewItems: [
        remoteItem('open-remote', openRemote),
      ],
      openTabs: ['open-remote'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshPreviewDocumentTarget,
    } = await import('../../utils/preview-document-refresh');

    await refreshPreviewDocumentTarget({ kind: 'local-file', filePath: '/tmp/open.md' });

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/tmp/open.md',
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      openRemote,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('does not fall back when the target already matches an open preview document', async () => {
    useStore.setState({
      previewItems: [
        localItem('open-local', '/tmp/open.md'),
        remoteItem('other-remote', remoteRef('other.md')),
      ],
      openTabs: ['open-local', 'other-remote'],
    } as Partial<StoreState>);
    const { refreshPreviewDocumentTarget } = await import('../../utils/preview-document-refresh');

    await refreshPreviewDocumentTarget({ kind: 'local-file', filePath: '/tmp/open.md' });

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).not.toHaveBeenCalled();
  });

  it('refreshes matching open preview documents for an external workspace file change', async () => {
    const openRemote = remoteRef('note.md', 'default');
    useStore.setState({
      deskBasePath: '/workspace',
      previewItems: [
        localItem('open-local', '/workspace/notes/local.md'),
        remoteItem('open-remote', openRemote),
        remoteItem('unrelated-remote', remoteRef('other.md', 'default')),
      ],
      openTabs: ['open-local', 'open-remote', 'unrelated-remote'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForFilePath,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocumentsForFilePath('/workspace/notes/note.md');

    expect(mocks.refreshPreviewItemsFromFile).not.toHaveBeenCalled();
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      openRemote,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('matches mounted workbench preview documents through the native root file path', async () => {
    const openRemote = remoteRef('note.md', 'mount_docs');
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceNativeRoot: '/Users/me/Documents',
      previewItems: [
        remoteItem('open-remote', openRemote),
      ],
      openTabs: ['open-remote'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForFilePath,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocumentsForFilePath('/Users/me/Documents/notes/note.md');

    expect(mocks.refreshPreviewItemsFromFile).not.toHaveBeenCalled();
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      openRemote,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });
});
