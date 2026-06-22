import type { AudioWaveform } from './chat-types';
import { sessionScopedKey } from './session-slice';

export interface AttachedFile {
  fileId?: string;
  path: string;
  name: string;
  isDirectory?: boolean;
  /** 内联 base64 数据（粘贴图片时使用，跳过文件读取） */
  base64Data?: string;
  mimeType?: string;
  waveform?: AudioWaveform;
}

export interface DocContextFile {
  path: string;
  name: string;
}

export interface FloatingAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface QuotedSelection {
  text: string;
  sourceTitle: string;
  sourceKind: 'preview' | 'chat';
  sourceFilePath?: string;
  sourceSessionPath?: string;
  sourceMessageId?: string;
  sourceRole?: 'user' | 'assistant';
  lineStart?: number;
  lineEnd?: number;
  selectionAnchorKind?: 'native' | 'codemirror';
  charCount: number;
  anchorRect?: FloatingAnchorRect;
  updatedAt?: number;
}

export interface InputSlice {
  attachedFiles: AttachedFile[];
  /** 按 session path 存储的附件（权威源） */
  attachedFilesBySession: Record<string, AttachedFile[]>;
  /** 按 session path 存储的草稿文本（内存级，关窗口清空） */
  drafts: Record<string, string>;
  deskContextAttached: boolean;
  docContextAttached: boolean;
  inputFocusTrigger: number;
  quoteCandidate: QuotedSelection | null;
  quotedSelections: QuotedSelection[];
  /** @deprecated Use quotedSelections for committed quotes and quoteCandidate for transient selection UI. */
  quotedSelection: QuotedSelection | null;
  addAttachedFile: (file: AttachedFile) => void;
  removeAttachedFile: (index: number) => void;
  setAttachedFiles: (files: AttachedFile[]) => void;
  clearAttachedFiles: () => void;
  setDraft: (sessionPath: string, text: string) => void;
  clearDraft: (sessionPath: string) => void;
  setDeskContextAttached: (attached: boolean) => void;
  toggleDeskContext: () => void;
  setDocContextAttached: (attached: boolean) => void;
  toggleDocContext: () => void;
  requestInputFocus: () => void;
  setQuoteCandidate: (sel: QuotedSelection) => void;
  clearQuoteCandidate: () => void;
  addQuotedSelection: (sel: QuotedSelection) => void;
  removeQuotedSelection: (index: number) => void;
  clearQuotedSelections: () => void;
  setQuotedSelections: (sels: QuotedSelection[]) => void;
  /** @deprecated Use addQuotedSelection or setQuoteCandidate. */
  setQuotedSelection: (sel: QuotedSelection) => void;
  /** @deprecated Use clearQuotedSelections and clearQuoteCandidate. */
  clearQuotedSelection: () => void;
}

function syncCurrentSessionAttachments(state: InputSlice & { currentSessionPath?: string | null }, files: AttachedFile[]) {
  const patch: Partial<InputSlice> & { attachedFilesBySession?: Record<string, AttachedFile[]> } = {
    attachedFiles: files,
  };
  const currentSessionPath = state.currentSessionPath;
  if (currentSessionPath) {
    const key = sessionScopedKey(state as any, currentSessionPath) || currentSessionPath;
    patch.attachedFilesBySession = {
      ...state.attachedFilesBySession,
      [key]: files,
    };
    if (key !== currentSessionPath) delete patch.attachedFilesBySession[currentSessionPath];
  }
  return patch;
}

export const createInputSlice = (
  set: (partial: Partial<InputSlice> | ((s: InputSlice) => Partial<InputSlice>)) => void
): InputSlice => ({
  attachedFiles: [],
  attachedFilesBySession: {},
  drafts: {},
  deskContextAttached: false,
  docContextAttached: false,
  inputFocusTrigger: 0,
  quoteCandidate: null,
  quotedSelections: [],
  quotedSelection: null,
  addAttachedFile: (file) =>
    set((s) => syncCurrentSessionAttachments(s as InputSlice & { currentSessionPath?: string | null }, [...s.attachedFiles, file])),
  removeAttachedFile: (index) =>
    set((s) => syncCurrentSessionAttachments(
      s as InputSlice & { currentSessionPath?: string | null },
      s.attachedFiles.filter((_, i) => i !== index),
    )),
  setAttachedFiles: (files) =>
    set((s) => syncCurrentSessionAttachments(s as InputSlice & { currentSessionPath?: string | null }, files)),
  clearAttachedFiles: () =>
    set((s) => syncCurrentSessionAttachments(s as InputSlice & { currentSessionPath?: string | null }, [])),
  setDraft: (sessionPath, text) =>
    set((s) => {
      const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
      const drafts = { ...s.drafts, [key]: text };
      if (key !== sessionPath) delete drafts[sessionPath];
      return { drafts };
    }),
  clearDraft: (sessionPath) =>
    set((s) => {
      const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
      const rest = { ...s.drafts };
      delete rest[key];
      delete rest[sessionPath];
      return { drafts: rest };
    }),
  setDeskContextAttached: (attached) => set({ deskContextAttached: attached }),
  toggleDeskContext: () =>
    set((s) => ({ deskContextAttached: !s.deskContextAttached })),
  setDocContextAttached: (attached) => set({ docContextAttached: attached }),
  toggleDocContext: () =>
    set((s) => ({ docContextAttached: !s.docContextAttached })),
  requestInputFocus: () =>
    set((s) => ({ inputFocusTrigger: s.inputFocusTrigger + 1 })),
  setQuoteCandidate: (sel) => set({ quoteCandidate: sel }),
  clearQuoteCandidate: () => set({ quoteCandidate: null }),
  addQuotedSelection: (sel) =>
    set((s) => {
      const quotedSelections = [...s.quotedSelections, sel];
      return { quotedSelections, quotedSelection: quotedSelections[0] ?? null };
    }),
  removeQuotedSelection: (index) =>
    set((s) => {
      const quotedSelections = s.quotedSelections.filter((_, i) => i !== index);
      return { quotedSelections, quotedSelection: quotedSelections[0] ?? null };
    }),
  clearQuotedSelections: () => set({ quotedSelections: [], quotedSelection: null }),
  setQuotedSelections: (sels) => set({ quotedSelections: sels, quotedSelection: sels[0] ?? null }),
  setQuotedSelection: (sel) => set({ quotedSelections: [sel], quotedSelection: sel }),
  clearQuotedSelection: () => set({ quoteCandidate: null, quotedSelections: [], quotedSelection: null }),
});
