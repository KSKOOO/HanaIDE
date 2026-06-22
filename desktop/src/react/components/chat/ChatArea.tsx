/**
 * ChatArea — 聊天消息列表（干净重写版）
 *
 * 原理：每个 session 一个原生滚动 div，visibility:hidden 保持 scrollTop。
 * 不用 Virtuoso，不用 Activity，不用快照，不用任何花活。
 */

import { memo, useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '../../stores';
import { sessionScopedListIncludes, sessionScopedValue } from '../../stores/session-slice';
import { loadMoreMessages } from '../../stores/session-actions';
import { getSelectionCommitAnchorRect, scheduleCaptureChatSelection } from '../../stores/selection-actions';
import { useContinuousBottomScroll } from '../../hooks/use-continuous-bottom-scroll';
import { useBoxSelection } from '../../hooks/use-box-selection';

const EMPTY_ITEMS: ChatListItem[] = [];
import type { ChatListItem } from '../../stores/chat-types';
import { ChatTranscript } from './ChatTranscript';
import { ChatTimelineNavigator } from './ChatTimelineNavigator';
import { buildTimelineAnchors } from './timeline-anchors';
import styles from './Chat.module.css';

const MAX_ALIVE = 5;
const LOAD_MORE_THRESHOLD = 200; // 距顶部多少 px 触发加载

// ── 入口 ──

export function ChatArea({ ignoreWelcome = false }: { ignoreWelcome?: boolean } = {}) {
  return (
    <>
      <PanelHost ignoreWelcome={ignoreWelcome} />
      <ScrollToBottomBtn />
    </>
  );
}

// ── PanelHost：管理 alive 列表 ──

function PanelHost({ ignoreWelcome }: { ignoreWelcome: boolean }) {
  const currentPath = useStore(s => s.currentSessionPath);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const [alive, setAlive] = useState<string[]>([]);

  // 加入 alive 列表（不重排已有位置，避免 React 移动 DOM 节点导致 scrollTop 丢失）
  useEffect(() => {
    if (!currentPath) return;
    setAlive(prev => {
      if (prev.includes(currentPath)) return prev; // 已存在，不动
      if (prev.length >= MAX_ALIVE) {
        // 淘汰第一个非当前的
        const evictIdx = prev.findIndex(p => p !== currentPath);
        const next = [...prev];
        next.splice(evictIdx, 1);
        next.push(currentPath);
        return next;
      }
      return [...prev, currentPath];
    });
  }, [currentPath]);

  if ((!ignoreWelcome && welcomeVisible) || !currentPath) return null;

  return (
    <>
      {alive.map(path => (
        <Panel key={path} path={path} active={path === currentPath} />
      ))}
    </>
  );
}

// ── Panel：一个 session 的原生滚动容器 ──

const SCROLL_THRESHOLD = 50;
const TIMELINE_HOVER_ZONE_PX = 64;
const TIMELINE_TOP_OFFSET_PX = 76;
const TIMELINE_HEIGHT_RATIO = 0.5;

const Panel = memo(function Panel({ path, active }: { path: string; active: boolean }) {
  const items = useStore(s => sessionScopedValue(s, s.chatSessions, path)?.items || EMPTY_ITEMS);
  const hasMore = useStore(s => sessionScopedValue(s, s.chatSessions, path)?.hasMore ?? false);
  const loadingMore = useStore(s => sessionScopedValue(s, s.chatSessions, path)?.loadingMore ?? false);
  const isSessionStreaming = useStore(s => sessionScopedListIncludes(s, s.streamingSessions, path));
  const sessionAgentId = useStore(s => s.sessions.find(se => se.path === path)?.agentId ?? null);
  const sessionReadOnly = useStore(s => s.sessions.find(se => se.path === path)?.agentDeleted === true);
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const messageElementsRef = useRef(new Map<string, HTMLDivElement>());
  const [timelineRailVisible, setTimelineRailVisible] = useState(false);
  const bottomScroll = useContinuousBottomScroll({
    scrollRef: ref,
    contentRef,
    active,
    stickyThreshold: SCROLL_THRESHOLD,
  });
  const timelineAnchors = useMemo(() => buildTimelineAnchors(items), [items]);
  const registerMessageElement = useCallback((messageId: string, element: HTMLDivElement | null) => {
    if (element) {
      messageElementsRef.current.set(messageId, element);
    } else {
      messageElementsRef.current.delete(messageId);
    }
  }, []);
  const orderedIds = useMemo(() => {
    const ids: string[] = [];
    for (const it of items) {
      if (it.type === 'message') ids.push(it.data.id);
    }
    return ids;
  }, [items]);
  const boxSelection = useBoxSelection({ messageElementsRef, orderedIds, sessionPath: path, active });
  const handleCaptureSelection = useCallback((event: ReactMouseEvent<HTMLDivElement> | ReactKeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    scheduleCaptureChatSelection(path, getSelectionCommitAnchorRect(event.nativeEvent));
  }, [active, path]);
  const handleShellPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const xFromRight = rect.right - event.clientX;
    const yFromTop = event.clientY - rect.top;
    const inRailX = xFromRight >= 0 && xFromRight <= TIMELINE_HOVER_ZONE_PX;
    const inRailY = yFromTop >= TIMELINE_TOP_OFFSET_PX
      && yFromTop <= TIMELINE_TOP_OFFSET_PX + rect.height * TIMELINE_HEIGHT_RATIO;
    setTimelineRailVisible(inRailX && inRailY);
  }, []);
  const handleShellPointerLeave = useCallback(() => {
    setTimelineRailVisible(false);
  }, []);

  // scroll 事件维护 sticky 标志 + 上滑加载更多 + 滚动中显现 scrollbar
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      const sticky = bottomScroll.checkSticky();
      if (active) setScrollButton(el, !sticky, () => {
        bottomScroll.scrollToBottom({ mode: 'follow', forceSticky: true });
      });
      // 触顶加载更多
      if (el.scrollTop < LOAD_MORE_THRESHOLD) {
        const state = useStore.getState();
        const session = sessionScopedValue(state, state.chatSessions, path);
        if (session?.hasMore && !session.loadingMore) {
          loadMoreMessages(path);
        }
      }
      // 滚动中显示 scrollbar，停下 800ms 后隐藏
      el.classList.add(styles['is-scrolling']);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        el.classList.remove(styles['is-scrolling']);
      }, 800);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    if (active) {
      setScrollButton(el, !bottomScroll.checkSticky(), () => {
        bottomScroll.scrollToBottom({ mode: 'follow', forceSticky: true });
      });
    }
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (hideTimer) clearTimeout(hideTimer);
      if (_scrollBtn.el === el) setScrollButton(null, false, null);
    };
  }, [active, bottomScroll, path]);

  // prepend 后保持滚动位置：监听 items 变化，如果头部变了就修正 scrollTop
  const prevFirstId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const firstId = items.find((item) => item.type === 'message')?.data.id;
    const el = ref.current;
    if (el && prevFirstId.current && firstId !== prevFirstId.current) {
      // 头部 id 变了 → prepend 发生，修正 scrollTop 让原来的内容不跳
      const prevHeight = el.dataset.prevScrollHeight;
      if (prevHeight) {
        el.scrollTop += el.scrollHeight - Number(prevHeight);
      }
    }
    prevFirstId.current = firstId;
  }, [items]);

  // 在 loadingMore 变成 true 前快照 scrollHeight
  useEffect(() => {
    const el = ref.current;
    if (el && loadingMore) {
      el.dataset.prevScrollHeight = String(el.scrollHeight);
    }
  }, [loadingMore]);

  // 切到本面板（active 翻转为 true）时武装一次性 instant 落位：ResizeObserver 因 active 重订阅而
  // 触发的首次回调（以及切换后首屏媒体 reflow）会瞬时收口到底，而非带动画 follow，消除"先画错位一帧再补跳"。
  // 后续流式增长仍走平滑 follow。
  useLayoutEffect(() => {
    if (active) bottomScroll.armInstantLanding();
  }, [active, bottomScroll]);

  // 首次有内容 → 滚到底（layout 阶段，先于 paint，避免首屏跳动）
  const scrolledOnce = useRef(false);
  useLayoutEffect(() => {
    if (scrolledOnce.current) return;
    if (items.length > 0) {
      bottomScroll.scrollToBottom({ mode: 'instant', forceSticky: true });
      scrolledOnce.current = true;
    }
  }, [bottomScroll, items.length]);

  // 只有用户自己发出新消息时才恢复 sticky；assistant/tool 流式追加必须尊重用户上滑。
  const prevLen = useRef(items.length);
  useEffect(() => {
    if (items.length > prevLen.current && active) {
      const last = items[items.length - 1];
      if (last?.type === 'message' && last.data.role === 'user') {
        bottomScroll.scrollToBottom({ mode: 'instant', forceSticky: true });
      } else {
        bottomScroll.followBottom();
      }
    }
    prevLen.current = items.length;
  }, [items, items.length, active, bottomScroll]);

  return (
    <div
      className={styles.sessionShell}
      onPointerMove={handleShellPointerMove}
      onPointerLeave={handleShellPointerLeave}
      style={{
        visibility: active ? 'visible' : 'hidden',
        zIndex: active ? 1 : 0,
        pointerEvents: active ? 'auto' : 'none',
      }}
    >
      <div
        ref={ref}
        className={styles.sessionPanel}
        data-chat-selection-root=""
        data-session-path={path}
        onPointerDown={boxSelection.onPointerDown}
        onClickCapture={boxSelection.onClickCapture}
        onMouseUp={handleCaptureSelection}
        onKeyUp={handleCaptureSelection}
      >
        <div
          ref={contentRef}
          className={`${styles.sessionMessages}${boxSelection.selectionModeActive ? ` ${styles.selectionModeActive}` : ''}`}
        >
          {hasMore && (
            <div className={styles.loadMoreHint}>
              {loadingMore ? '...' : ''}
            </div>
          )}
          <ChatTranscript
            items={items}
            sessionPath={path}
            agentId={sessionAgentId}
            readOnly={sessionReadOnly}
            registerMessageElement={registerMessageElement}
            enableProcessFold
          />
          {isSessionStreaming && (
            <div className={styles.typingIndicator} />
          )}
          <div className={styles.sessionFooter} />
        </div>
      </div>
      <ChatTimelineNavigator
        anchors={timelineAnchors}
        scrollRef={ref}
        contentRef={contentRef}
        messageElementsRef={messageElementsRef}
        active={active}
        railVisible={timelineRailVisible}
      />
      {boxSelection.box && (
        <div
          className={styles.selectionBox}
          style={{
            left: boxSelection.box.left,
            top: boxSelection.box.top,
            width: boxSelection.box.right - boxSelection.box.left,
            height: boxSelection.box.bottom - boxSelection.box.top,
          }}
        />
      )}
    </div>
  );
});

// ── ScrollToBottom 按钮 ──

const _scrollBtn = {
  el: null as HTMLElement | null,
  visible: false,
  scrollToBottom: null as (() => void) | null,
  listeners: [] as (() => void)[],
};

function setScrollButton(el: HTMLElement | null, visible: boolean, scrollToBottom: (() => void) | null) {
  _scrollBtn.el = el;
  _scrollBtn.visible = visible;
  _scrollBtn.scrollToBottom = scrollToBottom;
  _scrollBtn.listeners.forEach(listener => listener());
}

function ScrollToBottomBtn() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = () => setVisible(_scrollBtn.visible);
    _scrollBtn.listeners.push(update);
    return () => { _scrollBtn.listeners = _scrollBtn.listeners.filter(f => f !== update); };
  }, []);

  if (!visible) return null;
  return (
    <button className={styles.scrollToBottomFab} onClick={() => {
      _scrollBtn.scrollToBottom?.();
    }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}
