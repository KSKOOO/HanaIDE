import type {
  FileVersion,
  PreviewItem,
  RemoteWorkbenchContentRef,
  VersionedWriteResult,
} from '../types';
import type { DeskFile } from '../types';
import type { FileRef } from '../types/file-ref';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { openPreview, upsertPreviewItem } from '../stores/preview-actions';
import { useStore } from '../stores';
import { resolveServerConnection } from '../services/server-connection';
import { resolveFileRefUrl } from '../services/resource-url';
import { BINARY_PREVIEW_TYPES, PREVIEWABLE_EXTS, openFilePreview } from './file-preview';
import { extOfName, inferKindByExt, isMediaKind } from './file-kind';
import { openMediaViewerForRef } from './open-media-viewer';
import { showError } from './ui-helpers';
import { isWebRuntime } from './platform-runtime';

export { isWebRuntime };

export interface WorkbenchPreviewInput {
  file: DeskFile;
  mountId?: string;
  rootId?: string;
  subdir: string;
}

export interface FileRefPreviewContext {
  origin: 'desk' | 'session';
  sessionPath?: string;
  messageId?: string;
  blockIdx?: number;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function encodeWorkbenchContentPath({
  mountId = 'default',
  rootId,
  subdir,
  name,
}: {
  mountId?: string;
  rootId?: string;
  subdir: string;
  name: string;
}): string {
  const params = new URLSearchParams();
  params.set('mountId', mountId || rootId || 'default');
  params.set('subdir', subdir || '');
  params.set('name', name);
  return `/api/workbench/content?${params.toString()}`;
}

export function isRemoteWorkbenchContentRef(value: unknown): value is RemoteWorkbenchContentRef {
  if (!isRecord(value)) return false;
  return (value.kind === 'workbench-file' || value.kind === 'mobile-workbench')
    && (typeof value.mountId === 'string' || typeof value.rootId === 'string')
    && typeof value.subdir === 'string'
    && typeof value.name === 'string';
}

export function normalizeWorkbenchContentRef(ref: RemoteWorkbenchContentRef): RemoteWorkbenchContentRef {
  const mountId = ref.mountId || ref.rootId || 'default';
  return {
    ...ref,
    kind: 'workbench-file',
    mountId,
    rootId: ref.rootId || mountId,
    subdir: ref.subdir || '',
    name: ref.name,
  };
}

function previewId(prefix: string, key: string): string {
  return `${prefix}-${encodeURIComponent(key)}`;
}

function versionFromDeskFile(file: DeskFile): FileRef['version'] | undefined {
  const mtimeMs = typeof file.mtime === 'string' ? Date.parse(file.mtime) : NaN;
  if (!Number.isFinite(mtimeMs) || typeof file.size !== 'number') return undefined;
  return { mtimeMs, size: file.size };
}

function versionToken(version: FileRef['version']): string | null {
  if (!version || typeof version.mtimeMs !== 'number' || typeof version.size !== 'number') return null;
  if (!Number.isFinite(version.mtimeMs) || !Number.isFinite(version.size)) return null;
  return [String(version.mtimeMs), String(version.size), version.sha256].filter(Boolean).join('-');
}

function appendVersionQuery(path: string, version: FileRef['version']): string {
  const token = versionToken(version);
  if (!token) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}v=${encodeURIComponent(token)}`;
}

function appendCacheBustQuery(path: string, attempt: number): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}v=${encodeURIComponent(`${Date.now()}-${attempt}`)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeFileVersion(value: unknown): FileVersion | null {
  if (!isRecord(value)) return null;
  const mtimeMs = Number(value.mtimeMs);
  const size = Number(value.size);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) return null;
  return {
    mtimeMs,
    size,
    sha256: typeof value.sha256 === 'string' ? value.sha256 : undefined,
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function readContentForPreview(contentPath: string, previewType: string): Promise<string> {
  const res = await hanaFetch(contentPath);
  if (BINARY_PREVIEW_TYPES.has(previewType)) {
    return blobToBase64(await res.blob());
  }
  return res.text();
}

const REMOTE_REFRESH_RETRY_DELAYS_MS = [80, 240, 600] as const;

export interface RemoteWorkbenchRefreshOptions {
  retryMissing?: boolean;
  retryUnchanged?: boolean;
  retryDelaysMs?: readonly number[];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

async function readRemotePreviewContentWithRetry(
  contentPath: string,
  item: PreviewItem,
  options: RemoteWorkbenchRefreshOptions,
): Promise<string> {
  const retryDelaysMs = options.retryDelaysMs ?? REMOTE_REFRESH_RETRY_DELAYS_MS;
  let lastContent = '';
  for (let attempt = 0; ; attempt += 1) {
    const nextContent = await readContentForPreview(appendCacheBustQuery(contentPath, attempt), item.type);
    const canRetry = attempt < retryDelaysMs.length;
    const shouldRetryUnchanged = options.retryUnchanged && nextContent === item.content;
    if (!canRetry || !shouldRetryUnchanged) return nextContent;
    lastContent = nextContent;
    await delay(retryDelaysMs[attempt] ?? 0);
  }
  return lastContent;
}

async function openRemoteContentPreview({
  contentPath,
  id,
  title,
  ext,
  mediaRef,
  mediaContext,
  remoteContentRef,
}: {
  contentPath: string;
  id: string;
  title: string;
  ext: string;
  mediaRef?: FileRef;
  mediaContext: { origin: 'desk' | 'session'; sessionPath?: string };
  remoteContentRef?: RemoteWorkbenchContentRef;
}): Promise<void> {
  const mediaKind = inferKindByExt(ext);
  if (isMediaKind(mediaKind) && mediaRef) {
    openMediaViewerForRef(mediaRef, mediaContext);
    return;
  }

  const previewType = PREVIEWABLE_EXTS[ext];
  if (previewType && previewType !== 'docx' && previewType !== 'xlsx') {
    const content = await readContentForPreview(contentPath, previewType);
    const previewItem: PreviewItem = {
      id,
      type: previewType,
      title,
      content,
      ext,
      language: previewType === 'code' ? ext : undefined,
      storageKind: 'remote-content',
      fileVersion: remoteContentRef?.version ?? undefined,
      remoteContentRef,
    };
    openPreview(previewItem);
    return;
  }

  openPreview({
    id,
    type: 'file-info',
    title,
    content: '',
    ext,
    storageKind: 'remote-content',
    remoteContentRef,
  });
}

export async function saveRemoteWorkbenchContent(
  ref: RemoteWorkbenchContentRef,
  content: string,
  expectedVersion?: FileVersion | null,
): Promise<VersionedWriteResult> {
  const normalized = normalizeWorkbenchContentRef(ref);
  const res = await hanaFetch('/api/workbench/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'writeText',
      mountId: normalized.mountId || 'default',
      subdir: normalized.subdir || '',
      name: normalized.name,
      content,
      expectedVersion: expectedVersion ?? null,
    }),
  });
  const data: unknown = await res.json();
  if (!isRecord(data)) throw new Error('invalid remote write response');
  return {
    ok: data.ok === true,
    conflict: data.conflict === true,
    version: normalizeFileVersion(data.version),
  };
}

function refsPointToSameWorkbenchFile(
  left: RemoteWorkbenchContentRef | null | undefined,
  right: RemoteWorkbenchContentRef,
): boolean {
  if (!isRemoteWorkbenchContentRef(left)) return false;
  const normalizedLeft = normalizeWorkbenchContentRef(left);
  const normalizedRight = normalizeWorkbenchContentRef(right);
  return (normalizedLeft.mountId || 'default') === (normalizedRight.mountId || 'default')
    && (normalizedLeft.subdir || '') === (normalizedRight.subdir || '')
    && normalizedLeft.name === normalizedRight.name;
}

export async function refreshPreviewItemsFromRemoteWorkbenchTarget(
  target: RemoteWorkbenchContentRef,
  options: RemoteWorkbenchRefreshOptions = {},
): Promise<void> {
  const normalized = normalizeWorkbenchContentRef(target);
  const state = useStore.getState();
  const matching = (state.previewItems || []).filter(item =>
    refsPointToSameWorkbenchFile(item.remoteContentRef, normalized));
  for (const item of matching) {
    const contentPath = item.remoteContentRef?.contentPath || encodeWorkbenchContentPath(normalized);
    const content = await readRemotePreviewContentWithRetry(contentPath, item, options);
    const nextVersion = normalized.version ?? item.remoteContentRef?.version ?? item.fileVersion;
    const remoteContentRef = item.remoteContentRef
      ? {
          ...item.remoteContentRef,
          version: nextVersion,
        }
      : item.remoteContentRef;
    upsertPreviewItem({
      ...item,
      content,
      fileVersion: nextVersion,
      remoteContentRef,
      status: 'available',
      missingAt: null,
    });
  }
}

export async function openMobileWorkbenchPreview(input: WorkbenchPreviewInput): Promise<void> {
  if (input.file.isDir) return;
  const name = input.file.name;
  const ext = extOfName(name) || '';
  const mountId = input.mountId || input.rootId || 'default';
  const contentPath = encodeWorkbenchContentPath({ mountId, subdir: input.subdir, name });
  const version = versionFromDeskFile(input.file);
  const versionedContentPath = appendVersionQuery(contentPath, version);
  const connection = resolveServerConnection(useStore.getState());
  const studioId = connection?.studioId || 'default';
  const mediaKind = inferKindByExt(ext);
  const mediaRef: FileRef | undefined = isMediaKind(mediaKind)
    ? {
        id: `workbench:${mountId}:${input.subdir}:${name}`,
        kind: mediaKind,
        source: 'desk',
        name,
        path: '',
        ext,
        version,
        resource: {
          resourceId: `workbench:${mountId}:${input.subdir}:${name}`,
          studioId,
          links: { self: contentPath, content: contentPath },
        },
      }
    : undefined;

  try {
    await openRemoteContentPreview({
      contentPath: versionedContentPath,
      id: previewId('workbench', `${mountId}:${input.subdir}:${name}`),
      title: name,
      ext,
      mediaRef,
      mediaContext: { origin: 'desk' },
      remoteContentRef: {
        kind: 'workbench-file',
        mountId,
        rootId: input.rootId || mountId,
        subdir: input.subdir || '',
        name,
        contentPath,
        version: version ?? null,
      },
    });
  } catch (err) {
    console.error('[remote-preview] workbench preview failed:', err);
    showError(getErrorMessage(err));
  }
}

export async function openFileRefPreview(file: FileRef, context: FileRefPreviewContext): Promise<void> {
  if (file.status === 'expired') return;
  if (isMediaKind(file.kind)) {
    openMediaViewerForRef(file, {
      origin: context.origin,
      sessionPath: context.sessionPath,
    });
    return;
  }

  if (!isWebRuntime() && file.path) {
    await openFilePreview(file.path, file.name, file.ext || extOfName(file.name) || '', {
      origin: context.origin,
      sessionPath: context.sessionPath,
      messageId: context.messageId,
      fileId: file.fileId,
      blockIdx: context.blockIdx,
    });
    return;
  }

  const contentPath = file.resource?.links.content;
  if (!contentPath) return;

  try {
    await openRemoteContentPreview({
      contentPath,
      id: previewId('resource', file.resource?.resourceId || file.id),
      title: file.name,
      ext: file.ext || extOfName(file.name) || '',
      mediaContext: {
        origin: context.origin,
        sessionPath: context.sessionPath,
      },
    });
  } catch (err) {
    console.error('[remote-preview] session file preview failed:', err);
    showError(getErrorMessage(err));
  }
}

export function fileRefDownloadUrl(file: FileRef): string | null {
  if (file.status === 'expired') return null;
  try {
    const resolved = resolveFileRefUrl(file, {
      connection: resolveServerConnection(useStore.getState()),
      platform: typeof window !== 'undefined' ? window.platform : null,
      preferLocalFile: false,
    });
    return resolved.mode === 'local-file' ? null : resolved.url;
  } catch {
    return null;
  }
}
