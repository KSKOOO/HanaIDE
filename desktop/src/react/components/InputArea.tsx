/**
 * InputArea — 聊天输入区域 React 组件
 *
 * 子组件拆分到 ./input/ 目录。
 * 斜杠命令逻辑在 ./input/slash-commands.ts。
 */

import { useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useStore } from '../stores';
import { selectPreviewItems, selectActiveTabId } from '../stores/preview-slice';
import { sessionScopedListIncludes, sessionScopedValue } from '../stores/session-slice';
import { isSessionCompacting } from '../stores/context-slice';
import { selectSessionFiles } from '../stores/selectors/file-refs';
import { isImageFile, isVideoFile } from '../utils/format';
import { isAudioFileName } from '../utils/file-kind';
import { useI18n } from '../hooks/use-i18n';
import { continueDeletedAgentSession, ensureSession, loadSessions } from '../stores/session-actions';
import { revealDeskDirectory, toggleJianSidebar } from '../stores/desk-actions';
import { getWebSocket } from '../services/websocket';
import { collectUiContext } from '../utils/ui-context';
import { formatQuotedSelectionForPrompt } from '../utils/quoted-selection';
import { renderMarkdown } from '../utils/markdown';
import { getModelThinkingLevels, type ThinkingLevel } from '../stores/model-slice';
import { SlashCommandMenu } from './input/SlashCommandMenu';
import { FileMentionMenu } from './input/FileMentionMenu';
import { InputStatusBars } from './input/InputStatusBars';
import { InputContextRow } from './input/InputContextRow';
import { InputControlBar } from './input/InputControlBar';
import type { PermissionMode } from './input/PlanModeButton';
import { SessionConfirmationPrompt } from './input/SessionConfirmationPrompt';
import { CapabilityDriftNotice } from './input/CapabilityDriftNotice';
import { serializeEditor } from '../utils/editor-serializer';
import {
  buildFileMentionItems,
  mergeEditorFileRefs,
  type FileMentionItem,
} from '../utils/file-mention-items';
import { useSkillSlashItems } from '../hooks/use-slash-items';
import { notifyPasteUploadFailure } from '../utils/paste-upload-feedback';
import { extractPlainUrlPaste } from '../utils/plain-url-paste';
import { createInputEditorExtensions } from './input/input-editor-extensions';
import {
  evaluateChatImageSendPreflight,
  evaluateChatAudioSendPreflight,
  evaluateChatVideoSendPreflight,
  getModelAudioInputMode,
  notifyTextModelImageFileOnly,
  notifyTextModelAudioBlocked,
  notifyTextModelVideoFileOnly,
} from '../utils/chat-image-send-preflight';
import { openProviderModelSettings } from '../utils/model-settings-navigation';
import { shouldShowThinkingControl } from '../utils/model-thinking';
import { shouldAllowInputFocus } from '../utils/input-focus-policy';
import { calculateInputCardBottomInset, parseCssPixels } from '../utils/input-card-layout';
import { buildWaveformFromBlob, buildWaveformFromPcmChunks } from '../utils/audio-waveform';
import { prepareChatImageUpload } from '../utils/chat-image-upload-compression';
import { optimizeCodingPrompt } from '../utils/prompt-optimizer';
import {
  XING_PROMPT, executeDiary, executeCompact, buildSlashCommands, getSlashMatches,
  resolveSlashSubmitSelection,
  type SlashItem,
} from './input/slash-commands';
import { attachFilesFromPaths } from '../MainContent';
import { hanaFetch } from '../hooks/use-hana-fetch';
import styles from './input/InputArea.module.css';
import type { ChatListItem, SessionConfirmationBlock } from '../stores/chat-types';
import type { AudioWaveform } from '../stores/chat-types';

const EMPTY_FILE_REFS: readonly import('../types/file-ref').FileRef[] = Object.freeze([]);

function chatVideoMimeTypeForName(name: string, fallback?: string): string {
  if (fallback?.startsWith('video/')) return fallback;
  const ext = name.toLowerCase().replace(/^.*\./, '');
  const mimeMap: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
  };
  return mimeMap[ext] || 'video/mp4';
}

function chatImageMimeTypeForName(name: string, fallback?: string): string {
  if (fallback?.startsWith('image/')) return fallback;
  const ext = name.toLowerCase().replace(/^.*\./, '');
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
  };
  return mimeMap[ext] || 'image/png';
}

function chatAudioMimeTypeForName(name: string, fallback?: string): string {
  if (fallback?.startsWith('audio/')) return fallback;
  const ext = name.toLowerCase().replace(/^.*\./, '');
  const mimeMap: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    weba: 'audio/webm',
    webm: 'audio/webm',
  };
  return mimeMap[ext] || 'audio/wav';
}

function createClientUserMessageId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `client-user-${uuid}`;
  return `client-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readFileAsBase64(file: File): Promise<string> {
  return readBlobAsBase64(file);
}

async function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.readAsDataURL(blob);
  });
}

function mergeFloat32Chunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function encodeWavBlob(chunks: Float32Array[], sampleRate: number): Blob {
  const samples = mergeFloat32Chunks(chunks);
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }
  return new Blob([view], { type: 'audio/wav' });
}

function formatRecordingElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

interface AudioRecorderRuntime {
  stream: MediaStream;
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  silentGain: GainNode;
  chunks: Float32Array[];
  sampleRate: number;
}

function disposeAudioRecorderRuntime(runtime: AudioRecorderRuntime): void {
  try { runtime.processor.disconnect(); } catch {}
  try { runtime.source.disconnect(); } catch {}
  try { runtime.silentGain.disconnect(); } catch {}
  for (const track of runtime.stream.getTracks()) {
    try { track.stop(); } catch {}
  }
  if (runtime.audioContext.state !== 'closed') {
    void runtime.audioContext.close().catch(() => {});
  }
}

interface FileMentionRange {
  from: number;
  to: number;
  query: string;
}

interface InputKeyEvent {
  key: string;
  shiftKey: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  preventDefault: () => void;
}

function findLatestInputSessionConfirmation(items: ChatListItem[] | undefined, confirmId?: string, pendingOnly?: boolean): SessionConfirmationBlock | null {
  if (!items) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type !== 'message' || item.data.role !== 'assistant') continue;
    const blocks = item.data.blocks || [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j];
      if (block.type !== 'session_confirmation' || block.surface !== 'input') continue;
      if (confirmId && block.confirmId !== confirmId) continue;
      if (pendingOnly && block.status !== 'pending') continue;
      return block;
    }
  }
  return null;
}

function findFileMentionRange(editor: Editor | null): FileMentionRange | null {
  if (!editor?.state?.selection) return null;
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const before = selection.$from.parent.textBetween(0, selection.$from.parentOffset, '\n', '\n');
  const atIndex = before.lastIndexOf('@');
  if (atIndex < 0) return null;
  if (atIndex > 0 && /\S/.test(before[atIndex - 1])) return null;
  const query = before.slice(atIndex + 1);
  if (/[\s@]/.test(query)) return null;
  return {
    from: selection.from - query.length - 1,
    to: selection.from,
    query,
  };
}

function editorHasInlineNode(editor: Editor | null, nodeType: string): boolean {
  if (!editor?.state?.doc) return false;
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === nodeType) {
      found = true;
      return false;
    }
    return !found;
  });
  return found;
}

function setEditorPlainText(editor: Editor, text: string, emitUpdate = true): void {
  if (!text) {
    editor.commands.setContent('', { emitUpdate });
    return;
  }
  editor.commands.setContent({
    type: 'doc',
    content: text.split('\n').map(line => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  }, { emitUpdate });
}

export type { SlashItem };

// ── 主组件 ──

export interface InputAreaProps {
  surface?: 'desktop' | 'mobile';
  variant?: 'default' | 'compact';
}

export function InputArea({ surface = 'desktop', variant = 'default' }: InputAreaProps = {}) {
  return <InputAreaInner surface={surface} variant={variant} />;
}

function InputAreaInner({ surface, variant }: Required<InputAreaProps>) {
  const { t, locale } = useI18n();

  // Zustand state
  const isStreaming = useStore(s => sessionScopedListIncludes(s, s.streamingSessions, s.currentSessionPath));
  const connected = useStore(s => s.connected);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const pendingSessionSwitchPath = useStore(s => s.pendingSessionSwitchPath);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const currentAgentId = useStore(s => s.currentAgentId);
  const selectedAgentId = useStore(s => s.selectedAgentId);
  const currentSessionProjection = useStore(s => s.currentSessionPath
    ? s.sessions.find(session => session.path === s.currentSessionPath)
    : null);
  const deletedAgentReadOnly = currentSessionProjection?.agentDeleted === true;
  const compacting = useStore(s => isSessionCompacting(s, currentSessionPath));
  const screenshotBusy = useStore(s => s.screenshotTaskCount > 0);
  const screenshotProgress = useStore(s => s.screenshotProgress);
  const inlineError = useStore(s => s.currentSessionPath ? (sessionScopedValue(s, s.inlineErrors, s.currentSessionPath) ?? null) : null);
  const sessionFiles = useStore(s => (s.currentSessionPath ? selectSessionFiles(s, s.currentSessionPath) : EMPTY_FILE_REFS));
  const attachedFiles = useStore(s => s.attachedFiles);
  const docContextAttached = useStore(s => s.docContextAttached);
  const quotedSelections = useStore(s => s.quotedSelections);
  const deskFiles = useStore(s => s.deskFiles);
  const deskBasePath = useStore(s => s.deskBasePath);
  const previewItems = useStore(selectPreviewItems);
  const activeTabId = useStore(selectActiveTabId);
  const previewOpen = useStore(s => s.previewOpen);
  const models = useStore(s => s.models);
  const agentYuan = useStore(s => s.agentYuan);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const thinkingLevel = useStore(s => s.thinkingLevel);
  const setThinkingLevel = useStore(s => s.setThinkingLevel);
  const addToast = useStore(s => s.addToast);
  const removeToast = useStore(s => s.removeToast);

  const globalModelInfo = useMemo(() => models.find(m => m.isCurrent), [models]);
  const sessionModel = useStore(s => s.currentSessionPath ? sessionScopedValue(s, s.sessionModelsByPath, s.currentSessionPath) : undefined);
  const sessionModelInfo = useMemo(() => {
    if (!sessionModel) return undefined;
    const full = models.find(m => m.id === sessionModel.id && m.provider === sessionModel.provider);
    return full ? { ...full, ...sessionModel } : sessionModel;
  }, [models, sessionModel]);
  // #1624：当前 session 的工具能力漂移提示（服务端 restore 时算好，前端只消费）
  const capabilityDrift = useStore(s => s.currentSessionPath ? (sessionScopedValue(s, s.capabilityDriftBySession, s.currentSessionPath) ?? null) : null);
  const capabilityRefreshing = useStore(s => sessionScopedListIncludes(s, s.capabilityRefreshingSessions, s.currentSessionPath));
  const compactingStatus = capabilityRefreshing || compacting;
  const compactingStatusLabel = capabilityRefreshing
    ? t('session.capabilityDrift.refreshing')
    : t('chat.compacting');
  const currentModelInfo = sessionModelInfo || globalModelInfo;
  const availableThinkingLevels = useMemo(
    () => getModelThinkingLevels(currentModelInfo),
    [currentModelInfo],
  );
  // input 数组缺失视为未知；只有显式 text-only 的模型才在 UI 上标记“辅助视觉”。
  const supportsVision = !Array.isArray(currentModelInfo?.input) || currentModelInfo.input.includes("image");
  const showAudioInput = getModelAudioInputMode(currentModelInfo) === 'native-audio';
  const showThinkingControl = useMemo(
    () => shouldShowThinkingControl(currentModelInfo, models),
    [currentModelInfo, models],
  );
  const modelSwitching = useStore(s => s.modelSwitching);
  const currentSessionItems = useStore(s => s.currentSessionPath ? sessionScopedValue(s, s.chatSessions, s.currentSessionPath)?.items : undefined);
  const storedSessionConfirmation = useStore(s => s.currentSessionPath
    ? sessionScopedValue(s, s.pendingSessionConfirmationsByPath, s.currentSessionPath) || null
    : null);
  const pendingSessionConfirmation = useMemo(() => {
    return findLatestInputSessionConfirmation(currentSessionItems, undefined, true)
      || storedSessionConfirmation;
  }, [currentSessionItems, storedSessionConfirmation]);

  // Local state
  const permissionMode = useStore(s => s.sessionPermissionMode);
  const setPermissionMode = useStore(s => s.setSessionPermissionMode);
  const [sending, setSending] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelected, setSlashSelected] = useState(0);
  const [slashBusy, setSlashBusy] = useState<string | null>(null);
  const [slashResult, setSlashResult] = useState<{ text: string; type: 'success' | 'error'; deskDir?: string; filePath?: string } | null>(null);
  const [visibleSessionConfirmation, setVisibleSessionConfirmation] = useState<SessionConfirmationBlock | null>(null);
  const [sessionConfirmationExiting, setSessionConfirmationExiting] = useState(false);

  const isComposing = useRef(false);
  const pasteHandlerRef = useRef<(event: ClipboardEvent) => boolean>(() => false);
  const keyDownHandlerRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const beforeInputHandlerRef = useRef<(event: InputEvent) => boolean>(() => false);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const slashBtnRef = useRef<HTMLButtonElement>(null);
  const browserFileInputRef = useRef<HTMLInputElement>(null);
  const slashDismissedTextRef = useRef<string | null>(null);
  const inputSurfaceRef = useRef<HTMLDivElement>(null);
  const inputCardRef = useRef<HTMLDivElement>(null);
  const focusFrameRef = useRef<number | null>(null);
  const audioRecorderRef = useRef<AudioRecorderRuntime | null>(null);
  const audioRecordingSeqRef = useRef(0);
  const [inputText, setInputText] = useState('');
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [fileSelected, setFileSelected] = useState(0);
  const [fileMentionRange, setFileMentionRange] = useState<FileMentionRange | null>(null);
  const [fileMentionQuery, setFileMentionQuery] = useState('');
  const [fileMentionBusy] = useState(false);
  const [continuingDeletedAgentSession, setContinuingDeletedAgentSession] = useState(false);
  const [deletedAgentContinueError, setDeletedAgentContinueError] = useState<string | null>(null);
  const [audioRecorderOpen, setAudioRecorderOpen] = useState(false);
  const [audioRecordingState, setAudioRecordingState] = useState<'idle' | 'starting' | 'recording' | 'stopping'>('idle');
  const [audioRecordingStartedAt, setAudioRecordingStartedAt] = useState<number | null>(null);
  const [audioRecordingElapsed, setAudioRecordingElapsed] = useState(0);
  const [audioRecordingError, setAudioRecordingError] = useState<string | null>(null);
  const inputLocked = deletedAgentReadOnly || continuingDeletedAgentSession;

  useEffect(() => {
    setContinuingDeletedAgentSession(false);
    setDeletedAgentContinueError(null);
  }, [currentSessionPath]);

  useEffect(() => {
    if (pendingSessionConfirmation) {
      setVisibleSessionConfirmation(pendingSessionConfirmation);
      setSessionConfirmationExiting(false);
      return;
    }
    if (!visibleSessionConfirmation || sessionConfirmationExiting) return;

    const resolved = findLatestInputSessionConfirmation(currentSessionItems, visibleSessionConfirmation.confirmId);
    setVisibleSessionConfirmation(resolved || visibleSessionConfirmation);
    setSessionConfirmationExiting(true);
  }, [currentSessionItems, pendingSessionConfirmation, sessionConfirmationExiting, visibleSessionConfirmation]);

  useEffect(() => {
    if (!sessionConfirmationExiting) return;
    const timer = window.setTimeout(() => {
      setVisibleSessionConfirmation(null);
      setSessionConfirmationExiting(false);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [sessionConfirmationExiting]);

  // ── 全局 inline notice（截图等非斜杠命令的轻提示）──
  useEffect(() => {
    const handler = (e: Event) => {
      const { text, type, deskDir, filePath } = (e as CustomEvent).detail;
      setSlashResult({ text, type, deskDir, filePath });
      setTimeout(() => setSlashResult(null), 3000);
    };
    window.addEventListener('hana-inline-notice', handler);
    return () => window.removeEventListener('hana-inline-notice', handler);
  }, []);

  // ── Welcome 模式 placeholder tip（mount、i18n ready、每次 welcome 重新激活时随机一条） ──
  const pickRandomWelcomeTip = useCallback((): string => {
    const tipsRaw: unknown = t('welcome.placeholderTips');
    const tips = Array.isArray(tipsRaw)
      ? tipsRaw.filter((tip): tip is string => typeof tip === 'string' && tip.length > 0)
      : [];
    if (tips.length === 0) return '';
    return tips[Math.floor(Math.random() * tips.length)];
  }, [t]);

  const [welcomeTip, setWelcomeTip] = useState<string>(() =>
    welcomeVisible ? pickRandomWelcomeTip() : '',
  );

  // Zustand actions
  const addAttachedFile = useStore(s => s.addAttachedFile);
  const removeAttachedFile = useStore(s => s.removeAttachedFile);
  const clearAttachedFiles = useStore(s => s.clearAttachedFiles);
  const setDocContextAttached = useStore(s => s.setDocContextAttached);
  const setDraft = useStore(s => s.setDraft);
  const clearDraft = useStore(s => s.clearDraft);

  const prevWelcomeVisibleRef = useRef(welcomeVisible);
  const prevLocaleRef = useRef(locale);
  useEffect(() => {
    const wasVisible = prevWelcomeVisibleRef.current;
    const previousLocale = prevLocaleRef.current;
    prevWelcomeVisibleRef.current = welcomeVisible;
    prevLocaleRef.current = locale;

    if (!welcomeVisible) {
      if (welcomeTip) setWelcomeTip('');
      return;
    }

    // false→true（重新进入欢迎页）、locale ready/切换，或 mount 时 i18n 还没 ready 现在能拿到
    if (!wasVisible || previousLocale !== locale || !welcomeTip) {
      const tip = pickRandomWelcomeTip();
      if (tip) setWelcomeTip(tip);
    }
  }, [welcomeVisible, locale, welcomeTip, pickRandomWelcomeTip]);

  // ── Placeholder ──
  const placeholderRef = useRef('');
  const getEditorPlaceholder = useCallback(() => placeholderRef.current, []);
  const placeholder = (() => {
    if (welcomeVisible && welcomeTip) return welcomeTip;
    const yuanPh = t(`yuan.placeholder.${agentYuan}`);
    return (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : t('input.placeholder');
  })();
  placeholderRef.current = placeholder;

  // ── TipTap editor ──
  const editor = useEditor({
    // Mobile PWA cold starts can race editor DOM creation with the first render.
    // Create the editor after mount there; keep desktop's immediate path unchanged.
    immediatelyRender: surface !== 'mobile',
    extensions: createInputEditorExtensions(getEditorPlaceholder),
    editorProps: {
      attributes: {
        class: styles['input-box'],
        id: 'inputBox',
        spellcheck: 'false',
      },
      handlePaste: (_view, event) => pasteHandlerRef.current(event),
      handleKeyDown: (_view, event) => keyDownHandlerRef.current(event),
      handleDOMEvents: {
        beforeinput: (_view, event) => beforeInputHandlerRef.current(event as InputEvent),
      },
    },
  });

  useEffect(() => {
    editor?.setEditable?.(!inputLocked);
    if (inputLocked) {
      setSlashMenuOpen(false);
      setFileMenuOpen(false);
    }
  }, [editor, inputLocked]);

  const restoreEditorFocus = useCallback(() => {
    if (!editor || editor.isDestroyed) return;
    if (inputLocked) return;
    if (!shouldAllowInputFocus({ inputRoot: inputSurfaceRef.current })) return;

    const run = () => {
      focusFrameRef.current = null;
      if (!editor || editor.isDestroyed) return;
      if (!shouldAllowInputFocus({ inputRoot: inputSurfaceRef.current })) return;
      editor.commands.focus();
    };

    if (typeof window.requestAnimationFrame === 'function') {
      if (focusFrameRef.current !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
      focusFrameRef.current = window.requestAnimationFrame(run);
      return;
    }

    window.setTimeout(run, 0);
  }, [editor, inputLocked]);

  useEffect(() => {
    return () => {
      if (focusFrameRef.current !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
      focusFrameRef.current = null;
    };
  }, []);

  useEffect(() => {
    const surface = inputSurfaceRef.current;
    const card = inputCardRef.current;
    const editorElement = editor?.view.dom;
    const parent = card?.closest('.main-content') as HTMLElement | null;
    if (!surface || !card || !editorElement || !parent) return;

    const updateMetrics = () => {
      const editorStyle = window.getComputedStyle(editorElement);
      const editorFontSize = parseCssPixels(editorStyle.fontSize, 16);
      const editorLineHeight = parseCssPixels(editorStyle.lineHeight, editorFontSize * 1.6);
      const cardRect = card.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const cardHeight = cardRect.height || card.offsetHeight;
      const editorHeight = editorElement.getBoundingClientRect().height || editorElement.offsetHeight;
      const upperChromeHeight = Math.max(0, cardRect.top - surfaceRect.top);
      const bottomInset = calculateInputCardBottomInset({
        cardHeight,
        editorHeight,
        editorLineHeight,
        upperChromeHeight,
      });

      parent.style.setProperty('--input-card-h', `${cardHeight}px`);
      parent.style.setProperty('--input-card-bottom-inset', `${bottomInset}px`);
    };

    updateMetrics();

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        parent.style.removeProperty('--input-card-h');
        parent.style.removeProperty('--input-card-bottom-inset');
      };
    }

    const observer = new ResizeObserver(updateMetrics);
    observer.observe(surface);
    observer.observe(card);
    observer.observe(editorElement);

    return () => {
      observer.disconnect();
      parent.style.removeProperty('--input-card-h');
      parent.style.removeProperty('--input-card-bottom-inset');
    };
  }, [editor]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta('input-placeholder-refresh', placeholder));
  }, [editor, placeholder]);

  // Focus trigger from store
  const inputFocusTrigger = useStore(s => s.inputFocusTrigger);
  useEffect(() => {
    if (inputFocusTrigger > 0) restoreEditorFocus();
  }, [inputFocusTrigger, restoreEditorFocus]);

  useEffect(() => {
    if (surface !== 'desktop') return;
    const handleWindowFocus = () => restoreEditorFocus();
    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, [restoreEditorFocus, surface]);

  // Doc context
  const currentDoc = useMemo(() => {
    if (!previewOpen || !activeTabId) return null;
    const art = previewItems.find(a => a.id === activeTabId);
    if (!art?.filePath) return null;
    return { path: art.filePath, name: art.title || art.filePath.split('/').pop() || '' };
  }, [previewOpen, activeTabId, previewItems]);
  const hasDoc = !!currentDoc;

  // doc 消失时同步清 attach，避免悬空的 docContextAttached 干扰 hasContent / 发送态
  useEffect(() => {
    if (!hasDoc && docContextAttached) setDocContextAttached(false);
  }, [hasDoc, docContextAttached, setDocContextAttached]);

  // ── 统一命令发送 ──

  const sendAsUser = useCallback(async (text: string, displayText?: string): Promise<boolean> => {
    if (inputLocked) return false;
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const _s = useStore.getState();
    if (sessionScopedListIncludes(_s, _s.streamingSessions, _s.currentSessionPath)) return false;
    if (_s.pendingSessionSwitchPath) return false;

    if (pendingNewSession) {
      const ok = await ensureSession();
      if (!ok) return false;
      loadSessions();
    }

    ws.send(JSON.stringify({
      type: 'prompt',
      text,
      sessionPath: useStore.getState().currentSessionPath,
      uiContext: collectUiContext(useStore.getState()),
      displayMessage: { text: displayText ?? text },
    }));
    return true;
  }, [inputLocked, pendingNewSession]);

  // ── 斜杠命令 ──

  const diaryFn = useCallback(() => {
    executeDiary(t, addToast, removeToast, () => { editor?.commands.clearContent(); }, setSlashMenuOpen)();
  }, [t, addToast, removeToast, editor]);
  const xingFn = useCallback(async () => {
    editor?.commands.clearContent();
    setSlashMenuOpen(false);
    await sendAsUser(XING_PROMPT);
  }, [sendAsUser, editor]);
  const compactFn = useCallback(async () => {
    await executeCompact(setSlashBusy, () => { editor?.commands.clearContent(); }, setSlashMenuOpen)();
  }, [editor]);

  const slashAgentId = pendingNewSession ? (selectedAgentId || currentAgentId) : currentAgentId;
  const skillItems = useSkillSlashItems({ enabled: surface !== 'mobile', agentId: slashAgentId });

  // 注：/stop /new /reset 仅走 bridge 平台（TG/Feishu/...）；桌面端有 GUI，菜单不暴露这些命令。
  // buildSlashCommands 第 5 参留作未来 web/mobile 端需要时再注入。后端 WS 通道 (type:'slash')
  // 和 REST /api/commands 保留作扩展面，不影响现有桌面 UX。
  const slashCommands = useMemo(
    () => [...buildSlashCommands(t, diaryFn, xingFn, compactFn), ...skillItems],
    [diaryFn, xingFn, compactFn, t, skillItems],
  );

  const filteredCommands = useMemo(() => {
    if (!inputText.startsWith('/')) return slashCommands;
    return getSlashMatches(inputText, slashCommands);
  }, [inputText, slashCommands]);

  useEffect(() => {
    setSlashSelected(index => Math.min(index, Math.max(filteredCommands.length - 1, 0)));
  }, [filteredCommands.length]);

  const fileMentionItems = useMemo(() => buildFileMentionItems({
    query: fileMentionQuery,
    attachedFiles,
    sessionFiles,
    deskFiles,
    deskBasePath,
    deskCurrentPath: '',
    searchResults: [],
  }), [
    attachedFiles,
    deskBasePath,
    deskFiles,
    fileMentionQuery,
    sessionFiles,
  ]);

  const dismissSlashMenu = useCallback(() => {
    const text = editor?.getText().trim() ?? inputText.trim();
    slashDismissedTextRef.current = text.startsWith('/') ? text : null;
    setSlashMenuOpen(false);
  }, [editor, inputText]);

  const openSlashMenu = useCallback(() => {
    slashDismissedTextRef.current = null;
    setSlashMenuOpen(true);
  }, []);

  useEffect(() => {
    if (fileSelected < fileMentionItems.length) return;
    setFileSelected(Math.max(0, fileMentionItems.length - 1));
  }, [fileMentionItems.length, fileSelected]);

  const handleSlashToggle = useCallback(() => {
    if (slashMenuOpen) dismissSlashMenu();
    else openSlashMenu();
  }, [slashMenuOpen, dismissSlashMenu, openSlashMenu]);

  const handleBrowserFileInputChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    if (inputLocked) {
      event.currentTarget.value = '';
      return;
    }
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = '';
    try {
      if (files.length === 0) return;
      if (useStore.getState().attachedFiles.length >= 9) return;

      for (const file of files) {
        if (useStore.getState().attachedFiles.length >= 9) break;
        const mimeType = file.type || (isAudioFileName(file.name) ? chatAudioMimeTypeForName(file.name) : chatImageMimeTypeForName(file.name));
        try {
          const base64Data = await readFileAsBase64(file);
          const uploadPayload = mimeType.startsWith('image/')
            ? await prepareChatImageUpload({
              file,
              name: file.name,
              base64Data,
              mimeType,
            })
            : {
              name: file.name,
              base64Data,
              mimeType,
              compressed: false,
            };
          const waveform = mimeType.startsWith('audio/')
            ? await buildWaveformFromBlob(file).catch((err) => {
              console.warn('[upload] failed to compute audio waveform', err);
              return undefined;
            })
            : undefined;
          const res = await hanaFetch('/api/upload-blob', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: uploadPayload.name,
              base64Data: uploadPayload.base64Data,
              mimeType: uploadPayload.mimeType,
              ...(waveform ? { waveform } : {}),
              ...(useStore.getState().currentSessionPath ? { sessionPath: useStore.getState().currentSessionPath } : {}),
            }),
          });
          const data = await res.json();
          const upload = data?.uploads?.[0];
          if (upload?.dest) {
            addAttachedFile({
              fileId: upload.fileId,
              path: upload.dest,
              name: upload.name || uploadPayload.name,
              isDirectory: false,
              base64Data: uploadPayload.base64Data,
              mimeType: uploadPayload.mimeType,
              waveform: upload.waveform || waveform,
            });
          } else {
            useStore.getState().addToast(t('error.uploadFailed'), 'error');
            console.warn('[upload] browser file upload failed', upload?.error || data);
          }
        } catch (err) {
          console.warn('[upload] browser file upload error', err);
          useStore.getState().addToast(t('error.uploadFailed'), 'error');
        }
      }
    } finally {
      restoreEditorFocus();
    }
  }, [addAttachedFile, inputLocked, restoreEditorFocus, t]);

  const handleAttach = useCallback(async () => {
    if (inputLocked) return;
    if (surface === 'mobile') {
      browserFileInputRef.current?.click();
      return;
    }
    if (typeof window.platform?.selectFiles === 'function') {
      try {
        const paths = await window.platform.selectFiles();
        if (paths && paths.length > 0) await attachFilesFromPaths(paths);
      } finally {
        restoreEditorFocus();
      }
      return;
    }
    browserFileInputRef.current?.click();
    window.setTimeout(restoreEditorFocus, 0);
  }, [inputLocked, restoreEditorFocus, surface]);

  const handleOptimizePrompt = useCallback(() => {
    if (!editor || editor.isDestroyed || inputLocked) return;
    const optimized = optimizeCodingPrompt(editor.getText());
    if (!optimized) return;
    setEditorPlainText(editor, optimized, true);
    setInputText(optimized);
    if (currentSessionPath) setDraft(currentSessionPath, optimized);
    restoreEditorFocus();
  }, [currentSessionPath, editor, inputLocked, restoreEditorFocus, setDraft]);

  const ensureVoiceSessionPath = useCallback(async (): Promise<string> => {
    let sessionPath = useStore.getState().currentSessionPath;
    if (sessionPath) return sessionPath;
    if (!pendingNewSession) throw new Error('missing session path');
    const ok = await ensureSession();
    if (!ok) throw new Error('failed to create session');
    loadSessions();
    sessionPath = useStore.getState().currentSessionPath;
    if (!sessionPath) throw new Error('missing session path');
    return sessionPath;
  }, [pendingNewSession]);

  const sendVoiceAudioAttachment = useCallback(async (file: {
    fileId?: string;
    path: string;
    name: string;
    mimeType: string;
    base64Data: string;
    waveform?: AudioWaveform;
  }): Promise<boolean> => {
    if (inputLocked || !connected || isStreaming || sending || modelSwitching || useStore.getState().pendingSessionSwitchPath) {
      return false;
    }

    const audioPreflight = await evaluateChatAudioSendPreflight({
      attachments: [file],
      model: currentModelInfo,
    });
    if (!audioPreflight.ok) {
      notifyTextModelAudioBlocked({
        t,
        addToast: useStore.getState().addToast,
        openSettings: () => openProviderModelSettings(currentModelInfo?.provider),
      });
      return false;
    }

    setSending(true);
    try {
      const sessionPath = await ensureVoiceSessionPath();
      const ws = getWebSocket();
      if (!ws || typeof ws.send !== 'function') {
        throw new Error('websocket unavailable');
      }
      const mimeType = chatAudioMimeTypeForName(file.name, file.mimeType);
      ws.send(JSON.stringify({
        type: 'prompt',
        text: '',
        sessionPath,
        uiContext: collectUiContext(useStore.getState()),
        displayMessage: {
          text: '',
          attachments: [{
            fileId: file.fileId,
            path: file.path,
            name: file.name,
            isDir: false,
            mimeType,
            presentation: 'voice-input',
            listed: false,
            ...(file.waveform ? { waveform: file.waveform } : {}),
          }],
        },
        audios: [{
          type: 'audio',
          data: file.base64Data,
          mimeType,
        }],
      }));
      return true;
    } finally {
      setSending(false);
    }
  }, [
    connected,
    currentModelInfo,
    ensureVoiceSessionPath,
    inputLocked,
    isStreaming,
    modelSwitching,
    sending,
    t,
  ]);

  const stopAudioRecording = useCallback(async ({ discard = false }: { discard?: boolean } = {}) => {
    const runtime = audioRecorderRef.current;
    if (!runtime) {
      setAudioRecordingState('idle');
      setAudioRecordingStartedAt(null);
      setAudioRecordingElapsed(0);
      return;
    }

    audioRecorderRef.current = null;
    setAudioRecordingState(discard ? 'idle' : 'stopping');
    setAudioRecordingStartedAt(null);

    const chunks = runtime.chunks.slice();
    const sampleRate = runtime.sampleRate;
    disposeAudioRecorderRuntime(runtime);

    if (discard) {
      setAudioRecordingElapsed(0);
      return;
    }

    try {
      if (chunks.length === 0) {
        throw new Error('empty audio recording');
      }
      const blob = encodeWavBlob(chunks, sampleRate);
      if (blob.size <= 44) {
        throw new Error('empty audio recording');
      }
      const base64Data = await readBlobAsBase64(blob);
      const waveform = buildWaveformFromPcmChunks(chunks, sampleRate);
      const index = audioRecordingSeqRef.current + 1;
      audioRecordingSeqRef.current = index;
      const name = t('input.recordedAudioName', { index });
      const sessionPath = await ensureVoiceSessionPath();
      const res = await hanaFetch('/api/upload-blob', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          base64Data,
          mimeType: 'audio/wav',
          sessionPath,
          presentation: 'voice-input',
          ...(waveform ? { waveform } : {}),
        }),
      });
      const data = await res.json();
      const upload = data?.uploads?.[0];
      if (!upload?.dest) {
        throw new Error(upload?.error || 'audio upload failed');
      }
      const sent = await sendVoiceAudioAttachment({
        fileId: upload.fileId,
        path: upload.dest,
        name: upload.name || name,
        mimeType: 'audio/wav',
        base64Data,
        waveform: upload.waveform || waveform,
      });
      if (!sent) {
        throw new Error('audio send failed');
      }
      setAudioRecorderOpen(false);
      setAudioRecordingError(null);
    } catch (err) {
      const message = t('input.audioRecordingFailed');
      setAudioRecordingError(message);
      addToast(message, 'error', 6000);
      console.warn('[input] failed to finalize audio recording', err);
    } finally {
      setAudioRecordingState('idle');
      setAudioRecordingElapsed(0);
      restoreEditorFocus();
    }
  }, [addToast, ensureVoiceSessionPath, restoreEditorFocus, sendVoiceAudioAttachment, t]);

  const startAudioRecording = useCallback(async () => {
    if (inputLocked || !showAudioInput || !connected || isStreaming || sending || modelSwitching || pendingSessionSwitchPath) return;
    if (audioRecordingState !== 'idle' || audioRecorderRef.current) return;
    const AudioContextCtor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextCtor) {
      const message = t('input.audioRecordingUnavailable');
      setAudioRecorderOpen(true);
      setAudioRecordingError(message);
      addToast(message, 'error', 6000);
      return;
    }

    setAudioRecorderOpen(true);
    setAudioRecordingError(null);
    setAudioRecordingState('starting');

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const silentGain = audioContext.createGain();
      const chunks: Float32Array[] = [];
      silentGain.gain.value = 0;
      processor.onaudioprocess = (event) => {
        if (!audioRecorderRef.current) return;
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
      audioRecorderRef.current = {
        stream,
        audioContext,
        source,
        processor,
        silentGain,
        chunks,
        sampleRate: audioContext.sampleRate,
      };
      setAudioRecordingStartedAt(Date.now());
      setAudioRecordingElapsed(0);
      setAudioRecordingState('recording');
    } catch (err) {
      if (stream) {
        for (const track of stream.getTracks()) {
          try { track.stop(); } catch {}
        }
      }
      const message = t('input.audioRecordingFailed');
      setAudioRecordingState('idle');
      setAudioRecordingStartedAt(null);
      setAudioRecordingError(message);
      addToast(message, 'error', 6000);
      console.warn('[input] failed to start audio recording', err);
    }
  }, [
    addToast,
    audioRecordingState,
    connected,
    inputLocked,
    isStreaming,
    modelSwitching,
    pendingSessionSwitchPath,
    sending,
    showAudioInput,
    t,
  ]);

  const handleAudioRecordToggle = useCallback(() => {
    if (audioRecordingState === 'recording') {
      void stopAudioRecording();
      return;
    }
    if (audioRecordingState === 'idle') {
      void startAudioRecording();
    }
  }, [audioRecordingState, startAudioRecording, stopAudioRecording]);

  const canUseVoiceShortcut = useCallback(() => {
    if (surface !== 'desktop') return false;
    if (!showAudioInput) return false;
    if (inputLocked || modelSwitching) return false;
    if (typeof document !== 'undefined' && !document.hasFocus()) return false;
    const state = useStore.getState() as Record<string, any>;
    if (state.currentTab !== 'chat') return false;
    if (state.pendingSessionSwitchPath) return false;
    if (state.settingsModal?.open || state.mediaViewer || state.skillViewerData || state.channelCreateOverlayVisible) {
      return false;
    }
    return true;
  }, [inputLocked, modelSwitching, showAudioInput, surface]);

  useEffect(() => {
    if (surface !== 'desktop') return undefined;
    const handleVoiceShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || !event.shiftKey || event.altKey || key !== 'm') return;
      if (!canUseVoiceShortcut()) return;
      event.preventDefault();
      handleAudioRecordToggle();
    };
    window.addEventListener('keydown', handleVoiceShortcut);
    return () => window.removeEventListener('keydown', handleVoiceShortcut);
  }, [canUseVoiceShortcut, handleAudioRecordToggle, surface]);

  useEffect(() => {
    if (audioRecordingState !== 'recording' || !audioRecordingStartedAt) return undefined;
    const updateElapsed = () => setAudioRecordingElapsed(Date.now() - audioRecordingStartedAt);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [audioRecordingStartedAt, audioRecordingState]);

  useEffect(() => {
    if (showAudioInput || audioRecordingState === 'idle') return undefined;
    void stopAudioRecording({ discard: true });
    setAudioRecorderOpen(false);
    return undefined;
  }, [audioRecordingState, showAudioInput, stopAudioRecording]);

  useEffect(() => {
    return () => {
      const runtime = audioRecorderRef.current;
      if (!runtime) return;
      audioRecorderRef.current = null;
      disposeAudioRecorderRuntime(runtime);
    };
  }, []);

  // Sync editor text to React state (drives hasInput / canSend) + slash menu detection + draft save
  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      const text = editor.getText();
      setInputText(text);
      if (slashDismissedTextRef.current && slashDismissedTextRef.current !== text.trim()) {
        slashDismissedTextRef.current = null;
      }
      const slashMatches = getSlashMatches(text, slashCommands);
      const fileMention = findFileMentionRange(editor);
      if (fileMention) {
        setFileMentionRange(fileMention);
        setFileMentionQuery(fileMention.query);
        setFileMenuOpen(true);
        setFileSelected(0);
        setSlashMenuOpen(false);
      } else {
        setFileMenuOpen(false);
        setFileMentionRange(null);
        setFileMentionQuery('');
      }
      if (!fileMention && slashMatches.length > 0 && slashDismissedTextRef.current !== text.trim()) {
        setSlashMenuOpen(true);
        setSlashSelected(0);
      } else {
        setSlashMenuOpen(false);
      }
      // 保存草稿到 store
      if (currentSessionPath) {
        setDraft(currentSessionPath, text);
      }
      // 内容超出可见区域时，自动滚动到光标位置
      requestAnimationFrame(() => editor.commands.scrollIntoView());
    };
    editor.on('update', handler);
    return () => { editor.off('update', handler); };
  }, [editor, currentSessionPath, setDraft, slashCommands]);

  // 切换 session 时恢复草稿
  useEffect(() => {
    if (!editor || !currentSessionPath) return;
    const state = useStore.getState();
    const draft = sessionScopedValue(state, state.drafts, currentSessionPath) || '';
    const current = editor.getText();
    if (draft !== current) {
      if (!draft) {
        editor.commands.setContent('', { emitUpdate: false });
      } else {
        const doc = {
          type: 'doc' as const,
          content: draft.split('\n').map(line => ({
            type: 'paragraph' as const,
            content: line ? [{ type: 'text' as const, text: line }] : [],
          })),
        };
        editor.commands.setContent(doc, { emitUpdate: false });
      }
    }
  }, [editor, currentSessionPath]);

  // 点击外部关闭斜杠菜单
  useEffect(() => {
    if (!slashMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (slashMenuRef.current?.contains(e.target as Node)) return;
      if (slashBtnRef.current?.contains(e.target as Node)) return;
      dismissSlashMenu();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dismissSlashMenu, slashMenuOpen]);

  useEffect(() => {
    if (!fileMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (fileMenuRef.current?.contains(e.target as Node)) return;
      setFileMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [fileMenuOpen]);

  // Can send?
  const hasContent = inputText.trim().length > 0 || attachedFiles.length > 0 || docContextAttached || quotedSelections.length > 0
    || editorHasInlineNode(editor, 'skillBadge')
    || editorHasInlineNode(editor, 'fileBadge');
  // capabilityRefreshing / compacting：压缩到 reload 完成之间 session 没有可用
  // runtime，此窗口内发 prompt 会冷建第二个 runtime 与 reload 竞争（#1624 I2）。
  const canSend = hasContent && connected && !isStreaming && !modelSwitching && !pendingSessionSwitchPath && !inputLocked
    && !capabilityRefreshing && !compacting;

  const loadVisionAuxiliaryConfig = useCallback(async () => {
    if (surface === 'mobile') {
      const res = await hanaFetch('/api/models/auxiliary-vision');
      const data = await res.json();
      const auxiliaryVision = data?.auxiliaryVision;
      return {
        enabled: auxiliaryVision?.available === true,
        model: auxiliaryVision?.model || null,
      };
    }
    const res = await hanaFetch('/api/preferences/models');
    const data = await res.json();
    return {
      enabled: data?.models?.vision_enabled === true,
      model: data?.models?.vision || null,
    };
  }, [surface]);

  // ── Paste attachments ──
  // 剪贴板里能解析出文件系统路径的 file item 直接复用拖拽附件注册。
  // 无路径图片 blob 才上传到 session-files，入 store 时保持 path-backed 附件形态。
  const handlePaste = useCallback((e: ClipboardEvent): boolean => {
    if (inputLocked) {
      e.preventDefault();
      return true;
    }
    const items = e.clipboardData?.items;
    if (items) {
      const pathItems: string[] = [];
      const nameMap: Record<string, string> = {};
      for (const item of Array.from(items)) {
        if (item.kind && item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (!file) continue;
        const filePath = window.platform?.getFilePath?.(file);
        if (!filePath) continue;
        pathItems.push(filePath);
        nameMap[filePath] = file.name;
      }
      if (pathItems.length > 0) {
        e.preventDefault();
        void Promise.resolve(attachFilesFromPaths(pathItems, nameMap)).catch((err) => {
          console.warn('[paste] attach clipboard file paths failed', err);
        });
        return true;
      }

      for (const item of Array.from(items)) {
        if (!item.type.startsWith('image/')) continue;
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return true;
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (!match) return;
          const [, mimeType, base64Data] = match;
          const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : (mimeType.split('/')[1] || 'png');
          const name = `${t('input.pastedImage')}.${ext}`;
          try {
            const uploadPayload = await prepareChatImageUpload({
              file,
              name,
              base64Data,
              mimeType,
            });
            const res = await hanaFetch('/api/upload-blob', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: uploadPayload.name,
                base64Data: uploadPayload.base64Data,
                mimeType: uploadPayload.mimeType,
                ...(useStore.getState().currentSessionPath ? { sessionPath: useStore.getState().currentSessionPath } : {}),
              }),
            });
            const data = await res.json();
            const upload = data?.uploads?.[0];
            if (upload?.dest) {
              addAttachedFile({ fileId: upload.fileId, path: upload.dest, name: upload.name || uploadPayload.name, isDirectory: false });
            } else {
              notifyPasteUploadFailure(t, upload?.error);
              console.warn('[paste] upload-blob failed', upload?.error || data);
            }
          } catch (err) {
            notifyPasteUploadFailure(t, err);
            console.warn('[paste] upload-blob error', err);
          }
        };
        reader.readAsDataURL(file);
        return true;
      }
    }

    const plainUrlPaste = extractPlainUrlPaste(e.clipboardData);
    if (plainUrlPaste && editor) {
      e.preventDefault();
      editor.commands.insertContent(plainUrlPaste);
      return true;
    }
    return false;
  }, [addAttachedFile, editor, inputLocked, t]);

  pasteHandlerRef.current = handlePaste;

  // ── Load thinking level once server port is ready + listen for plan mode sync ──
  const activeServerConnection = useStore(s => s.activeServerConnection);
  useEffect(() => {
    if (activeServerConnection && surface !== 'mobile') {
      const query = pendingNewSession
        ? '?pendingNewSession=1'
        : currentSessionPath
          ? `?sessionPath=${encodeURIComponent(currentSessionPath)}`
          : '';
      hanaFetch(`/api/session-thinking-level${query}`)
        .then(r => r.json())
        .then(d => { if (d.thinkingLevel) setThinkingLevel(d.thinkingLevel as ThinkingLevel); })
        .catch((err: unknown) => console.warn('[InputArea] load thinking level failed', err));
    }

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      setPermissionMode((detail.mode || (detail.enabled ? 'read_only' : 'operate')) as PermissionMode);
    };
    window.addEventListener('hana-plan-mode', handler);
    return () => window.removeEventListener('hana-plan-mode', handler);
  }, [activeServerConnection, currentSessionPath, pendingNewSession, setPermissionMode, setThinkingLevel, surface]);

  // ── Handle slash selection (builtin vs skill) ──
  const handleSlashSelect = useCallback((item: SlashItem) => {
    if (inputLocked) return;
    slashDismissedTextRef.current = null;
    if (item.type === 'builtin') {
      item.execute();
      return;
    }
    if (!editor) return;
    editor.chain()
      .clearContent()
      .insertContent({ type: 'skillBadge', attrs: { name: item.name } })
      .insertContent(' ')
      .focus()
      .run();
    setSlashMenuOpen(false);
  }, [editor, inputLocked]);

  const handleFileMentionSelect = useCallback((item: FileMentionItem) => {
    if (inputLocked) return;
    if (!editor || !fileMentionRange) return;
    editor.chain()
      .focus()
      .deleteRange({ from: fileMentionRange.from, to: fileMentionRange.to })
      .insertContent({
        type: 'fileBadge',
        attrs: {
          fileId: item.fileId || null,
          path: item.path,
          name: item.name,
          isDirectory: !!item.isDirectory,
          mimeType: item.mimeType || null,
        },
      })
      .insertContent(' ')
      .run();
    setFileMenuOpen(false);
    setFileMentionRange(null);
    setFileMentionQuery('');
  }, [editor, fileMentionRange, inputLocked]);

  // ── Send / interject message ──
  const submitEditorMessage = useCallback(async (type: 'prompt' | 'interject') => {
    if (inputLocked) return;
    if (!editor) return;
    const editorJson = editor.getJSON();
    const { text: rawText, skills, fileRefs } = serializeEditor(editorJson);
    const text = rawText.trim();

    if (type === 'prompt') {
      const slashSelection = resolveSlashSubmitSelection({
        text,
        skills,
        commands: slashCommands,
        selectedIndex: slashSelected,
        dismissedText: slashDismissedTextRef.current,
      });
      if (slashSelection) {
        handleSlashSelect(slashSelection);
        return;
      }
    }

    const inputFiles = mergeEditorFileRefs(attachedFiles, fileRefs);
    const hasFiles = inputFiles.length > 0;
    if ((!text && !hasFiles && !docContextAttached && useStore.getState().quotedSelections.length === 0) || !connected) return;
    if (type === 'prompt' && isStreaming) return;
    if (type === 'interject' && !isStreaming) return;
    if (sending) return;
    if (modelSwitching) return;
    if (useStore.getState().pendingSessionSwitchPath) return;
    if (type === 'prompt') {
      // 压缩 / 能力刷新（fresh compact）期间禁发 prompt：此窗口内 session 没有
      // 可用 runtime，发消息会冷建第二个 runtime 与压缩后的 reload 竞争（#1624 I2）。
      // Enter 发送不走 canSend，必须在提交路径同样拦截；按 keyed 状态现读现查。
      const guardState = useStore.getState();
      const guardPath = guardState.currentSessionPath;
      if (guardPath && (
        sessionScopedListIncludes(guardState, guardState.capabilityRefreshingSessions, guardPath)
        || isSessionCompacting(guardState, guardPath)
      )) return;
    }
    setSending(true);

    try {
      if (pendingNewSession) {
        const ok = await ensureSession();
        if (!ok) return;
        loadSessions();
      }

      // 分离原生媒体和普通附件；后端决定图片视觉桥、视频/音频原生能力或显式报错。
      const imageFiles = hasFiles ? inputFiles.filter(f => !f.isDirectory && isImageFile(f.name)) : [];
      const videoFiles = hasFiles ? inputFiles.filter(f => !f.isDirectory && isVideoFile(f.name)) : [];
      const audioFiles = hasFiles ? inputFiles.filter(f => !f.isDirectory && isAudioFileName(f.name, f.mimeType)) : [];

      const imagePreflight = await evaluateChatImageSendPreflight({
        attachments: inputFiles,
        model: currentModelInfo,
        loadVisionAuxiliaryConfig,
      });
      // #1647：视觉能力不可用不再拦下整条消息。图片始终携带文件身份
      //（displayMessage.attachments → 服务端登记 SessionFile + 注入路径 marker），
      // 这里只决定是否附带像素载荷；降级是显式的（toast 告知 + 不读字节）。
      const imagesAsFileOnly = !imagePreflight.ok;
      if (imagesAsFileOnly) {
        notifyTextModelImageFileOnly({
          t,
          addToast: useStore.getState().addToast,
          openSettings: () => openProviderModelSettings(currentModelInfo?.provider),
        });
      }
      const videoPreflight = await evaluateChatVideoSendPreflight({
        attachments: inputFiles,
        model: currentModelInfo,
      });
      const sendVideosNatively = videoPreflight.ok && videoPreflight.reason === 'native-video';
      const videosAsFileOnly = !videoPreflight.ok;
      if (videosAsFileOnly) {
        notifyTextModelVideoFileOnly({
          t,
          addToast: useStore.getState().addToast,
          openSettings: () => openProviderModelSettings(currentModelInfo?.provider),
        });
      }
      const audioPreflight = await evaluateChatAudioSendPreflight({
        attachments: inputFiles,
        model: currentModelInfo,
      });
      const sendAudiosNatively = audioPreflight.ok && audioPreflight.reason === 'native-audio';
      const otherFiles = hasFiles ? inputFiles.filter(f =>
        f.isDirectory || (
          !isImageFile(f.name)
          && !(sendVideosNatively && isVideoFile(f.name))
          && !(sendAudiosNatively && isAudioFileName(f.name, f.mimeType))
        )
      ) : [];

      const sessionPathForSend = useStore.getState().currentSessionPath;
      if (!sessionPathForSend) return;
      const sessionFileRefs = otherFiles
        .filter(f => f.fileId)
        .map(f => ({
          fileId: f.fileId,
          sessionPath: sessionPathForSend,
          label: f.name || f.path,
          kind: f.isDirectory ? 'directory' : 'attachment',
        }));

      let finalText = text;
      if (otherFiles.length > 0) {
        const fileBlock = otherFiles.map(f => {
          const label = f.fileId ? (f.name || f.path) : f.path;
          return f.isDirectory ? `[目录] ${label}` : `[附件] ${label}`;
        }).join('\n');
        finalText = text ? `${text}\n\n${fileBlock}` : fileBlock;
      }

      // 图片 / 视频读 base64。统一走 platform 层：Electron 里 platform 代理到 hana，
      // Web/PWA 里 platform 代理到 HTTP fallback。
      const platform = window.platform;
      const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
      const videos: Array<{ type: 'video'; data: string; mimeType: string }> = [];
      const audios: Array<{ type: 'audio'; data: string; mimeType: string }> = [];
      const imageBase64Map = new Map<string, { base64Data: string; mimeType: string }>();
      const videoBase64Map = new Map<string, { base64Data: string; mimeType: string }>();
      const audioBase64Map = new Map<string, { base64Data: string; mimeType: string }>();
      // 单图读取失败同样不拦整条消息：该图退化为仅文件身份，显式提示（#1647）
      const imageFileOnlyPaths = new Set<string>();
      for (const img of imagesAsFileOnly ? [] : imageFiles) {
        try {
          if (img.base64Data && img.mimeType) {
            images.push({ type: 'image', data: img.base64Data, mimeType: img.mimeType });
          } else {
            const base64 = await platform?.readFileBase64?.(img.path);
            if (base64) {
              const mimeType = chatImageMimeTypeForName(img.name, img.mimeType);
              imageBase64Map.set(img.path, { base64Data: base64, mimeType });
              images.push({ type: 'image', data: base64, mimeType });
            } else {
              throw new Error(`failed to read image attachment: ${img.path}`);
            }
          }
        } catch (err) {
          console.warn('[input] failed to read image attachment', err);
          imageFileOnlyPaths.add(img.path);
          useStore.getState().addToast(t('input.imageReadFailedSentAsFile'), 'warning', 6000, {
            dedupeKey: `image-read-failed:${img.path}`,
          });
        }
      }
      for (const audio of sendAudiosNatively ? audioFiles : []) {
        try {
          if (audio.base64Data) {
            const mimeType = chatAudioMimeTypeForName(audio.name, audio.mimeType);
            audios.push({ type: 'audio', data: audio.base64Data, mimeType });
          } else {
            const base64 = await platform?.readFileBase64?.(audio.path);
            if (base64) {
              const mimeType = chatAudioMimeTypeForName(audio.name, audio.mimeType);
              audioBase64Map.set(audio.path, { base64Data: base64, mimeType });
              audios.push({ type: 'audio', data: base64, mimeType });
            } else {
              throw new Error(`failed to read audio attachment: ${audio.path}`);
            }
          }
        } catch (err) {
          console.warn('[input] failed to read audio attachment', err);
          useStore.getState().addToast(t('input.audioReadFailed'), 'error', 6000, {
            dedupeKey: `audio-read-failed:${audio.path}`,
          });
          return;
        }
      }
      for (const video of sendVideosNatively ? videoFiles : []) {
        try {
          if (video.base64Data && video.mimeType) {
            const mimeType = chatVideoMimeTypeForName(video.name, video.mimeType);
            videos.push({ type: 'video', data: video.base64Data, mimeType });
          } else {
            const base64 = await platform?.readFileBase64?.(video.path);
            if (base64) {
              const mimeType = chatVideoMimeTypeForName(video.name, video.mimeType);
              videoBase64Map.set(video.path, { base64Data: base64, mimeType });
              videos.push({ type: 'video', data: base64, mimeType });
            } else {
              throw new Error(`failed to read video attachment: ${video.path}`);
            }
          }
        } catch (err) {
          console.warn('[input] failed to read video attachment', err);
          useStore.getState().addToast(t('input.videoReadFailed'), 'error', 6000, {
            dedupeKey: `video-read-failed:${video.path}`,
          });
          return;
        }
      }

      // 文档上下文
      let docForRender: { path: string; name: string } | null = null;
      if (docContextAttached && currentDoc) {
        finalText = finalText ? `${finalText}\n\n[参考文档] ${currentDoc.path}` : `[参考文档] ${currentDoc.path}`;
        docForRender = currentDoc;
      }
      if (docContextAttached) setDocContextAttached(false);

      // 引用片段
      const quotes = useStore.getState().quotedSelections;
      if (quotes.length > 0) {
        const quoteStr = quotes.map(formatQuotedSelectionForPrompt).join('\n\n');
        finalText = finalText ? `${finalText}\n\n${quoteStr}` : quoteStr;
      }

      const allFiles = [...(hasFiles ? inputFiles : [])];
      if (docForRender) allFiles.push({ path: docForRender.path, name: docForRender.name });

      editor.commands.clearContent();
      if (currentSessionPath) clearDraft(currentSessionPath);
      clearAttachedFiles();
      if (useStore.getState().quotedSelections.length > 0) useStore.getState().clearQuotedSelections();

      const clientMessageId = createClientUserMessageId();
      const displayMessage = {
        text,
        skills: skills.length > 0 ? skills : undefined,
        quotedText: quotes.length > 0 ? quotes.map(q => q.text).join('\n\n') : undefined,
        attachments: allFiles.length > 0 ? allFiles.map(f => {
          const cached = imageBase64Map.get(f.path);
          const cachedVideo = videoBase64Map.get(f.path);
          const cachedAudio = audioBase64Map.get(f.path);
          const imageFile = !f.isDirectory && isImageFile(f.name);
          return {
            fileId: f.fileId,
            path: f.path,
            name: f.name,
            isDir: !!f.isDirectory,
            mimeType: f.mimeType || cached?.mimeType || cachedVideo?.mimeType || cachedAudio?.mimeType || undefined,
            visionAuxiliary: imageFile && !supportsVision && !imagesAsFileOnly && !imageFileOnlyPaths.has(f.path),
            ...(f.waveform ? { waveform: f.waveform } : {}),
          };
        }) : undefined,
      };

      useStore.getState().appendOptimisticUserMessage(sessionPathForSend, {
        id: clientMessageId,
        role: 'user',
        text,
        textHtml: text ? renderMarkdown(text) : undefined,
        timestamp: Date.now(),
        attachments: displayMessage.attachments,
        quotedText: displayMessage.quotedText,
        skills: displayMessage.skills,
        sendStatus: 'pending',
      });

      const ws = getWebSocket();
      const wsMsg: Record<string, unknown> = {
        type,
        clientMessageId,
        text: finalText,
        sessionPath: sessionPathForSend,
        uiContext: collectUiContext(useStore.getState()),
        displayMessage,
      };
      if (sessionFileRefs.length > 0) wsMsg.sessionFileRefs = sessionFileRefs;
      if (images.length > 0) wsMsg.images = images;
      if (videos.length > 0) wsMsg.videos = videos;
      if (audios.length > 0) wsMsg.audios = audios;
      if (skills.length > 0) wsMsg.skills = skills;
      if (!ws) {
        useStore.getState().markOptimisticUserMessageFailed(
          sessionPathForSend,
          clientMessageId,
          'websocket_unavailable',
        );
        return;
      }
      try {
        ws.send(JSON.stringify(wsMsg));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        useStore.getState().markOptimisticUserMessageFailed(sessionPathForSend, clientMessageId, message);
        throw err;
      }
    } finally {
      setSending(false);
    }
  }, [editor, inputLocked, attachedFiles, docContextAttached, connected, isStreaming, sending, pendingNewSession, currentDoc, clearAttachedFiles, clearDraft, currentSessionPath, setDocContextAttached, slashCommands, slashSelected, handleSlashSelect, supportsVision, currentModelInfo, loadVisionAuxiliaryConfig, modelSwitching, t]);

  const handleSend = useCallback(async () => {
    await submitEditorMessage('prompt');
  }, [submitEditorMessage]);

  // ── Steer ──
  const handleSteer = useCallback(async () => {
    await submitEditorMessage('interject');
  }, [submitEditorMessage]);

  // ── Stop ──
  const handleStop = useCallback(() => {
    const ws = getWebSocket();
    if (!isStreaming || !ws) return;
    ws.send(JSON.stringify({ type: 'abort', sessionPath: useStore.getState().currentSessionPath }));
  }, [isStreaming]);

  // ── Key handler ──
  const handleEditorKeyDown = useCallback((e: InputKeyEvent): boolean => {
    if (inputLocked) {
      e.preventDefault();
      return true;
    }
    if (e.defaultPrevented) return false;
    if (fileMenuOpen && (fileMentionItems.length > 0 || fileMentionBusy)) {
      if (e.key === 'ArrowDown' && fileMentionItems.length > 0) {
        e.preventDefault();
        setFileSelected(i => (i + 1) % fileMentionItems.length);
        return true;
      }
      if (e.key === 'ArrowUp' && fileMentionItems.length > 0) {
        e.preventDefault();
        setFileSelected(i => (i - 1 + fileMentionItems.length) % fileMentionItems.length);
        return true;
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && fileMentionItems.length > 0) {
        e.preventDefault();
        const item = fileMentionItems[fileSelected];
        if (item) handleFileMentionSelect(item);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setFileMenuOpen(false);
        return true;
      }
    }
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSelected(i => (i + 1) % filteredCommands.length); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSelected(i => (i - 1 + filteredCommands.length) % filteredCommands.length); return true; }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const cmd = filteredCommands[slashSelected] || filteredCommands[0];
        if (cmd) handleSlashSelect(cmd);
        return true;
      }
      if (e.key === 'Escape') { e.preventDefault(); dismissSlashMenu(); return true; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !isComposing.current && !e.isComposing) {
      e.preventDefault();
      if (isStreaming && hasContent) handleSteer(); else handleSend();
      return true;
    }
    return false;
  }, [
    dismissSlashMenu,
    fileMentionBusy,
    fileMentionItems,
    fileMenuOpen,
    fileSelected,
    filteredCommands,
    handleFileMentionSelect,
    handleSend,
    handleSteer,
    handleSlashSelect,
    isStreaming,
    hasContent,
    inputLocked,
    editor,
    slashMenuOpen,
    slashSelected,
  ]);

  keyDownHandlerRef.current = handleEditorKeyDown as (event: KeyboardEvent) => boolean;
  beforeInputHandlerRef.current = (event: InputEvent): boolean => {
    if (surface !== 'mobile') return false;
    if (event.defaultPrevented) return false;
    if (event.inputType !== 'insertParagraph') return false;
    return handleEditorKeyDown({
      key: 'Enter',
      shiftKey: false,
      defaultPrevented: event.defaultPrevented,
      isComposing: event.isComposing,
      preventDefault: () => event.preventDefault(),
    });
  };

  const handleSlashResultClick = useCallback(() => {
    if (slashResult?.filePath) {
      window.platform?.openFile?.(slashResult.filePath);
      return;
    }
    if (!slashResult?.deskDir) return;
    toggleJianSidebar(true);
    void revealDeskDirectory(slashResult.deskDir);
  }, [slashResult?.deskDir, slashResult?.filePath]);

  const handleContinueDeletedAgentSession = useCallback(async () => {
    const path = currentSessionPath;
    if (!path || continuingDeletedAgentSession) return;
    setDeletedAgentContinueError(null);
    setContinuingDeletedAgentSession(true);
    try {
      const ok = await continueDeletedAgentSession(path);
      if (!ok) setDeletedAgentContinueError(t('session.deletedAgent.continueFailed'));
    } catch (err) {
      console.warn('[input] continue deleted-agent session failed', err);
      setDeletedAgentContinueError(t('session.deletedAgent.continueFailed'));
    } finally {
      setContinuingDeletedAgentSession(false);
    }
  }, [continuingDeletedAgentSession, currentSessionPath, t]);

  return (
    <div
      className={`${styles['input-surface']}${surface === 'mobile' ? ` ${styles['input-surface-mobile']}` : ''}${variant === 'compact' ? ` ${styles['input-surface-compact']}` : ''}`}
      ref={inputSurfaceRef}
    >
      <InputContextRow
        attachedFiles={attachedFiles}
        removeAttachedFile={removeAttachedFile}
        hasQuotedSelection={quotedSelections.length > 0}
      />
      <InputStatusBars
        slashBusy={slashBusy}
        slashBusyLabel={slashCommands.find(c => c.name === slashBusy)?.busyLabel || t('common.executing')}
        compacting={compactingStatus}
        compactingLabel={compactingStatusLabel}
        screenshotBusy={screenshotBusy}
        screenshotLabel={t('common.screenshotInProgress')}
        screenshotPageLabel={screenshotProgress && screenshotProgress.totalPages > 0
          ? t('common.screenshotProgressPage', {
            current: screenshotProgress.currentPage,
            total: screenshotProgress.totalPages,
          })
          : null}
        screenshotProgress={screenshotProgress}
        inlineError={inlineError}
        slashResult={slashResult}
        onResultClick={(slashResult?.filePath || slashResult?.deskDir) ? handleSlashResultClick : undefined}
      />
      <div className={styles['slash-menu-anchor']} ref={slashMenuRef}>
        {slashMenuOpen && filteredCommands.length > 0 && (
          <SlashCommandMenu commands={filteredCommands} selected={slashSelected} busy={slashBusy}
            onSelect={handleSlashSelect} onHover={(i) => setSlashSelected(i)} />
        )}
      </div>
      <div className={styles['slash-menu-anchor']} ref={fileMenuRef}>
        {fileMenuOpen && (fileMentionItems.length > 0 || fileMentionBusy) && (
          <FileMentionMenu
            items={fileMentionItems}
            selected={fileSelected}
            busy={fileMentionBusy}
            onSelect={handleFileMentionSelect}
            onHover={(i) => setFileSelected(i)}
          />
        )}
      </div>
      <div className={styles['input-stack']}>
        {capabilityDrift && !capabilityRefreshing && !visibleSessionConfirmation && !deletedAgentReadOnly && currentSessionPath && (
          <CapabilityDriftNotice
            sessionPath={currentSessionPath}
            drift={capabilityDrift}
          />
        )}
        {visibleSessionConfirmation && (
          <SessionConfirmationPrompt
            block={visibleSessionConfirmation}
            exiting={sessionConfirmationExiting}
          />
        )}
        <div className={styles['input-wrapper']} ref={inputCardRef}>
          <input
            ref={browserFileInputRef}
            className={styles['browser-file-input']}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/gif,image/webp,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/ogg,audio/flac,audio/webm"
            disabled={inputLocked}
            onChange={handleBrowserFileInputChange}
          />
          <div
            onKeyDown={(event) => {
              if (!event.defaultPrevented) handleEditorKeyDown(event);
            }}
            onCompositionStart={() => { isComposing.current = true; }}
            onCompositionEnd={() => { isComposing.current = false; }}
          >
            <EditorContent editor={editor} />
          </div>
          <InputControlBar
            t={t}
            onAttach={handleAttach}
            slashBtnRef={slashBtnRef}
            onSlashToggle={handleSlashToggle}
            onOptimizePrompt={handleOptimizePrompt}
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            planModeLocked={inputLocked}
            showThinking={showThinkingControl}
            thinkingLevel={thinkingLevel}
            onThinkingChange={setThinkingLevel}
            availableThinkingLevels={availableThinkingLevels}
            models={models}
            sessionModel={sessionModel}
            isStreaming={isStreaming}
            hasInput={hasContent}
            canSend={canSend}
            showAudioInput={showAudioInput}
            audioRecordingActive={audioRecordingState === 'recording'}
            audioRecordingBusy={audioRecordingState === 'starting' || audioRecordingState === 'stopping'}
            onAudioToggle={handleAudioRecordToggle}
            onSend={handleSend}
            onSteer={handleSteer}
            onStop={handleStop}
          />
          {audioRecorderOpen && showAudioInput && (
            <div className={styles['audio-recording-card']} role="status" aria-live="polite">
              <div className={`${styles['audio-recording-dot']}${audioRecordingState === 'recording' ? ` ${styles['is-live']}` : ''}`} />
              <div className={styles['audio-recording-copy']}>
                <div className={styles['audio-recording-title']}>
                  {audioRecordingState === 'starting'
                    ? t('input.audioRecordingStarting')
                    : audioRecordingState === 'stopping'
                      ? t('input.audioRecordingSaving')
                      : t('input.audioRecording')}
                </div>
                <div className={styles['audio-recording-time']}>
                  {formatRecordingElapsed(audioRecordingElapsed)}
                </div>
                {audioRecordingError && (
                  <div className={styles['audio-recording-error']}>
                    {audioRecordingError}
                  </div>
                )}
              </div>
            </div>
          )}
          {deletedAgentReadOnly && (
            <div className={styles['deleted-agent-overlay']} role="status" aria-live="polite">
              <div className={styles['deleted-agent-panel']}>
                <div className={styles['deleted-agent-title']}>
                  {t('session.deletedAgent.title')}
                </div>
                <div className={styles['deleted-agent-text']}>
                  {t('session.deletedAgent.description')}
                </div>
                <button
                  type="button"
                  className={styles['deleted-agent-action']}
                  onClick={handleContinueDeletedAgentSession}
                  disabled={continuingDeletedAgentSession}
                >
                  {continuingDeletedAgentSession
                    ? t('session.deletedAgent.continuing')
                    : t('session.deletedAgent.continueButton')}
                </button>
                {continuingDeletedAgentSession && (
                  <div className={styles['deleted-agent-progress']} data-testid="deleted-agent-progress">
                    <div className={styles['deleted-agent-progress-fill']} />
                  </div>
                )}
                {deletedAgentContinueError && (
                  <div className={styles['deleted-agent-error']}>
                    {deletedAgentContinueError}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
