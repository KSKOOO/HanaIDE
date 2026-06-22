import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useStore } from '../../stores';
import type { DeskFile, FileVersion, RemoteWorkbenchContentRef, Session, VersionedWriteResult } from '../../types';
import { applyFolder, deskNativeRootDir, deskRenameTreeItem, deskTrashTreeItems, loadDeskFiles, loadDeskTreeFiles } from '../../stores/desk-actions';
import { archiveSession, createNewSession, switchSession } from '../../stores/session-actions';
import { openSettingsModal } from '../../stores/settings-modal-actions';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { extOfName } from '../../utils/file-kind';
import { PREVIEWABLE_EXTS, readFileForPreviewWithVersion } from '../../utils/preview-file-content';
import { normalizeWorkbenchContentRef, saveRemoteWorkbenchContent } from '../../utils/remote-file-preview';
import { ContextMenu, type ContextMenuItem } from '../../ui';
import { PreviewEditor } from '../PreviewEditor';
import { InputArea } from '../InputArea';
import { ChatArea } from '../chat/ChatArea';
import { RegionalErrorBoundary } from '../RegionalErrorBoundary';
import { buildWorkspaceContextMenuItems } from '../shared/workspace-context-menu';
import { createProjectFromTemplate, getProjectTemplate, PROJECT_TEMPLATES, type ProjectTemplateId } from '../../stores/project-templates';
import { HanaTerminalView, appendTerminalOutput, cleanTerminalOutput } from './HanaTerminalView';
import styles from './CodingMode.module.css';

type BuiltinActivityView = 'files' | 'search' | 'git' | 'run' | 'extensions';
type ExtensionActivityView = `extension:${string}`;
type ActivityView = BuiltinActivityView | ExtensionActivityView;
type EditorMode = 'markdown' | 'code' | 'csv' | 'text';
type PanelTab = 'terminal' | 'problems' | 'output' | 'logs';
type TerminalProfile = 'shell' | 'powershell' | 'cmd' | 'git-bash' | 'hana-cli' | 'vscode-cli';

interface CodingDocument {
  id: string;
  title: string;
  content: string;
  relativePath: string;
  filePath?: string;
  mode: EditorMode;
  language?: string | null;
  fileVersion?: FileVersion | null;
  remoteContentRef?: RemoteWorkbenchContentRef | null;
}

interface TerminalState {
  terminalId: string | null;
  sessionPath: string | null;
  seq: number;
  status: string;
  output: string;
  error: string | null;
  loading: boolean;
}

interface VscodeExtensionCommand {
  command: string;
  title: string;
  category?: string;
}

interface VscodeExtensionViewContainer {
  id: string;
  title: string;
  icon?: string;
}

interface VscodeExtensionView {
  id: string;
  name: string;
  when?: string;
}

interface VscodeExtensionItem {
  id: string;
  publisher?: string;
  name?: string;
  displayName?: string;
  description?: string;
  version?: string;
  enabled: boolean;
  runtime?: {
    hostKind?: string;
    supported?: boolean;
    activated?: boolean;
    reason?: string | null;
  };
  contributions?: {
    commands?: VscodeExtensionCommand[];
    viewsContainers?: Record<string, VscodeExtensionViewContainer[]>;
    views?: Record<string, VscodeExtensionView[]>;
  };
}

interface VscodeGalleryItem {
  id: string;
  displayName?: string;
  shortDescription?: string;
  version?: string;
  installCount?: number;
  rating?: number;
}

interface VscodeExtensionsState {
  loading: boolean;
  error: string | null;
  extensions: VscodeExtensionItem[];
  runtimeCommands: VscodeExtensionCommand[];
}

interface ResolvedExtensionView {
  loading: boolean;
  error: string | null;
  type?: 'webview' | 'tree';
  html?: string;
  title?: string;
  items?: Array<{
    label: string;
    description?: string;
    tooltip?: string;
    collapsibleState?: number;
    command?: { command?: string; title?: string; arguments?: any[] } | null;
  }>;
}

interface CodingContextMenuState {
  items: ContextMenuItem[];
  position: { x: number; y: number };
}

interface ProjectTemplateDraft {
  templateId: ProjectTemplateId;
  projectName: string;
  error: string | null;
  busy: boolean;
}

interface ExtensionActivityItem {
  id: ExtensionActivityView;
  containerId: string;
  title: string;
  extension: VscodeExtensionItem;
  views: VscodeExtensionView[];
  commands: VscodeExtensionCommand[];
}

const tr = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    files: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    git: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><circle cx="6" cy="18" r="2"/><path d="M8 6h2a4 4 0 0 1 4 4v1"/><path d="M6 8v8"/><path d="m14 12 4 4"/>',
    run: '<path d="m8 5 11 7-11 7z"/>',
    extensions: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V22a2 2 0 0 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H2a2 2 0 0 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V2a2 2 0 0 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H22a2 2 0 0 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z"/>',
    folder: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v7A2.5 2.5 0 0 1 18.5 18h-13A2.5 2.5 0 0 1 3 15.5z"/>',
    file: '<path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v7h-7"/>',
    terminal: '<path d="m4 7 5 5-5 5"/><path d="M12 19h8"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
  };
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths[name] || paths.file }} />
  );
}

function joinPath(root: string, subdir: string, name: string): string {
  return [root.replace(/[\\/]+$/, ''), subdir.replace(/^[/\\]+|[/\\]+$/g, ''), name]
    .filter(Boolean)
    .join('/');
}

function relativeCodingPath(name: string, subdir = ''): string {
  return [subdir.replace(/^[/\\]+|[/\\]+$/g, ''), name].filter(Boolean).join('/');
}

function normalizeCodingSubdir(value = ''): string {
  return value.replace(/^[/\\]+|[/\\]+$/g, '');
}

function codingChildPath(parent: string, name: string): string {
  const normalized = normalizeCodingSubdir(parent);
  return normalized ? `${normalized}/${name}` : name;
}

function modeForFile(name: string): EditorMode {
  const ext = extOfName(name) || '';
  const previewType = PREVIEWABLE_EXTS[ext] || 'code';
  if (previewType === 'markdown') return 'markdown';
  if (previewType === 'csv') return 'csv';
  if (previewType === 'code') return 'code';
  return 'text';
}

function isTextEditable(name: string): boolean {
  const mode = modeForFile(name);
  return mode === 'markdown' || mode === 'csv' || mode === 'code' || mode === 'text';
}

function remoteContentPath(mountId: string, subdir: string, name: string): string {
  const params = new URLSearchParams();
  params.set('mountId', mountId);
  params.set('subdir', subdir);
  params.set('name', name);
  return `/api/workbench/content?${params.toString()}`;
}

function terminalInitialState(): TerminalState {
  return {
    terminalId: null,
    sessionPath: null,
    seq: 0,
    status: 'idle',
    output: '',
    error: null,
    loading: false,
  };
}

function codingTerminalSessionPath(currentSessionPath: string | null | undefined, workspaceKey: string): string {
  const sessionPath = typeof currentSessionPath === 'string' ? currentSessionPath.trim() : '';
  if (sessionPath) return sessionPath;
  const key = workspaceKey.trim();
  return key ? `hanaide://terminal/${encodeURIComponent(key)}` : '';
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quotePosixLiteral(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\');
}

async function terminalRequest(payload: Record<string, unknown>) {
  const res = await hanaFetch('/api/terminal/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || data?.error) throw new Error(data?.error || `terminal request failed: ${res.status}`);
  return data;
}

const ACTIVITY_BUTTONS: Array<{ id: BuiltinActivityView; icon: string; labelKey: string }> = [
  { id: 'files', icon: 'files', labelKey: 'coding.activity.explorer' },
  { id: 'search', icon: 'search', labelKey: 'coding.activity.search' },
  { id: 'git', icon: 'git', labelKey: 'coding.activity.sourceControl' },
  { id: 'run', icon: 'run', labelKey: 'coding.activity.run' },
  { id: 'extensions', icon: 'extensions', labelKey: 'coding.activity.extensions' },
];

function extensionActivityId(extensionId: string, containerId: string): ExtensionActivityView {
  return `extension:${extensionId}:${containerId}`;
}

function webviewSrcDoc(viewId: string, html: string): string {
  const encodedViewId = JSON.stringify(viewId);
  const apiScript = `<script>
(() => {
  const stateKey = 'hanaide-webview-state';
  const viewId = ${encodedViewId};
  window.acquireVsCodeApi = window.acquireVsCodeApi || (() => ({
    postMessage: (message) => window.parent?.postMessage({ source: 'hanaide-webview', viewId, message }, '*'),
    getState: () => {
      try { return JSON.parse(sessionStorage.getItem(stateKey) || 'null'); } catch { return undefined; }
    },
    setState: (state) => {
      try { sessionStorage.setItem(stateKey, JSON.stringify(state)); } catch {}
      return state;
    }
  }));
  window.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.source !== 'hanaide-extension-host' || data.viewId !== viewId) return;
    window.dispatchEvent(new MessageEvent('message', { data: data.message }));
  });
})();
</script>`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${apiScript}`);
  return `${apiScript}${html}`;
}

const TERMINAL_PROFILES: Array<{ id: TerminalProfile; labelKey: string }> = [
  { id: 'shell', labelKey: 'coding.terminal.profileShell' },
  { id: 'powershell', labelKey: 'coding.terminal.profilePowerShell' },
  { id: 'cmd', labelKey: 'coding.terminal.profileCmd' },
  { id: 'git-bash', labelKey: 'coding.terminal.profileGitBash' },
  { id: 'hana-cli', labelKey: 'coding.terminal.profileHanaCli' },
  { id: 'vscode-cli', labelKey: 'coding.terminal.profileVscodeCli' },
];

function sessionTitle(session: Session): string {
  return session.title || session.firstMessage || session.agentName || tr('coding.chat.untitled');
}

function sessionAgeLabel(session: Session): string {
  const value = Date.parse(session.modified || '');
  if (!Number.isFinite(value)) return '';
  const diffMs = Math.max(0, Date.now() - value);
  const minutes = Math.floor(diffMs / 60000);
  const locale = window.i18n?.locale || 'zh';
  const zh = locale.toLowerCase().startsWith('zh');
  if (minutes < 1) return zh ? '刚刚' : 'now';
  if (minutes < 60) return zh ? `${minutes} 分钟` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return zh ? `${days} 天` : `${days}d`;
}

function terminalCommandForProfile(_profile: TerminalProfile, _cwd: string): string {
  return '';
}

function ProjectTemplateVisualPreview({ templateId }: { templateId: ProjectTemplateId }) {
  if (templateId === 'desktop-app') {
    return (
      <div className={`${styles.projectVisualPreview} ${styles.projectVisualDesktop}`} data-project-template-preview="desktop-app">
        <div className={styles.visualDesktopWindow}>
          <div className={styles.visualDesktopTitlebar}>
            <span />
            <span />
            <span />
          </div>
          <div className={styles.visualDesktopBody}>
            <div className={styles.visualDesktopIcon}><Icon name="terminal" /></div>
            <h3>{tr('coding.projectTemplate.visualPreview.desktopApp.title')}</h3>
            <p>{tr('coding.projectTemplate.visualPreview.desktopApp.subtitle')}</p>
            <div className={styles.visualStatusRow}>
              <span>{tr('coding.projectTemplate.visualPreview.desktopApp.status')}</span>
              <strong>Ready</strong>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (templateId === 'ai-app') {
    return (
      <div className={`${styles.projectVisualPreview} ${styles.projectVisualAi}`} data-project-template-preview="ai-app">
        <div className={styles.visualAiShell}>
          <div className={styles.visualAiHeader}>
            <span>{tr('coding.projectTemplate.visualPreview.aiApp.title')}</span>
            <span>{tr('coding.projectTemplate.visualPreview.aiApp.chip')}</span>
          </div>
          <div className={styles.visualAiMessage}>
            <small>{tr('coding.projectTemplate.visualPreview.aiApp.promptLabel')}</small>
            <p>{tr('coding.projectTemplate.visualPreview.aiApp.prompt')}</p>
          </div>
          <div className={`${styles.visualAiMessage} ${styles.visualAiReply}`}>
            <small>{tr('coding.projectTemplate.visualPreview.aiApp.replyLabel')}</small>
            <p>{tr('coding.projectTemplate.visualPreview.aiApp.response')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.projectVisualPreview} ${styles.projectVisualWeb}`} data-project-template-preview="basic-web">
      <div className={styles.visualBrowser}>
        <div className={styles.visualBrowserBar}>
          <span />
          <span />
          <span />
          <strong>localhost</strong>
        </div>
        <div className={styles.visualWebBody}>
          <div className={styles.visualWebBadge}>HanaIDE</div>
          <h3>{tr('coding.projectTemplate.visualPreview.basicWeb.title')}</h3>
          <p>{tr('coding.projectTemplate.visualPreview.basicWeb.subtitle')}</p>
          <button type="button">{tr('coding.projectTemplate.visualPreview.basicWeb.action')}</button>
        </div>
      </div>
    </div>
  );
}

export function CodingModePage() {
  const deskBasePath = useStore(s => s.deskBasePath);
  const nativeRoot = useStore(deskNativeRootDir);
  const mountId = useStore(s => s.deskWorkspaceMountId);
  const workspaceLabel = useStore(s => s.deskWorkspaceLabel);
  const rootFiles = useStore(s => s.deskTreeFilesByPath[''] || s.deskFiles);
  const treeFilesByPath = useStore(s => s.deskTreeFilesByPath);
  const expandedPaths = useStore(s => s.deskExpandedPaths);
  const setDeskExpandedPaths = useStore(s => s.setDeskExpandedPaths);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const sessions = useStore(s => s.sessions);
  const addQuotedSelection = useStore(s => s.addQuotedSelection);
  const requestInputFocus = useStore(s => s.requestInputFocus);
  const [activePath, setActivePath] = useState('');
  const [documents, setDocuments] = useState<CodingDocument[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [activeActivity, setActiveActivity] = useState<ActivityView>('files');
  const [searchQuery, setSearchQuery] = useState('');
  const [panelTab, setPanelTab] = useState<PanelTab>('terminal');
  const [terminal, setTerminal] = useState<TerminalState>(() => terminalInitialState());
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalProfile, setTerminalProfile] = useState<TerminalProfile>('shell');
  const terminalProfileRef = useRef<TerminalProfile>('shell');
  const [vscodeExtensions, setVscodeExtensions] = useState<VscodeExtensionsState>({
    loading: false,
    error: null,
    extensions: [],
    runtimeCommands: [],
  });
  const [vsixPath, setVsixPath] = useState('');
  const [galleryQuery, setGalleryQuery] = useState('');
  const [galleryResults, setGalleryResults] = useState<VscodeGalleryItem[]>([]);
  const [extensionBusy, setExtensionBusy] = useState<string | null>(null);
  const [resolvedExtensionViews, setResolvedExtensionViews] = useState<Record<string, ResolvedExtensionView>>({});
  const [contextMenu, setContextMenu] = useState<CodingContextMenuState | null>(null);
  const [projectTemplateDraft, setProjectTemplateDraft] = useState<ProjectTemplateDraft | null>(null);
  const terminalInputRef = useRef<HTMLTextAreaElement | null>(null);
  const webviewFrameRefs = useRef<Record<string, HTMLIFrameElement | null>>({});
  const webviewMessageSeqRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!deskBasePath) return;
    void loadDeskFiles();
  }, [deskBasePath]);

  const workspaceName = workspaceLabel || nativeRoot || deskBasePath || tr('coding.noWorkspace');
  const terminalCwd = nativeRoot || (!mountId ? deskBasePath : '');
  const terminalWorkspaceKey = mountId ? `mount:${mountId}` : (terminalCwd ? `local:${terminalCwd}` : '');
  const terminalSessionPath = useMemo(
    () => codingTerminalSessionPath(currentSessionPath, terminalWorkspaceKey),
    [currentSessionPath, terminalWorkspaceKey],
  );
  const activeTerminalSessionPath = terminal.sessionPath || terminalSessionPath;
  const canUseTerminal = !!terminalSessionPath && (!!terminalCwd || !!mountId);
  const terminalIsRunning = !!terminal.terminalId && terminal.status === 'running';
  const activeDocument = useMemo(
    () => documents.find(doc => doc.id === activeDocumentId) || documents[0] || null,
    [activeDocumentId, documents],
  );
  const activeProjectTemplate = useMemo(
    () => projectTemplateDraft ? getProjectTemplate(projectTemplateDraft.templateId) : null,
    [projectTemplateDraft?.templateId],
  );
  const openCodingFile = useCallback(async (name: string, subdir = '') => {
    if (!isTextEditable(name)) {
      setDocumentError(tr('coding.editor.unsupported'));
      return;
    }
    setDocumentError(null);
    const relativePath = relativeCodingPath(name, subdir);
    setActivePath(relativePath);
    const mode = modeForFile(name);
    const ext = extOfName(name) || null;
    try {
      if (mountId) {
        const contentPath = remoteContentPath(mountId, subdir, name);
        const docId = `workbench:${mountId}:${relativePath}`;
        if (documents.some(doc => doc.id === docId)) {
          setActiveDocumentId(docId);
          return;
        }
        const res = await hanaFetch(contentPath);
        if (!res.ok) throw new Error(`read failed: ${res.status}`);
        const content = await res.text();
        const remoteRef = normalizeWorkbenchContentRef({
          kind: 'workbench-file',
          mountId,
          rootId: mountId,
          subdir,
          name,
          contentPath,
          version: null,
        });
        const nextDocument: CodingDocument = {
          id: docId,
          title: name,
          content,
          relativePath,
          mode,
          language: ext,
          remoteContentRef: remoteRef,
        };
        setDocuments(prev => [...prev, nextDocument]);
        setActiveDocumentId(nextDocument.id);
        return;
      }

      if (!nativeRoot) throw new Error('workspace root unavailable');
      const filePath = joinPath(nativeRoot, subdir, name);
      const docId = `file:${filePath}`;
      if (documents.some(doc => doc.id === docId)) {
        setActiveDocumentId(docId);
        return;
      }
      const read = await readFileForPreviewWithVersion(filePath, ext || 'txt');
      const nextDocument: CodingDocument = {
        id: docId,
        title: name,
        content: read?.content ?? '',
        relativePath,
        filePath,
        mode,
        language: ext,
        fileVersion: read?.fileVersion ?? null,
      };
      setDocuments(prev => [...prev, nextDocument]);
      setActiveDocumentId(nextDocument.id);
    } catch (err) {
      setDocumentError(err instanceof Error ? err.message : String(err));
    }
  }, [documents, mountId, nativeRoot]);

  const saveRemote = useCallback(async (
    content: string,
    expectedVersion?: FileVersion | null,
  ): Promise<VersionedWriteResult> => {
    if (!activeDocument?.remoteContentRef) return { ok: false };
    return saveRemoteWorkbenchContent(activeDocument.remoteContentRef, content, expectedVersion);
  }, [activeDocument?.remoteContentRef]);

  const closeDocument = useCallback((id: string) => {
    setDocuments(prev => {
      const closingIndex = prev.findIndex(doc => doc.id === id);
      if (closingIndex < 0) return prev;
      const next = prev.filter(doc => doc.id !== id);
      if (id === activeDocumentId) {
        const fallback = next[closingIndex] || next[closingIndex - 1] || null;
        setActiveDocumentId(fallback?.id ?? null);
        setActivePath(fallback?.relativePath ?? '');
      }
      return next;
    });
  }, [activeDocumentId]);

  const activateDocument = useCallback((doc: CodingDocument) => {
    setActiveDocumentId(doc.id);
    setActivePath(doc.relativePath);
    setDocumentError(null);
  }, []);

  const openWorkspaceFolder = useCallback(async () => {
    const folder = await window.platform?.selectFolder?.();
    if (!folder) return;
    setDocuments([]);
    setActiveDocumentId(null);
    setActivePath('');
    setDocumentError(null);
    setActiveActivity('files');
    await applyFolder(folder);
  }, []);

  const refreshWorkspace = useCallback(() => {
    if (!deskBasePath) return;
    void loadDeskFiles('', mountId ? null : nativeRoot, mountId);
  }, [deskBasePath, mountId, nativeRoot]);

  const submitProjectTemplate = useCallback(async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!projectTemplateDraft || projectTemplateDraft.busy) return;
    const projectName = projectTemplateDraft.projectName.trim();
    if (!projectName) {
      setProjectTemplateDraft(prev => prev ? { ...prev, error: tr('coding.projectTemplate.invalidName') } : prev);
      return;
    }
    setProjectTemplateDraft(prev => prev ? { ...prev, projectName, error: null, busy: true } : prev);
    try {
      const ok = await createProjectFromTemplate(projectTemplateDraft.templateId, projectName);
      if (ok) {
        setProjectTemplateDraft(null);
        refreshWorkspace();
        return;
      }
      setProjectTemplateDraft(prev => prev ? { ...prev, busy: false, error: tr('coding.projectTemplate.failed') } : prev);
    } catch (err) {
      setProjectTemplateDraft(prev => prev ? {
        ...prev,
        busy: false,
        error: err instanceof Error ? err.message : String(err),
      } : prev);
    }
  }, [projectTemplateDraft, refreshWorkspace]);

  const buildTerminalStartPayload = useCallback(() => {
    const selectedProfile = terminalProfileRef.current || terminalProfile;
    return {
      action: 'start',
      sessionPath: terminalSessionPath,
      ...(mountId ? { workspaceMountId: mountId } : { cwd: terminalCwd }),
      command: terminalCommandForProfile(selectedProfile, terminalCwd),
      profile: selectedProfile,
      label: tr(TERMINAL_PROFILES.find(profile => profile.id === selectedProfile)?.labelKey || 'coding.terminal.profileShell'),
      cols: 120,
      rows: 28,
    };
  }, [mountId, terminalCwd, terminalProfile, terminalSessionPath]);

  const startTerminal = useCallback(async () => {
    if (!canUseTerminal) return;
    setTerminal(prev => ({ ...prev, loading: true, error: null }));
    try {
      const data = await terminalRequest(buildTerminalStartPayload());
      setTerminal({
        terminalId: data.terminalId || null,
        sessionPath: data.sessionPath || terminalSessionPath,
        seq: Number(data.seq) || 0,
        status: data.status || 'running',
        output: cleanTerminalOutput(data.output),
        error: null,
        loading: false,
      });
      window.setTimeout(() => terminalInputRef.current?.focus(), 0);
    } catch (err) {
      setTerminal(prev => ({ ...prev, loading: false, error: err instanceof Error ? err.message : String(err) }));
    }
  }, [buildTerminalStartPayload, canUseTerminal, terminalSessionPath]);

  const readTerminal = useCallback(async () => {
    if (!activeTerminalSessionPath || !terminal.terminalId) return;
    try {
      const data = await terminalRequest({
        action: 'read',
        sessionPath: activeTerminalSessionPath,
        terminalId: terminal.terminalId,
        sinceSeq: terminal.seq,
      });
      setTerminal(prev => ({
        ...prev,
        seq: Number(data.seq) || prev.seq,
        status: data.status || prev.status,
        output: appendTerminalOutput(prev.output, data.output),
        error: null,
      }));
    } catch (err) {
      setTerminal(prev => ({ ...prev, error: err instanceof Error ? err.message : String(err) }));
    }
  }, [activeTerminalSessionPath, terminal.seq, terminal.terminalId]);

  const writeTerminalChars = useCallback(async (chars: string) => {
    if (!activeTerminalSessionPath || !terminal.terminalId || !chars) return;
    try {
      const data = await terminalRequest({
        action: 'write',
        sessionPath: activeTerminalSessionPath,
        terminalId: terminal.terminalId,
        chars,
        sinceSeq: terminal.seq,
      });
      setTerminal(prev => ({
        ...prev,
        seq: Number(data.seq) || prev.seq,
        status: data.status || prev.status,
        output: appendTerminalOutput(prev.output, data.output),
        error: null,
      }));
    } catch (err) {
      setTerminal(prev => ({ ...prev, error: err instanceof Error ? err.message : String(err) }));
    }
  }, [activeTerminalSessionPath, terminal.seq, terminal.terminalId]);

  const writeTerminal = useCallback(async () => {
    if (!terminalInput) return;
    const chars = terminalInput.endsWith('\n') ? terminalInput : `${terminalInput}\n`;
    setTerminalInput('');
    await writeTerminalChars(chars);
  }, [terminalInput, writeTerminalChars]);

  const closeTerminal = useCallback(async () => {
    if (!activeTerminalSessionPath || !terminal.terminalId) return;
    try {
      const data = await terminalRequest({
        action: 'close',
        sessionPath: activeTerminalSessionPath,
        terminalId: terminal.terminalId,
      });
      setTerminal(prev => ({
        ...prev,
        status: data.status || 'killed',
        error: null,
      }));
    } catch (err) {
      setTerminal(prev => ({ ...prev, error: err instanceof Error ? err.message : String(err) }));
    }
  }, [activeTerminalSessionPath, terminal.terminalId]);

  useEffect(() => {
    if (!terminal.terminalId || terminal.status !== 'running') return undefined;
    const timer = window.setInterval(() => {
      void readTerminal();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [readTerminal, terminal.status, terminal.terminalId]);

  const runWorkspaceCommand = useCallback(async (command: string) => {
    if (!canUseTerminal) return;
    setPanelTab('terminal');
    let terminalId = terminal.terminalId;
    let sessionPath = terminal.sessionPath || terminalSessionPath;
    let sinceSeq = terminal.seq;

    if (!terminalId || terminal.status !== 'running') {
      setTerminal(prev => ({ ...prev, loading: true, error: null }));
      try {
        const data = await terminalRequest(buildTerminalStartPayload());
        terminalId = data.terminalId || null;
        sessionPath = data.sessionPath || terminalSessionPath;
        sinceSeq = Number(data.seq) || 0;
        setTerminal({
          terminalId,
          sessionPath,
          seq: sinceSeq,
          status: data.status || 'running',
          output: cleanTerminalOutput(data.output),
          error: null,
          loading: false,
        });
      } catch (err) {
        setTerminal(prev => ({ ...prev, loading: false, error: err instanceof Error ? err.message : String(err) }));
        return;
      }
    }

    if (!terminalId || !sessionPath) return;
    try {
      const data = await terminalRequest({
        action: 'write',
        sessionPath,
        terminalId,
        chars: command.endsWith('\n') ? command : `${command}\n`,
        sinceSeq,
      });
      setTerminal(prev => ({
        ...prev,
        terminalId,
        sessionPath,
        seq: Number(data.seq) || prev.seq,
        status: data.status || prev.status,
        output: appendTerminalOutput(prev.output, data.output),
        error: null,
        loading: false,
      }));
    } catch (err) {
      setTerminal(prev => ({ ...prev, error: err instanceof Error ? err.message : String(err), loading: false }));
    }
  }, [buildTerminalStartPayload, canUseTerminal, terminal.seq, terminal.sessionPath, terminal.status, terminal.terminalId, terminalSessionPath]);

  useEffect(() => {
    const handleCommand = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string; command?: string }>).detail?.action || '';
      if (action === 'workspace.openFolder') {
        void openWorkspaceFolder();
        return;
      }
      if (action === 'project.createTemplate') {
        const templateId = (event as CustomEvent<{ command?: string }>).detail?.command as ProjectTemplateId | undefined;
        if (templateId) {
          setProjectTemplateDraft({
            templateId,
            projectName: templateId,
            error: null,
            busy: false,
          });
        }
        return;
      }
      if (action === 'terminal.start') {
        setPanelTab('terminal');
        void startTerminal();
        return;
      }
      if (action === 'terminal.close') {
        void closeTerminal();
        return;
      }
      if (action === 'terminal.run') {
        const command = (event as CustomEvent<{ command?: string }>).detail?.command || '';
        if (command) void runWorkspaceCommand(command);
        return;
      }
      if (action === 'view.explorer') {
        setActiveActivity('files');
        return;
      }
      if (action === 'view.search') {
        setActiveActivity('search');
        return;
      }
      if (action === 'view.sourceControl') {
        setActiveActivity('git');
        return;
      }
      if (action === 'view.extensions') {
        setActiveActivity('extensions');
      }
    };
    window.addEventListener('hana:coding-command', handleCommand);
    return () => window.removeEventListener('hana:coding-command', handleCommand);
  }, [closeTerminal, openWorkspaceFolder, runWorkspaceCommand, startTerminal]);

  const loadVscodeExtensions = useCallback(async () => {
    setVscodeExtensions(prev => ({ ...prev, loading: true, error: null }));
    try {
      const res = await hanaFetch('/api/vscode-extensions');
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || `extensions request failed: ${res.status}`);
      setVscodeExtensions({
        loading: false,
        error: null,
        extensions: Array.isArray(data?.extensions) ? data.extensions : [],
        runtimeCommands: Array.isArray(data?.runtimeCommands) ? data.runtimeCommands : [],
      });
    } catch (err) {
      setVscodeExtensions(prev => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  useEffect(() => {
    if (activeActivity === 'extensions') {
      void loadVscodeExtensions();
    }
  }, [activeActivity, loadVscodeExtensions]);

  const installVsix = useCallback(async () => {
    const sourcePath = vsixPath.trim();
    if (!sourcePath) return;
    setExtensionBusy('install');
    try {
      const res = await hanaFetch('/api/vscode-extensions/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: sourcePath }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || `install failed: ${res.status}`);
      setVsixPath('');
      await loadVscodeExtensions();
    } catch (err) {
      setVscodeExtensions(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setExtensionBusy(null);
    }
  }, [loadVscodeExtensions, vsixPath]);

  const startVscodeRuntime = useCallback(async () => {
    setExtensionBusy('runtime');
    try {
      const res = await hanaFetch('/api/vscode-extensions/runtime/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath: terminalCwd || nativeRoot || deskBasePath || '' }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || `runtime failed: ${res.status}`);
      await loadVscodeExtensions();
    } catch (err) {
      setVscodeExtensions(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setExtensionBusy(null);
    }
  }, [deskBasePath, loadVscodeExtensions, nativeRoot, terminalCwd]);

  const ensureVscodeRuntime = useCallback(async () => {
    const res = await hanaFetch('/api/vscode-extensions/runtime/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: terminalCwd || nativeRoot || deskBasePath || '' }),
    });
    const data = await res.json();
    if (!res.ok || data?.error) throw new Error(data?.error || `runtime failed: ${res.status}`);
    return data;
  }, [deskBasePath, nativeRoot, terminalCwd]);

  const resolveVscodeView = useCallback(async (viewId: string) => {
    setResolvedExtensionViews(prev => ({
      ...prev,
      [viewId]: { ...(prev[viewId] || { error: null }), loading: true, error: null },
    }));
    try {
      await ensureVscodeRuntime();
      const res = await hanaFetch(`/api/vscode-extensions/runtime/views/${encodeURIComponent(viewId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || data?.error || data?.ok === false) throw new Error(data?.error || `view failed: ${res.status}`);
      setResolvedExtensionViews(prev => ({
        ...prev,
        [viewId]: {
          loading: false,
          error: null,
          type: data.type === 'tree' ? 'tree' : 'webview',
          html: typeof data.html === 'string' ? data.html : '',
          title: typeof data.title === 'string' ? data.title : undefined,
          items: Array.isArray(data.items) ? data.items : [],
        },
      }));
      await loadVscodeExtensions();
    } catch (err) {
      setResolvedExtensionViews(prev => ({
        ...prev,
        [viewId]: {
          ...(prev[viewId] || {}),
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }, [ensureVscodeRuntime, loadVscodeExtensions]);

  const sendVscodeWebviewMessage = useCallback(async (viewId: string, message: unknown) => {
    const res = await hanaFetch(`/api/vscode-extensions/runtime/views/${encodeURIComponent(viewId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    if (!res.ok || data?.error || data?.ok === false) throw new Error(data?.error || `webview message failed: ${res.status}`);
  }, []);

  const readVscodeWebviewMessages = useCallback(async (viewId: string) => {
    const after = webviewMessageSeqRef.current[viewId] || 0;
    const res = await hanaFetch(`/api/vscode-extensions/runtime/views/${encodeURIComponent(viewId)}/messages?after=${after}`);
    const data = await res.json();
    if (!res.ok || data?.error || data?.ok === false) return;
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    for (const item of messages) {
      const id = Number(item?.id) || 0;
      if (id > (webviewMessageSeqRef.current[viewId] || 0)) {
        webviewMessageSeqRef.current[viewId] = id;
      }
      webviewFrameRefs.current[viewId]?.contentWindow?.postMessage({
        source: 'hanaide-extension-host',
        viewId,
        message: item?.message,
      }, '*');
    }
  }, []);

  useEffect(() => {
    const handleWebviewMessage = (event: MessageEvent) => {
      const data = event.data || {};
      const viewId = typeof data.viewId === 'string' ? data.viewId : '';
      if (data.source !== 'hanaide-webview' || !viewId) return;
      void sendVscodeWebviewMessage(viewId, data.message).then(() => readVscodeWebviewMessages(viewId)).catch(() => undefined);
    };
    window.addEventListener('message', handleWebviewMessage);
    return () => window.removeEventListener('message', handleWebviewMessage);
  }, [readVscodeWebviewMessages, sendVscodeWebviewMessage]);

  const setVscodeExtensionEnabled = useCallback(async (extension: VscodeExtensionItem, enabled: boolean) => {
    setExtensionBusy(extension.id);
    try {
      const res = await hanaFetch(`/api/vscode-extensions/${encodeURIComponent(extension.id)}/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || `enablement failed: ${res.status}`);
      await loadVscodeExtensions();
    } catch (err) {
      setVscodeExtensions(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setExtensionBusy(null);
    }
  }, [loadVscodeExtensions]);

  const uninstallVscodeExtension = useCallback(async (extension: VscodeExtensionItem) => {
    setExtensionBusy(extension.id);
    try {
      const res = await hanaFetch(`/api/vscode-extensions/${encodeURIComponent(extension.id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || `uninstall failed: ${res.status}`);
      setResolvedExtensionViews(prev => {
        const next = { ...prev };
        for (const views of Object.values(extension.contributions?.views || {})) {
          for (const view of views || []) {
            delete next[view.id];
          }
        }
        return next;
      });
      await loadVscodeExtensions();
    } catch (err) {
      setVscodeExtensions(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setExtensionBusy(null);
    }
  }, [loadVscodeExtensions]);

  const executeVscodeCommand = useCallback(async (command: string) => {
    setExtensionBusy(command);
    try {
      await ensureVscodeRuntime();
      const res = await hanaFetch(`/api/vscode-extensions/runtime/commands/${encodeURIComponent(command)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || `command failed: ${res.status}`);
      setPanelTab('output');
      setTerminal(prev => ({
        ...prev,
        output: `${prev.output}${prev.output ? '\n' : ''}${command}: ${JSON.stringify(data.result)}`,
      }));
      await loadVscodeExtensions();
    } catch (err) {
      setVscodeExtensions(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setExtensionBusy(null);
    }
  }, [ensureVscodeRuntime, loadVscodeExtensions]);

  const searchVscodeGallery = useCallback(async () => {
    const query = galleryQuery.trim();
    if (!query) return;
    setExtensionBusy('gallery-search');
    try {
      const res = await hanaFetch(`/api/vscode-extensions/gallery/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || `gallery search failed: ${res.status}`);
      setGalleryResults(Array.isArray(data?.results) ? data.results : []);
    } catch (err) {
      setVscodeExtensions(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setExtensionBusy(null);
    }
  }, [galleryQuery]);

  const installGalleryExtension = useCallback(async (extension: VscodeGalleryItem) => {
    setExtensionBusy(extension.id);
    try {
      const res = await hanaFetch('/api/vscode-extensions/gallery/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: extension.id }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || `gallery install failed: ${res.status}`);
      await loadVscodeExtensions();
    } catch (err) {
      setVscodeExtensions(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setExtensionBusy(null);
    }
  }, [loadVscodeExtensions]);

  const expandFolder = useCallback((subdir: string) => {
    const normalized = normalizeCodingSubdir(subdir);
    if (!normalized) return;
    const expanded = expandedPaths.includes(normalized);
    const nextPaths = expanded
      ? expandedPaths.filter(path => path !== normalized && !path.startsWith(`${normalized}/`))
      : Array.from(new Set([...expandedPaths, normalized]));
    setDeskExpandedPaths(nextPaths);
    if (!expanded && !Object.prototype.hasOwnProperty.call(treeFilesByPath, normalized)) {
      void loadDeskTreeFiles(normalized);
    }
  }, [expandedPaths, setDeskExpandedPaths, treeFilesByPath]);

  const handleFileContextMenu = useCallback((event: React.MouseEvent, file: DeskFile, parentSubdir = '') => {
    event.preventDefault();
    event.stopPropagation();
    const normalizedParent = normalizeCodingSubdir(parentSubdir);
    const relativePath = codingChildPath(normalizedParent, file.name);
    const workspaceRoot = nativeRoot || (!mountId ? deskBasePath : '');
    const filePath = workspaceRoot ? joinPath(workspaceRoot, normalizedParent, file.name) : relativePath;
    const terminalTarget = mountId
      ? (file.isDir ? relativePath : (normalizedParent || '.'))
      : (file.isDir ? filePath : (workspaceRoot ? joinPath(workspaceRoot, normalizedParent, '') : workspaceRoot));
    const cdCommand = terminalTarget
      ? (mountId
        ? `cd ${quotePosixLiteral(terminalTarget)}`
        : (isWindowsPath(terminalTarget)
          ? `Set-Location -LiteralPath ${quotePowerShellLiteral(terminalTarget)}`
          : `cd ${quotePosixLiteral(terminalTarget)}`))
      : '';
    const items = buildWorkspaceContextMenuItems({
      t: tr,
      target: {
        name: file.name,
        isDirectory: file.isDir,
        absolutePath: workspaceRoot ? filePath : null,
        relativePath,
      },
      actions: {
        open: file.isDir
          ? () => expandFolder(relativePath)
          : () => { void openCodingFile(file.name, normalizedParent); },
        openWith: workspaceRoot && !file.isDir && window.platform?.openFile
          ? () => window.platform?.openFile?.(filePath)
          : undefined,
        revealInExplorer: workspaceRoot && window.platform?.showInFinder
          ? () => window.platform?.showInFinder?.(filePath)
          : undefined,
        openInTerminal: cdCommand && canUseTerminal
          ? () => void runWorkspaceCommand(cdCommand)
          : undefined,
        compare: !file.isDir && activeDocument && activeDocument.relativePath !== relativePath
          ? () => {
              setPanelTab('output');
              setTerminal(prev => ({
                ...prev,
                output: appendTerminalOutput(prev.output, `\n${tr('coding.fileMenu.compareQueued', { left: activeDocument?.title || '', right: file.name })}\n`),
              }));
              void openCodingFile(file.name, normalizedParent);
            }
          : undefined,
        addToAssistant: () => {
          const store = useStore.getState();
          store.addAttachedFile?.({ path: filePath, name: file.name, isDirectory: file.isDir });
          store.requestInputFocus?.();
        },
        copy: () => navigator.clipboard?.writeText?.(workspaceRoot ? filePath : relativePath).catch(() => {}),
        copyPath: workspaceRoot ? () => navigator.clipboard?.writeText?.(filePath).catch(() => {}) : undefined,
        copyRelativePath: () => navigator.clipboard?.writeText?.(relativePath).catch(() => {}),
        rename: async () => {
          const nextName = window.prompt?.(tr('coding.fileMenu.renamePrompt'), file.name)?.trim();
          if (!nextName || nextName === file.name) return;
          const ok = await deskRenameTreeItem(normalizedParent, file.name, nextName, file.isDir);
          if (ok) await loadDeskTreeFiles(normalizedParent, { force: true, overrideDir: mountId ? null : nativeRoot, overrideMountId: mountId });
        },
        delete: async () => {
          const okConfirm = window.confirm?.(tr('coding.fileMenu.deleteConfirm', { name: file.name })) ?? false;
          if (!okConfirm) return;
          const ok = await deskTrashTreeItems([{ sourceSubdir: normalizedParent, name: file.name, isDirectory: file.isDir }]);
          if (ok) await loadDeskTreeFiles(normalizedParent, { force: true, overrideDir: mountId ? null : nativeRoot, overrideMountId: mountId });
        },
      },
    });
    setContextMenu({ items, position: { x: event.clientX, y: event.clientY } });
  }, [activeDocument, canUseTerminal, deskBasePath, expandFolder, mountId, nativeRoot, openCodingFile, runWorkspaceCommand]);

  const addSelectionToAssistant = useCallback(() => {
    const text = window.getSelection?.()?.toString().trim() || '';
    if (!text) return;
    const sourceFilePath = activeDocument?.filePath || activeDocument?.relativePath || undefined;
    addQuotedSelection({
      text,
      sourceTitle: activeDocument?.title || tr('coding.editor.welcomeTitle'),
      sourceKind: 'preview',
      sourceFilePath,
      sourceSessionPath: currentSessionPath || undefined,
      selectionAnchorKind: 'native',
      charCount: text.length,
      updatedAt: Date.now(),
    });
    requestInputFocus();
  }, [activeDocument?.filePath, activeDocument?.relativePath, activeDocument?.title, addQuotedSelection, currentSessionPath, requestInputFocus]);

  const createCodingSession = useCallback(() => {
    const cwd = nativeRoot || (!mountId ? deskBasePath : '');
    void createNewSession(cwd ? { cwd } : {});
  }, [deskBasePath, mountId, nativeRoot]);

  const renderAssistantSessions = () => (
    <section className={styles.assistantSessionStrip} aria-label={tr('coding.chat.history')} role="region" data-coding-session-history="top">
      <div className={styles.assistantRailHeader}>
        <span>{tr('coding.chat.history')}</span>
        <button
          type="button"
          className={styles.assistantRailAction}
          onClick={createCodingSession}
          aria-label={tr('coding.chat.newSession')}
          title={tr('coding.chat.newSession')}
        >
          +
        </button>
      </div>
      <div className={styles.assistantSessionList} role="list">
        {sessions.length > 0 ? sessions.slice(0, 8).map(session => {
          const title = sessionTitle(session);
          const age = sessionAgeLabel(session);
          const active = session.path === currentSessionPath;
          return (
            <div key={session.path} className={`${styles.assistantSessionItem}${active ? ` ${styles.assistantSessionItemActive}` : ''}`} role="listitem">
              <button
                type="button"
                className={styles.assistantSessionButton}
                onClick={() => void switchSession(session.path)}
                aria-label={title}
                aria-current={active ? 'page' : undefined}
              >
                <span className={styles.assistantSessionTitle}>{title}</span>
                <span className={styles.assistantSessionMeta}>{age}</span>
              </button>
              <button
                type="button"
                className={styles.assistantSessionDelete}
                onClick={(event) => {
                  event.stopPropagation();
                  void archiveSession(session.path);
                }}
                aria-label={`${tr('coding.chat.deleteSession')} ${title}`}
                title={tr('coding.chat.deleteSession')}
              >
                x
              </button>
            </div>
          );
        }) : (
          <div className={styles.emptyState}>{tr('coding.chat.emptyHistory')}</div>
        )}
      </div>
    </section>
  );

  const rootFileButtons = useMemo(() => {
    const renderFiles = (files: DeskFile[], parentSubdir = '', depth = 0): ReactNode[] => files.flatMap(file => {
      const relativePath = codingChildPath(parentSubdir, file.name);
      const expanded = file.isDir && expandedPaths.includes(relativePath);
      const active = activePath === relativePath;
      const children = file.isDir && expanded ? (treeFilesByPath[relativePath] || []) : [];
      const item = (
        <button
          key={relativePath}
          type="button"
          className={`${styles.treeItem}${active ? ` ${styles.treeItemActive}` : ''}`}
          role="treeitem"
          aria-selected={active}
          aria-expanded={file.isDir ? expanded : undefined}
          style={{ paddingLeft: `${4 + depth * 14}px` }}
          onClick={() => {
            setActivePath(relativePath);
            if (file.isDir) {
              expandFolder(relativePath);
            } else {
              void openCodingFile(file.name, parentSubdir);
            }
          }}
          onContextMenu={(event) => handleFileContextMenu(event, file, parentSubdir)}
        >
          <span className={styles.treeTwisty}>
            {file.isDir ? <Icon name={expanded ? 'chevronDown' : 'chevronRight'} /> : null}
          </span>
          <Icon name={file.isDir ? 'folder' : 'file'} />
          <span className={styles.treeName}>{file.name}</span>
        </button>
      );
      return children.length > 0 ? [item, ...renderFiles(children, relativePath, depth + 1)] : [item];
    });
    return renderFiles(rootFiles);
  }, [activePath, expandedPaths, expandFolder, handleFileContextMenu, openCodingFile, rootFiles, treeFilesByPath]);

  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return rootFiles
      .filter(file => !file.isDir && file.name.toLowerCase().includes(query))
      .slice(0, 80);
  }, [rootFiles, searchQuery]);

  const extensionActivityItems = useMemo<ExtensionActivityItem[]>(() => {
    const items: ExtensionActivityItem[] = [];
    const seen = new Set<string>();
    for (const extension of vscodeExtensions.extensions) {
      if (!extension.enabled) continue;
      const commands = extension.contributions?.commands || [];
      const containers = extension.contributions?.viewsContainers?.activitybar || [];
      for (const container of containers) {
        if (!container.id || seen.has(`${extension.id}:${container.id}`)) continue;
        seen.add(`${extension.id}:${container.id}`);
        items.push({
          id: extensionActivityId(extension.id, container.id),
          containerId: container.id,
          title: container.title || extension.displayName || extension.name || extension.id,
          extension,
          views: extension.contributions?.views?.[container.id] || [],
          commands,
        });
      }
      if (containers.length === 0 && commands.length > 0 && !seen.has(extension.id)) {
        seen.add(extension.id);
        items.push({
          id: extensionActivityId(extension.id, 'commands'),
          containerId: 'commands',
          title: extension.displayName || extension.name || extension.id,
          extension,
          views: [],
          commands,
        });
      }
    }
    return items;
  }, [vscodeExtensions.extensions]);

  const activeExtensionActivity = useMemo(
    () => extensionActivityItems.find(item => item.id === activeActivity) || null,
    [activeActivity, extensionActivityItems],
  );

  const activeActivityTitle = activeExtensionActivity?.title
    || tr(ACTIVITY_BUTTONS.find(item => item.id === activeActivity)?.labelKey || 'coding.activity.explorer');

  useEffect(() => {
    if (!activeExtensionActivity) return;
    for (const view of activeExtensionActivity.views) {
      const current = resolvedExtensionViews[view.id];
      if (!current || (!current.loading && !current.html && !current.items?.length && !current.error)) {
        void resolveVscodeView(view.id);
      }
    }
  }, [activeExtensionActivity, resolveVscodeView, resolvedExtensionViews]);

  useEffect(() => {
    if (!activeExtensionActivity) return undefined;
    const viewIds = activeExtensionActivity.views
      .map(view => view.id)
      .filter(viewId => resolvedExtensionViews[viewId]?.type === 'webview' && resolvedExtensionViews[viewId]?.html);
    if (viewIds.length === 0) return undefined;
    const readMessages = () => {
      for (const viewId of viewIds) {
        void readVscodeWebviewMessages(viewId);
      }
    };
    readMessages();
    const timer = window.setInterval(readMessages, 800);
    return () => window.clearInterval(timer);
  }, [activeExtensionActivity, readVscodeWebviewMessages, resolvedExtensionViews]);

  const commandButton = (labelKey: string, command: string) => (
    <button
      type="button"
      className={styles.commandButton}
      onClick={() => void runWorkspaceCommand(command)}
      disabled={!canUseTerminal}
      aria-label={tr(labelKey)}
    >
      {tr(labelKey)}
    </button>
  );

  const renderActivityBody = () => {
    if (activeExtensionActivity) {
      const { extension, views, commands } = activeExtensionActivity;
      const canRunCommands = extension.enabled && extension.runtime?.supported !== false;
      return (
        <div className={styles.toolPanel}>
          <div className={styles.extensionCard}>
            <div className={styles.extensionHeader}>
              <div>
                <div className={styles.extensionTitle}>{extension.displayName || extension.name || extension.id}</div>
                <div className={styles.extensionMeta}>{extension.id}</div>
              </div>
              <span className={styles.extensionBadge}>{extension.runtime?.hostKind || tr('coding.extensions.runtime')}</span>
            </div>
            {views.length > 0 ? (
              <div className={styles.extensionViewList}>
                {views.map(view => {
                  const resolved = resolvedExtensionViews[view.id];
                  return (
                    <div key={view.id} className={styles.extensionViewCard}>
                      <div className={styles.extensionViewTitle}>{resolved?.title || view.name || view.id}</div>
                      <div className={styles.extensionMeta}>{view.id}</div>
                      {resolved?.loading && <div className={styles.mutedLine}>{tr('coding.extensions.resolvingView')}</div>}
                      {resolved?.error && <div className={styles.errorLine}>{resolved.error}</div>}
                      {resolved?.type === 'webview' && resolved.html && (
                        <iframe
                          className={styles.extensionWebview}
                          title={view.name || view.id}
                          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock allow-downloads"
                          allow="clipboard-read; clipboard-write; autoplay; local-network-access"
                          ref={(node) => { webviewFrameRefs.current[view.id] = node; }}
                          onLoad={() => void readVscodeWebviewMessages(view.id)}
                          srcDoc={webviewSrcDoc(view.id, resolved.html)}
                        />
                      )}
                      {resolved?.type === 'tree' && Array.isArray(resolved.items) && resolved.items.length > 0 && (
                        <div className={styles.extensionTreeItems}>
                          {resolved.items.map((item, index) => (
                            <button
                              key={`${item.label}-${index}`}
                              type="button"
                              className={styles.extensionTreeItem}
                              disabled={!item.command?.command}
                              title={item.tooltip || item.command?.command || item.label}
                              onClick={() => item.command?.command && void executeVscodeCommand(item.command.command)}
                            >
                              <span>{item.label}</span>
                              {item.description && <small>{item.description}</small>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className={styles.extensionViewCard}>
                <div className={styles.extensionViewTitle}>{tr('coding.extensions.availableCommands')}</div>
                <div className={styles.extensionMeta}>{tr('coding.extensions.commandOnlyView')}</div>
              </div>
            )}
            <div className={styles.extensionCommands}>
              {commands.length > 0 ? commands.map(command => (
                <button
                  key={command.command}
                  type="button"
                  className={styles.commandChip}
                  onClick={() => void executeVscodeCommand(command.command)}
                  disabled={!canRunCommands || extensionBusy === command.command}
                  title={command.command}
                >
                  {command.title || command.command}
                </button>
              )) : (
                <span className={styles.mutedLine}>{tr('coding.extensions.noCommands')}</span>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (activeActivity === 'files') {
      return (
        <>
          <div className={styles.workspaceName}>
            <Icon name="folder" />
            <span className={styles.treeName}>{workspaceName}</span>
          </div>
          <div className={styles.tree} role="tree" aria-label={tr('coding.labels.explorer')}>
            {rootFileButtons.length > 0 ? rootFileButtons : (
              <div className={styles.emptyState}>{tr('coding.explorer.empty')}</div>
            )}
          </div>
        </>
      );
    }

    if (activeActivity === 'search') {
      return (
        <div className={styles.toolPanel}>
          <label className={styles.fieldLabel} htmlFor="coding-file-search">{tr('coding.search.label')}</label>
          <input
            id="coding-file-search"
            className={styles.searchInput}
            type="search"
            value={searchQuery}
            aria-label={tr('coding.search.label')}
            placeholder={tr('coding.search.placeholder')}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
          />
          <div className={styles.searchResults}>
            {!searchQuery.trim() ? (
              <div className={styles.emptyState}>{tr('coding.search.hint')}</div>
            ) : searchResults.length > 0 ? searchResults.map(file => (
              <button
                key={file.name}
                type="button"
                className={`${styles.treeItem}${activePath === file.name ? ` ${styles.treeItemActive}` : ''}`}
                onClick={() => void openCodingFile(file.name)}
              >
                <span />
                <Icon name="file" />
                <span className={styles.treeName}>{file.name}</span>
              </button>
            )) : (
              <div className={styles.emptyState}>{tr('coding.search.empty')}</div>
            )}
          </div>
        </div>
      );
    }

    if (activeActivity === 'git') {
      return (
        <div className={styles.toolPanel}>
          <p className={styles.panelDescription}>{tr('coding.sourceControl.description')}</p>
          <div className={styles.commandStack}>
            {commandButton('coding.sourceControl.gitStatus', 'git status --short --branch')}
            {commandButton('coding.sourceControl.refresh', 'git status --short')}
          </div>
        </div>
      );
    }

    if (activeActivity === 'run') {
      return (
        <div className={styles.toolPanel}>
          <p className={styles.panelDescription}>{tr('coding.run.description')}</p>
          <div className={styles.commandStack}>
            <button
              type="button"
              className={styles.commandButton}
              onClick={startTerminal}
              disabled={!canUseTerminal || terminal.loading}
              aria-label={tr('coding.run.startTerminal')}
            >
              {tr('coding.run.startTerminal')}
            </button>
            {commandButton('coding.run.gitStatus', 'git status --short --branch')}
            {commandButton('coding.run.npmTest', 'npm test')}
            {commandButton('coding.run.npmBuild', 'npm run build')}
          </div>
        </div>
      );
    }

    if (activeActivity === 'extensions') {
      return (
        <div className={styles.toolPanel}>
          <p className={styles.panelDescription}>{tr('coding.extensions.description')}</p>
          <div className={styles.extensionActions}>
            <button
              type="button"
              className={styles.commandButton}
              onClick={startVscodeRuntime}
              disabled={extensionBusy === 'runtime'}
              aria-label={tr('coding.extensions.startRuntime')}
            >
              {tr('coding.extensions.startRuntime')}
            </button>
            <label className={styles.fieldLabel} htmlFor="coding-vsix-path">{tr('coding.extensions.installPathLabel')}</label>
            <div className={styles.inlineActionRow}>
              <input
                id="coding-vsix-path"
                className={styles.searchInput}
                value={vsixPath}
                placeholder={tr('coding.extensions.installPathPlaceholder')}
                onChange={(event) => setVsixPath(event.currentTarget.value)}
              />
              <button
                type="button"
                className={styles.inlineButton}
                onClick={installVsix}
                disabled={!vsixPath.trim() || extensionBusy === 'install'}
                aria-label={tr('coding.extensions.installVsix')}
              >
                {tr('coding.extensions.installVsix')}
              </button>
            </div>
            <label className={styles.fieldLabel} htmlFor="coding-gallery-search">{tr('coding.extensions.gallerySearch')}</label>
            <div className={styles.inlineActionRow}>
              <input
                id="coding-gallery-search"
                className={styles.searchInput}
                type="search"
                value={galleryQuery}
                placeholder={tr('coding.extensions.galleryPlaceholder')}
                onChange={(event) => setGalleryQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void searchVscodeGallery();
                  }
                }}
              />
              <button
                type="button"
                className={styles.inlineButton}
                onClick={searchVscodeGallery}
                disabled={!galleryQuery.trim() || extensionBusy === 'gallery-search'}
              >
                {tr('coding.extensions.search')}
              </button>
            </div>
          </div>

          {vscodeExtensions.error && (
            <div className={styles.errorLine}>{vscodeExtensions.error}</div>
          )}

          {galleryResults.length > 0 && (
            <div className={styles.extensionList} aria-label={tr('coding.extensions.galleryResults')}>
              {galleryResults.map(extension => (
                <div key={extension.id} className={styles.extensionCard}>
                  <div className={styles.extensionHeader}>
                    <div className={styles.extensionTitle}>{extension.displayName || extension.id}</div>
                    <button
                      type="button"
                      className={styles.inlineButton}
                      onClick={() => void installGalleryExtension(extension)}
                      disabled={extensionBusy === extension.id}
                    >
                      {tr('coding.extensions.installVsix')}
                    </button>
                  </div>
                  <div className={styles.extensionMeta}>{extension.id}</div>
                  {extension.shortDescription && (
                    <div className={styles.extensionDescription}>{extension.shortDescription}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className={styles.extensionSectionTitle}>{tr('coding.extensions.installed')}</div>
          {vscodeExtensions.runtimeCommands.length > 0 && (
            <>
              <div className={styles.extensionSectionTitle}>{tr('coding.extensions.availableCommands')}</div>
              <div className={styles.extensionCommands}>
                {vscodeExtensions.runtimeCommands.map(command => (
                  <button
                    key={command.command}
                    type="button"
                    className={styles.commandChip}
                    onClick={() => void executeVscodeCommand(command.command)}
                    disabled={extensionBusy === command.command}
                    title={command.command}
                  >
                    {command.title || command.command}
                  </button>
                ))}
              </div>
            </>
          )}
          {vscodeExtensions.loading ? (
            <div className={styles.emptyState}>{tr('coding.extensions.loading')}</div>
          ) : vscodeExtensions.extensions.length === 0 ? (
            <div className={styles.emptyState}>{tr('coding.extensions.empty')}</div>
          ) : (
            <div className={styles.extensionList}>
              {vscodeExtensions.extensions.map(extension => {
                const commands = extension.contributions?.commands || [];
                return (
                  <div key={extension.id} className={styles.extensionCard}>
                    <div className={styles.extensionHeader}>
                      <div>
                        <div className={styles.extensionTitle}>{extension.displayName || extension.name || extension.id}</div>
                        <div className={styles.extensionMeta}>{extension.id}</div>
                      </div>
                      <div className={styles.inlineActionRow}>
                        <button
                          type="button"
                          className={styles.inlineButton}
                          onClick={() => void setVscodeExtensionEnabled(extension, !extension.enabled)}
                          disabled={extensionBusy === extension.id}
                        >
                          {extension.enabled ? tr('coding.extensions.disable') : tr('coding.extensions.enable')}
                        </button>
                        <button
                          type="button"
                          className={styles.inlineButton}
                          onClick={() => void uninstallVscodeExtension(extension)}
                          disabled={extensionBusy === extension.id}
                        >
                          {tr('coding.extensions.uninstall')}
                        </button>
                      </div>
                    </div>
                    <div className={styles.extensionBadges}>
                      <span className={styles.extensionBadge}>{extension.version || '0.0.0'}</span>
                      <span className={styles.extensionBadge}>{extension.runtime?.hostKind || tr('coding.extensions.runtime')}</span>
                      <span className={styles.extensionBadge}>{extension.enabled ? tr('coding.extensions.enabled') : tr('coding.extensions.disabled')}</span>
                      {extension.runtime?.activated && <span className={styles.extensionBadge}>{tr('coding.extensions.activated')}</span>}
                      {!extension.runtime?.supported && <span className={styles.extensionBadge}>{tr('coding.extensions.unsupported')}</span>}
                    </div>
                    {extension.description && (
                      <div className={styles.extensionDescription}>{extension.description}</div>
                    )}
                    <div className={styles.extensionCommands}>
                      {commands.length > 0 ? commands.map(command => (
                        <button
                          key={command.command}
                          type="button"
                          className={styles.commandChip}
                          onClick={() => void executeVscodeCommand(command.command)}
                          disabled={!extension.enabled || extension.runtime?.supported === false || extensionBusy === command.command}
                          title={command.command}
                        >
                          {command.title || command.command}
                        </button>
                      )) : (
                        <span className={styles.mutedLine}>{tr('coding.extensions.noCommands')}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className={styles.featureList}>
            <div>{tr('coding.extensions.nativeTools')}</div>
          </div>
        </div>
      );
    }

    return null;
  };

  const editorDoc = activeDocument ?? {
    id: 'coding:welcome',
    title: tr('coding.editor.welcomeTitle'),
    content: tr('coding.editor.welcomeContent'),
    mode: 'code' as EditorMode,
    language: 'txt',
  };

  return (
    <section className={styles.shell} aria-label={tr('coding.title')} data-coding-mode-page="">
      <nav className={styles.activityRail} aria-label={tr('coding.activityRail')} role="region">
        {ACTIVITY_BUTTONS.map(({ id, icon, labelKey }) => (
          <button
            key={id}
            type="button"
            className={`${styles.railButton}${activeActivity === id ? ` ${styles.railButtonActive}` : ''}`}
            title={tr(labelKey)}
            aria-label={tr(labelKey)}
            aria-pressed={activeActivity === id}
            onClick={() => setActiveActivity(id)}
          >
            <Icon name={icon} />
          </button>
        ))}
        {extensionActivityItems.map(item => (
          <button
            key={item.id}
            type="button"
            className={`${styles.railButton}${activeActivity === item.id ? ` ${styles.railButtonActive}` : ''}`}
            title={item.title}
            aria-label={item.title}
            aria-pressed={activeActivity === item.id}
            onClick={() => setActiveActivity(item.id)}
          >
            <Icon name="extensions" />
          </button>
        ))}
        <span className={styles.railSpacer} />
        <button
          type="button"
          className={styles.railButton}
          title={tr('coding.activity.settings')}
          aria-label={tr('coding.activity.settings')}
          aria-pressed="false"
          onClick={() => openSettingsModal()}
        >
          <Icon name="settings" />
        </button>
      </nav>

      <aside className={styles.explorer} aria-label={tr('coding.labels.explorer')}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            {activeActivityTitle}
          </span>
          <div className={styles.sectionActions}>
            <button type="button" className={styles.iconButton} onClick={openWorkspaceFolder} title={tr('coding.explorer.openFolder')} aria-label={tr('coding.explorer.openFolder')}>
              <Icon name="folder" />
            </button>
            <button type="button" className={styles.iconButton} onClick={refreshWorkspace} title={tr('common.refresh')} aria-label={tr('common.refresh')}>
              <Icon name="refresh" />
            </button>
          </div>
        </div>
        {renderActivityBody()}
      </aside>

      <section className={styles.editorShell} aria-label={tr('coding.labels.editor')} role="region">
        <div className={styles.editorTabBar} role="tablist" aria-label={tr('coding.editor.openTabs')}>
          {documents.length > 0 ? documents.map(doc => {
            const active = doc.id === editorDoc.id;
            return (
              <div key={doc.id} className={`${styles.editorTab}${active ? ` ${styles.editorTabActive}` : ''}`}>
                <button
                  type="button"
                  role="tab"
                  className={styles.editorTabButton}
                  aria-selected={active}
                  onClick={() => activateDocument(doc)}
                >
                  <Icon name="file" />
                  <span>{doc.title}</span>
                </button>
                <button
                  type="button"
                  className={styles.editorTabClose}
                  title={`${tr('coding.editor.closeTab')} ${doc.title}`}
                  aria-label={`${tr('coding.editor.closeTab')} ${doc.title}`}
                  onClick={() => closeDocument(doc.id)}
                >
                  <Icon name="close" />
                </button>
              </div>
            );
          }) : (
            <div className={`${styles.editorTab} ${styles.editorTabWelcome}`}>
              <Icon name="file" />
              <span>{editorDoc.title}</span>
            </div>
          )}
        </div>
        <div className={styles.editorBody}>
          <PreviewEditor
            key={editorDoc.id}
            content={editorDoc.content}
            filePath={editorDoc.filePath}
            remoteContentRef={editorDoc.remoteContentRef}
            fileVersion={editorDoc.fileVersion}
            saveDocument={editorDoc.remoteContentRef ? saveRemote : undefined}
            mode={editorDoc.mode}
            language={editorDoc.language}
            onContentChange={(content, fileVersion) => {
              if (!activeDocument) return;
              setDocuments(prev => prev.map(doc => doc.id === activeDocument.id
                ? { ...doc, content, fileVersion: fileVersion ?? doc.fileVersion }
                : doc));
            }}
          />
          {documentError && (
            <div className={styles.editorOverlay}>
              <div className={styles.editorOverlayInner}>
                <div className={styles.editorOverlayTitle}>{tr('coding.editor.openFailed')}</div>
                <div>{documentError}</div>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className={styles.bottomPanel} aria-label={tr('coding.labels.panel')} role="region">
        <div className={styles.panelTabs}>
          {(['terminal', 'problems', 'output', 'logs'] as PanelTab[]).map(tab => (
            <button
              key={tab}
              type="button"
              className={`${styles.panelTab}${panelTab === tab ? ` ${styles.panelTabActive}` : ''}`}
              onClick={() => setPanelTab(tab)}
            >
              {tr(`coding.panel.${tab}`)}
            </button>
          ))}
        </div>
        <div className={styles.panelBody}>
          {panelTab === 'terminal' ? (
            <div className={styles.terminal}>
              <HanaTerminalView
                output={terminal.output}
                error={terminal.error}
                emptyText={tr('coding.terminal.empty')}
                onFocusRequest={() => terminalInputRef.current?.focus()}
              />
              <div className={styles.terminalInputRow}>
                <select
                  className={styles.terminalProfileSelect}
                  value={terminalProfile}
                  aria-label={tr('coding.terminal.profile')}
                  disabled={terminalIsRunning}
                  onChange={(event) => {
                    const nextProfile = event.currentTarget.value as TerminalProfile;
                    terminalProfileRef.current = nextProfile;
                    setTerminalProfile(nextProfile);
                  }}
                >
                  {TERMINAL_PROFILES.map(profile => (
                    <option key={profile.id} value={profile.id}>{tr(profile.labelKey)}</option>
                  ))}
                </select>
                <textarea
                  ref={terminalInputRef}
                  className={styles.terminalInput}
                  value={terminalInput}
                  placeholder={canUseTerminal ? tr('coding.terminal.placeholder') : tr('coding.terminal.noSession')}
                  disabled={!terminalIsRunning}
                  onChange={(event) => setTerminalInput(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
                      event.preventDefault();
                      void writeTerminalChars('\u0003');
                      return;
                    }
                    if (event.key === 'Enter') {
                      if (event.shiftKey) return;
                      event.preventDefault();
                      void writeTerminal();
                    }
                  }}
                />
                {terminalIsRunning ? (
                  <button type="button" className={styles.terminalButton} onClick={readTerminal}>{tr('coding.terminal.read')}</button>
                ) : (
                  <button type="button" className={styles.terminalButton} onClick={startTerminal} disabled={!canUseTerminal || terminal.loading}>
                    {tr('coding.terminal.start')}
                  </button>
                )}
                <button type="button" className={styles.terminalButton} onClick={closeTerminal} disabled={!terminalIsRunning}>
                  {tr('coding.terminal.close')}
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.panelPlaceholder}>
              <div className={styles.mutedLine}>{tr(`coding.panel.${panelTab}Empty`)}</div>
            </div>
          )}
        </div>
      </section>

      <aside className={styles.assistantPanel} aria-label={tr('coding.labels.assistantPanel')} role="complementary" data-coding-chat-panel="">
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{tr('coding.labels.assistantPanel')}</span>
          <div className={styles.sectionActions}>
            <button
              type="button"
              className={styles.inlineButton}
              onClick={addSelectionToAssistant}
              aria-label={tr('coding.chat.quoteSelection')}
              title={tr('coding.chat.quoteSelectionHint')}
            >
              {tr('coding.chat.quoteSelection')}
            </button>
          </div>
        </div>
        <div className={styles.assistantBody}>
          {renderAssistantSessions()}
          <div className={styles.assistantChatHost}>
            <div className="chat-area has-panels">
              <RegionalErrorBoundary region="coding-chat" resetKeys={[currentSessionPath]}>
                <ChatArea ignoreWelcome />
              </RegionalErrorBoundary>
            </div>
            <div className="input-area">
              <RegionalErrorBoundary region="coding-input" resetKeys={[currentSessionPath]}>
                <InputArea key={currentSessionPath || '__coding_new'} surface="desktop" variant="compact" />
              </RegionalErrorBoundary>
            </div>
          </div>
        </div>
      </aside>
      {projectTemplateDraft && (
        <div className={styles.projectDialogBackdrop} role="presentation">
          <form className={styles.projectDialog} role="dialog" aria-modal="true" aria-labelledby="coding-project-template-title" onSubmit={submitProjectTemplate}>
            <div className={styles.projectDialogHeader}>
              <div>
                <h2 id="coding-project-template-title">{tr('coding.projectTemplate.title')}</h2>
                <p>{activeProjectTemplate ? tr(activeProjectTemplate.descriptionKey) : tr('coding.projectTemplate.description', { template: projectTemplateDraft.templateId })}</p>
              </div>
              <button
                type="button"
                className={styles.projectDialogIconButton}
                aria-label={tr('common.cancel')}
                onClick={() => setProjectTemplateDraft(null)}
                disabled={projectTemplateDraft.busy}
              >
                <Icon name="close" />
              </button>
            </div>
            <div className={styles.projectDialogContent}>
              <div className={styles.projectTemplateList} aria-label={tr('coding.projectTemplate.templateList')}>
                {PROJECT_TEMPLATES.map(template => {
                  const active = template.id === projectTemplateDraft.templateId;
                  return (
                    <button
                      key={template.id}
                      type="button"
                      className={`${styles.projectTemplateCard}${active ? ` ${styles.projectTemplateCardActive}` : ''}`}
                      aria-label={tr(template.titleKey)}
                      aria-pressed={active}
                      onClick={() => setProjectTemplateDraft(prev => prev ? {
                        ...prev,
                        templateId: template.id,
                        projectName: template.id,
                        error: null,
                      } : prev)}
                      disabled={projectTemplateDraft.busy}
                    >
                      <span className={styles.projectTemplateTitle}>{tr(template.titleKey)}</span>
                      <span className={styles.projectTemplateSummary}>{tr(template.summaryKey)}</span>
                    </button>
                  );
                })}
              </div>
              <div className={styles.projectPreviewPane}>
                <div className={styles.projectPreviewHeader}>
                  <span>{tr('coding.projectTemplate.preview')}</span>
                  <span>{activeProjectTemplate ? tr(activeProjectTemplate.titleKey) : '-'}</span>
                </div>
                <ProjectTemplateVisualPreview templateId={projectTemplateDraft.templateId} />
                <div className={styles.projectFileList} aria-label={tr('coding.projectTemplate.files')}>
                  {(activeProjectTemplate?.files || []).map(file => (
                    <span key={file.name}>{file.name}</span>
                  ))}
                </div>
              </div>
            </div>
            <label className={styles.projectDialogField}>
              <span>{tr('coding.projectTemplate.namePrompt')}</span>
              <input
                autoFocus
                value={projectTemplateDraft.projectName}
                onChange={(event) => {
                  const projectName = event.currentTarget.value;
                  setProjectTemplateDraft(prev => prev ? {
                    ...prev,
                    projectName,
                    error: null,
                  } : prev);
                }}
                disabled={projectTemplateDraft.busy}
              />
            </label>
            {projectTemplateDraft.error && (
              <div className={styles.projectDialogError} role="alert">{projectTemplateDraft.error}</div>
            )}
            <div className={styles.projectDialogActions}>
              <button
                type="button"
                className={styles.projectDialogButton}
                onClick={() => setProjectTemplateDraft(null)}
                disabled={projectTemplateDraft.busy}
              >
                {tr('common.cancel')}
              </button>
              <button
                type="submit"
                className={`${styles.projectDialogButton} ${styles.projectDialogPrimary}`}
                disabled={projectTemplateDraft.busy}
              >
                {projectTemplateDraft.busy ? tr('common.loading') : tr('coding.projectTemplate.create')}
              </button>
            </div>
          </form>
        </div>
      )}
      {contextMenu && (
        <ContextMenu
          items={contextMenu.items}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </section>
  );
}
