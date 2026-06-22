import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../stores';
import { watchFileChanges } from '../../services/file-change-events';
import {
  PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
  PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
  openPreviewDocumentWatchFilePaths,
  refreshOpenPreviewDocumentsForFilePath,
} from '../../utils/preview-document-refresh';

function refreshWatchFilePath(filePath: string, options: typeof PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS): void {
  void refreshOpenPreviewDocumentsForFilePath(filePath, options).catch((err) => {
    console.warn('[preview-watch] refresh failed:', filePath, err);
  });
}

export function OpenPreviewDocumentWatchBridge() {
  const previewItems = useStore(s => s.previewItems);
  const openTabs = useStore(s => s.openTabs);
  const deskBasePath = useStore(s => s.deskBasePath);
  const deskWorkspaceMountId = useStore(s => s.deskWorkspaceMountId);
  const deskWorkspaceNativeRoot = useStore(s => s.deskWorkspaceNativeRoot);
  const subscriptionsRef = useRef<Map<string, () => void>>(new Map());
  const watchPaths = useMemo(
    () => openPreviewDocumentWatchFilePaths(),
    [previewItems, openTabs, deskBasePath, deskWorkspaceMountId, deskWorkspaceNativeRoot],
  );
  const watchPathsKey = watchPaths.join('\n');

  useEffect(() => {
    const nextPaths = new Set(watchPaths);
    for (const [filePath, unsubscribe] of subscriptionsRef.current) {
      if (nextPaths.has(filePath)) continue;
      unsubscribe();
      subscriptionsRef.current.delete(filePath);
    }

    for (const filePath of watchPaths) {
      if (subscriptionsRef.current.has(filePath)) continue;
      const unsubscribe = watchFileChanges(filePath, (changedPath) => {
        refreshWatchFilePath(
          changedPath,
          PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
        );
      });
      subscriptionsRef.current.set(filePath, unsubscribe);
      refreshWatchFilePath(
        filePath,
        PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
      );
    }
  }, [watchPathsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- watchPathsKey is the reconciled subscription identity.

  useEffect(() => () => {
    for (const unsubscribe of subscriptionsRef.current.values()) unsubscribe();
    subscriptionsRef.current.clear();
  }, []);

  return null;
}
