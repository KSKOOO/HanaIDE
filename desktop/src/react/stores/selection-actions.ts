import { useStore } from './index';
import { sessionScopedValue } from './session-slice';
import type { PreviewItem } from '../types';
import type { EditorView } from '@codemirror/view';
import type { FloatingAnchorRect, QuotedSelection } from './input-slice';
import type { ChatMessage } from './chat-types';

const MAX_QUOTED_SELECTION_CHARS = 2000;
const SELECTION_QUOTE_ACTION_SELECTOR = '[data-selection-quote-action="true"]';
type QuoteClearScope = {
  sourceKind?: QuotedSelection['sourceKind'];
  sourceFilePath?: string | null;
  sourceSessionPath?: string | null;
  sourceMessageId?: string | null;
};

let quotedSelectionLifecycle:
  | { target: Document; cleanup: () => void }
  | null = null;

export function initQuotedSelectionLifecycle(target: Document = document): () => void {
  if (quotedSelectionLifecycle?.target === target) {
    return quotedSelectionLifecycle.cleanup;
  }
  quotedSelectionLifecycle?.cleanup();

  const handleSelectionChange = () => {
    clearSelectionIfNativeSelectionIsEmpty(target);
  };
  let suppressNextSelectionCommit = false;
  const handleSelectionBoundaryInteraction = (event: Event) => {
    const targetElement = eventTargetElement(event.target);
    if (!clearSelectionIfInteractionLeavesQuoteAction(targetElement)) return;
    if (!targetElement || !closestChatSelectionRoot(targetElement)) {
      suppressNextSelectionCommit = true;
    }
  };
  const handleWindowBlur = () => {
    suppressNextSelectionCommit = true;
    clearSelection();
  };
  const handledSelectionCommitEvents = new WeakSet<Event>();
  const handleSelectionCommit = (event: Event) => {
    if (handledSelectionCommitEvents.has(event)) return;
    handledSelectionCommitEvents.add(event);
    if (suppressNextSelectionCommit) {
      suppressNextSelectionCommit = false;
      return;
    }
    scheduleDocumentChatSelectionCapture(target, eventAnchorRect(event));
  };
  target.addEventListener('selectionchange', handleSelectionChange);
  target.addEventListener('pointerdown', handleSelectionBoundaryInteraction, true);
  target.addEventListener('focusin', handleSelectionBoundaryInteraction, true);
  target.addEventListener('mouseup', handleSelectionCommit);
  target.addEventListener('touchend', handleSelectionCommit);
  target.addEventListener('keyup', handleSelectionCommit);

  const targetWindow = target.defaultView;
  targetWindow?.addEventListener('mouseup', handleSelectionCommit);
  targetWindow?.addEventListener('touchend', handleSelectionCommit);
  targetWindow?.addEventListener('keyup', handleSelectionCommit);
  targetWindow?.addEventListener('blur', handleWindowBlur);

  const cleanup = () => {
    target.removeEventListener('selectionchange', handleSelectionChange);
    target.removeEventListener('pointerdown', handleSelectionBoundaryInteraction, true);
    target.removeEventListener('focusin', handleSelectionBoundaryInteraction, true);
    target.removeEventListener('mouseup', handleSelectionCommit);
    target.removeEventListener('touchend', handleSelectionCommit);
    target.removeEventListener('keyup', handleSelectionCommit);
    targetWindow?.removeEventListener('mouseup', handleSelectionCommit);
    targetWindow?.removeEventListener('touchend', handleSelectionCommit);
    targetWindow?.removeEventListener('keyup', handleSelectionCommit);
    targetWindow?.removeEventListener('blur', handleWindowBlur);
    if (quotedSelectionLifecycle?.target === target) {
      quotedSelectionLifecycle = null;
    }
  };
  quotedSelectionLifecycle = { target, cleanup };
  return cleanup;
}

/**
 * 捕获 previewItem 中的文本选中。
 * CM 模式传入 cmView，DOM 模式不传。
 */
export function captureSelection(previewItem: PreviewItem, cmView?: EditorView, fallbackAnchorRect?: FloatingAnchorRect): void {
  if (cmView) {
    captureCMSelection(previewItem, cmView);
  } else {
    captureDOMSelection(previewItem, fallbackAnchorRect);
  }
}

export function scheduleCaptureSelection(previewItem: PreviewItem, cmView?: EditorView, fallbackAnchorRect?: FloatingAnchorRect): void {
  captureSelection(previewItem, cmView, fallbackAnchorRect);
}

function captureCMSelection(previewItem: PreviewItem, view: EditorView): void {
  const selection = view.state.selection.main;
  const { from, to } = selection;
  if (from === to) {
    clearSelection(previewClearScope(previewItem));
    return;
  }
  const rawText = view.state.sliceDoc(from, to);
  const text = rawText.trim();
  if (!text) {
    clearSelection(previewClearScope(previewItem));
    return;
  }
  const leadingTrimmed = rawText.length - rawText.trimStart().length;
  const trailingTrimmed = rawText.length - rawText.trimEnd().length;
  const textStart = from + leadingTrimmed;
  const textEnd = to - trailingTrimmed;
  const lineStart = view.state.doc.lineAt(textStart).number;
  const lineEnd = view.state.doc.lineAt(Math.max(textStart, textEnd - 1)).number;

  useStore.getState().setQuoteCandidate({
    text,
    sourceTitle: previewItem.title,
    sourceKind: 'preview',
    sourceFilePath: previewItem.filePath,
    lineStart,
    lineEnd,
    selectionAnchorKind: 'codemirror',
    charCount: text.length,
    anchorRect: getCMSelectionAnchorRect(view, textStart, textEnd, selection.head <= selection.anchor) ?? getElementAnchorRect((view as EditorView & { dom?: Element }).dom ?? null),
    updatedAt: Date.now(),
  });
}

function captureDOMSelection(previewItem: PreviewItem, fallbackAnchorRect?: FloatingAnchorRect): void {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!text) {
    clearSelection(previewClearScope(previewItem));
    return;
  }
  const clipped = clipQuotedText(text);

  useStore.getState().setQuoteCandidate({
    text: clipped,
    sourceTitle: previewItem.title,
    sourceKind: 'preview',
    sourceFilePath: previewItem.filePath,
    selectionAnchorKind: 'native',
    charCount: text.length,
    anchorRect: sel && sel.rangeCount > 0
      ? getNativeSelectionAnchorRect(sel, fallbackAnchorRect) ?? getElementAnchorRect(nodeElement(sel.anchorNode))
      : undefined,
    updatedAt: Date.now(),
  });
}

export function captureChatSelection(sessionPath: string, fallbackAnchorRect?: FloatingAnchorRect): void {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!sel || !text || sel.rangeCount === 0) {
    clearSelection({ sourceKind: 'chat', sourceSessionPath: sessionPath });
    return;
  }

  const anchorElement = nodeElement(sel.anchorNode);
  const focusElement = nodeElement(sel.focusNode);
  if (!anchorElement || !focusElement) return;
  if (isInteractiveSelectionElement(anchorElement) || isInteractiveSelectionElement(focusElement)) return;

  const anchorMessage = closestMessageElement(anchorElement);
  const focusMessage = closestMessageElement(focusElement);
  if (!anchorMessage || !focusMessage || anchorMessage !== focusMessage) return;

  const messageId = anchorMessage.dataset.messageId;
  if (!messageId) return;

  const message = findMessage(sessionPath, messageId);
  if (!message) return;

  const quotedSelection: QuotedSelection = {
    text: clipQuotedText(text),
    sourceTitle: message.role === 'assistant' ? 'Assistant message' : 'User message',
    sourceKind: 'chat',
    sourceSessionPath: sessionPath,
    sourceMessageId: message.id,
    sourceRole: message.role,
    selectionAnchorKind: 'native',
    charCount: text.length,
    anchorRect: getNativeSelectionAnchorRect(sel, fallbackAnchorRect) ?? getElementAnchorRect(anchorMessage),
    updatedAt: Date.now(),
  };
  useStore.getState().setQuoteCandidate(quotedSelection);
}

export function scheduleCaptureChatSelection(sessionPath: string, fallbackAnchorRect?: FloatingAnchorRect): void {
  captureChatSelection(sessionPath, fallbackAnchorRect);
}

function captureDocumentChatSelection(target: Document, fallbackAnchorRect?: FloatingAnchorRect): void {
  const sel = getNativeSelection(target);
  const text = sel?.toString().trim();
  if (!sel || !text || sel.rangeCount === 0) return;

  const anchorElement = nodeElement(sel.anchorNode);
  const focusElement = nodeElement(sel.focusNode);
  if (!anchorElement || !focusElement) return;
  if (isInteractiveSelectionElement(anchorElement) || isInteractiveSelectionElement(focusElement)) return;

  const anchorRoot = closestChatSelectionRoot(anchorElement);
  const focusRoot = closestChatSelectionRoot(focusElement);
  if (!anchorRoot || !focusRoot || anchorRoot !== focusRoot) return;

  const sessionPath = anchorRoot.dataset.sessionPath;
  if (!sessionPath) return;
  captureChatSelection(sessionPath, fallbackAnchorRect);
}

function scheduleDocumentChatSelectionCapture(target: Document, fallbackAnchorRect?: FloatingAnchorRect): void {
  captureDocumentChatSelection(target, fallbackAnchorRect);
}

function clipQuotedText(text: string): string {
  return text.length > MAX_QUOTED_SELECTION_CHARS ? text.slice(0, MAX_QUOTED_SELECTION_CHARS) : text;
}

function nodeElement(node: Node | null): Element | null {
  if (!node) return null;
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  return node.parentElement;
}

function eventTargetElement(target: EventTarget | null): Element | null {
  return target instanceof Node ? nodeElement(target) : null;
}

function closestChatSelectionRoot(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>('[data-chat-selection-root][data-session-path]');
}

function closestMessageElement(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>('[data-message-id]');
}

function isInteractiveSelectionElement(element: Element): boolean {
  return !!element.closest('input, textarea, select, button, [contenteditable="true"], [data-selection-ignore="true"], [data-mobile-gesture-ignore="true"]');
}

function clearSelectionIfInteractionLeavesQuoteAction(targetElement: Element | null): boolean {
  const current = useStore.getState().quoteCandidate;
  if (!current) return false;
  if (targetElement?.closest(SELECTION_QUOTE_ACTION_SELECTOR)) return false;
  clearSelection();
  return true;
}

function findMessage(sessionPath: string, messageId: string): ChatMessage | null {
  const state = useStore.getState();
  const session = sessionScopedValue(state, state.chatSessions, sessionPath);
  if (!session) return null;
  for (const item of session.items) {
    if (item.type === 'message' && item.data.id === messageId) return item.data;
  }
  return null;
}

function toPlainRect(rect: DOMRect | ClientRect): FloatingAnchorRect {
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function eventAnchorRect(event: Event): FloatingAnchorRect | undefined {
  if ('changedTouches' in event) {
    const touchEvent = event as TouchEvent;
    const touch = touchEvent.changedTouches.item(0);
    if (!touch) return undefined;
    return pointAnchorRect(touch.clientX, touch.clientY);
  }
  if ('clientX' in event && 'clientY' in event) {
    return pointAnchorRect(Number(event.clientX), Number(event.clientY));
  }
  return undefined;
}

function pointAnchorRect(left: number, top: number): FloatingAnchorRect | undefined {
  if (!Number.isFinite(left) || !Number.isFinite(top)) return undefined;
  return { left, right: left + 1, top, bottom: top + 1, width: 1, height: 1 };
}

export function getSelectionCommitAnchorRect(event: Event): FloatingAnchorRect | undefined {
  return eventAnchorRect(event);
}

function getElementAnchorRect(element: Element | null): FloatingAnchorRect | undefined {
  if (!element || typeof element.getBoundingClientRect !== 'function') return undefined;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return undefined;
  return toPlainRect(rect);
}

function unionRects(rects: Array<DOMRect | ClientRect>): FloatingAnchorRect | undefined {
  if (rects.length === 0) return undefined;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top) || !Number.isFinite(bottom)) return undefined;
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

function getRangeClientRects(range: Range): Array<DOMRect | ClientRect> {
  const clientRects = typeof range.getClientRects === 'function'
    ? Array.from(range.getClientRects()).filter(rect => rect.width > 0 || rect.height > 0)
    : [];
  return clientRects;
}

export function getRangeAnchorRect(range: Range): FloatingAnchorRect | undefined {
  const clientRects = getRangeClientRects(range);
  if (clientRects.length > 0) return unionRects(clientRects);

  if (typeof range.getBoundingClientRect !== 'function') return undefined;
  const rect = range.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return undefined;
  return toPlainRect(rect);
}

export function getNativeSelectionAnchorRect(sel: Selection, fallbackAnchorRect?: FloatingAnchorRect): FloatingAnchorRect | undefined {
  if (sel.rangeCount === 0) return fallbackAnchorRect;
  const range = sel.getRangeAt(0);
  return getSelectionFocusAnchorRect(sel, range)
    ?? fallbackAnchorRect
    ?? getRangeAnchorRect(range);
}

function getSelectionFocusAnchorRect(sel: Selection, range: Range): FloatingAnchorRect | undefined {
  const collapsedFocusRect = getCollapsedFocusAnchorRect(sel);
  if (collapsedFocusRect) return collapsedFocusRect;

  const clientRects = getRangeClientRects(range);
  if (clientRects.length === 0) return undefined;

  const backward = isSelectionBackward(sel);
  const endpointRect = backward ? clientRects[0] : clientRects[clientRects.length - 1];
  const endpointX = backward ? endpointRect.left : endpointRect.right;
  return pointAnchorRect(endpointX, endpointRect.top);
}

function getCollapsedFocusAnchorRect(sel: Selection): FloatingAnchorRect | undefined {
  if (!sel.focusNode) return undefined;
  const ownerDocument = sel.focusNode.ownerDocument ?? document;
  const range = ownerDocument.createRange();
  try {
    range.setStart(sel.focusNode, sel.focusOffset);
    range.collapse(true);
  } catch {
    return undefined;
  }

  const rect = getRangeClientRects(range)[0];
  if (!rect) return undefined;
  return pointAnchorRect(rect.left, rect.top);
}

function isSelectionBackward(sel: Selection): boolean {
  const { anchorNode, focusNode } = sel;
  if (!anchorNode || !focusNode) return false;
  if (anchorNode === focusNode) return sel.anchorOffset > sel.focusOffset;

  const position = anchorNode.compareDocumentPosition(focusNode);
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return true;
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return false;
  return false;
}

function getCMSelectionAnchorRect(view: EditorView, from: number, to: number, focusAtStart: boolean): FloatingAnchorRect | undefined {
  const withCoords = view as EditorView & {
    coordsAtPos?: (pos: number, side?: -1 | 1) => DOMRect | null;
  };
  if (typeof withCoords.coordsAtPos !== 'function') return undefined;

  const primary = focusAtStart
    ? withCoords.coordsAtPos(from, 1)
    : withCoords.coordsAtPos(to, -1);
  const fallback = withCoords.coordsAtPos(Math.max(from, to - 1), 1)
    ?? withCoords.coordsAtPos(from, 1);
  const rect = primary ?? fallback;
  if (!rect) return undefined;
  return pointAnchorRect(focusAtStart ? rect.left : rect.right, rect.top);
}

export function clearSelection(scope?: QuoteClearScope): void {
  const s = useStore.getState();
  if (s.quoteCandidate && quotedSelectionMatchesScope(s.quoteCandidate, scope)) {
    s.clearQuoteCandidate();
  }
}

function clearSelectionIfNativeSelectionIsEmpty(target: Document): void {
  const sel = getNativeSelection(target);
  const text = sel?.toString().trim();
  if (sel && text && sel.rangeCount > 0) return;
  const current = useStore.getState().quoteCandidate;
  if (!current) return;
  if (current.selectionAnchorKind === 'codemirror') return;
  useStore.getState().clearQuoteCandidate();
}

function getNativeSelection(target: Document): Selection | null {
  if (typeof target.getSelection === 'function') {
    return target.getSelection();
  }
  return target.defaultView?.getSelection?.() ?? window.getSelection();
}

function previewClearScope(previewItem: PreviewItem): QuoteClearScope {
  return previewItem.filePath
    ? { sourceKind: 'preview', sourceFilePath: previewItem.filePath }
    : { sourceKind: 'preview' };
}

function quotedSelectionMatchesScope(selection: QuotedSelection, scope?: QuoteClearScope): boolean {
  if (!scope) return true;
  if (scope.sourceKind && selection.sourceKind !== scope.sourceKind) return false;
  if (scope.sourceFilePath !== undefined && selection.sourceFilePath !== scope.sourceFilePath) return false;
  if (scope.sourceSessionPath !== undefined && selection.sourceSessionPath !== scope.sourceSessionPath) return false;
  if (scope.sourceMessageId !== undefined && selection.sourceMessageId !== scope.sourceMessageId) return false;
  return true;
}
