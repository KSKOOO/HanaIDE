import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type RefObject,
} from 'react';

type ScrollMode = 'instant' | 'follow' | 'smooth';

interface ScrollToBottomOptions {
  mode?: ScrollMode;
  forceSticky?: boolean;
}

interface UseContinuousBottomScrollOptions {
  scrollRef: RefObject<HTMLElement | null>;
  contentRef?: RefObject<HTMLElement | null>;
  active?: boolean;
  stickyThreshold?: number;
  largeJumpPx?: number;
}

export interface ContinuousBottomScrollController {
  isStickyRef: MutableRefObject<boolean>;
  checkSticky: () => boolean;
  markSticky: () => void;
  cancelFollow: () => void;
  followBottom: () => void;
  scrollToBottom: (options?: ScrollToBottomOptions) => void;
  /**
   * Arm a one-shot "instant landing": the very next bottom-follow (whether driven by the
   * ResizeObserver content callback or an explicit `followBottom()` call) snaps straight to the
   * bottom instead of animating, then disarms. Use this when switching/hydrating a session so the
   * first fill lands without a visible scroll animation, while subsequent streaming growth keeps
   * the smooth follow. Honors sticky: if the user has scrolled up, nothing moves.
   */
  armInstantLanding: () => void;
}

const DEFAULT_STICKY_THRESHOLD = 48;
const DEFAULT_LARGE_JUMP_PX = 720;
const FOLLOW_TIME_CONSTANT_MS = 85;

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function maxScrollTop(el: HTMLElement): number {
  return Math.max(0, finiteNumber(el.scrollHeight) - finiteNumber(el.clientHeight));
}

function distanceFromBottom(el: HTMLElement): number {
  return maxScrollTop(el) - finiteNumber(el.scrollTop);
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useContinuousBottomScroll({
  scrollRef,
  contentRef,
  active = true,
  stickyThreshold = DEFAULT_STICKY_THRESHOLD,
  largeJumpPx = DEFAULT_LARGE_JUMP_PX,
}: UseContinuousBottomScrollOptions): ContinuousBottomScrollController {
  const isStickyRef = useRef(true);
  const activeRef = useRef(active);
  const thresholdRef = useRef(stickyThreshold);
  const largeJumpRef = useRef(largeJumpPx);
  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);
  const followingRef = useRef(false);
  const instantLandingArmedRef = useRef(false);

  activeRef.current = active;
  thresholdRef.current = stickyThreshold;
  largeJumpRef.current = largeJumpPx;

  const stopFollow = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    followingRef.current = false;
    lastFrameTimeRef.current = null;
  }, []);

  const checkSticky = useCallback(() => {
    if (followingRef.current) return isStickyRef.current;
    const el = scrollRef.current;
    if (!el) return isStickyRef.current;
    const sticky = distanceFromBottom(el) <= finiteNumber(thresholdRef.current, DEFAULT_STICKY_THRESHOLD);
    isStickyRef.current = sticky;
    return sticky;
  }, [scrollRef]);

  const markSticky = useCallback(() => {
    isStickyRef.current = true;
  }, []);

  const cancelFollow = useCallback(() => {
    stopFollow();
    isStickyRef.current = false;
    instantLandingArmedRef.current = false;
  }, [stopFollow]);

  const armInstantLanding = useCallback(() => {
    instantLandingArmedRef.current = true;
  }, []);

  const runFrame = useCallback((time: number) => {
    const el = scrollRef.current;
    if (!el || !activeRef.current || !isStickyRef.current) {
      stopFollow();
      return;
    }

    const target = maxScrollTop(el);
    const current = finiteNumber(el.scrollTop);
    const delta = target - current;

    if (Math.abs(delta) <= 0.5 || delta < 0) {
      el.scrollTop = target;
      stopFollow();
      return;
    }

    const largeJump = finiteNumber(largeJumpRef.current, DEFAULT_LARGE_JUMP_PX);
    if (delta > largeJump || prefersReducedMotion()) {
      el.scrollTop = target;
      stopFollow();
      return;
    }

    followingRef.current = true;
    const safeTime = finiteNumber(time, finiteNumber(lastFrameTimeRef.current, 0) + 16);
    const previous = finiteNumber(lastFrameTimeRef.current, safeTime - 16);
    const dt = Math.max(1, safeTime - previous);
    lastFrameTimeRef.current = safeTime;
    const rawAlpha = 1 - Math.exp(-dt / FOLLOW_TIME_CONSTANT_MS);
    const alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1;
    el.scrollTop = current + delta * alpha;
    rafRef.current = window.requestAnimationFrame(runFrame);
  }, [scrollRef, stopFollow]);

  const followBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !activeRef.current || !isStickyRef.current) return;

    const target = maxScrollTop(el);
    const delta = target - finiteNumber(el.scrollTop);
    if (delta <= 0.5) {
      // Already at bottom: a no-op follow must NOT consume an armed instant landing — the arm is
      // reserved for the first *meaningful* growth (the async hydrate after a switch).
      el.scrollTop = target;
      return;
    }

    // First fill after a session switch/hydrate: snap to bottom synchronously instead of
    // animating from a mid position, then disarm so subsequent streaming growth animates normally.
    if (instantLandingArmedRef.current) {
      instantLandingArmedRef.current = false;
      el.scrollTop = target;
      stopFollow();
      return;
    }

    const largeJump = finiteNumber(largeJumpRef.current, DEFAULT_LARGE_JUMP_PX);
    if (delta > largeJump || prefersReducedMotion()) {
      el.scrollTop = target;
      stopFollow();
      return;
    }

    if (rafRef.current !== null) return;
    lastFrameTimeRef.current = null;
    followingRef.current = true;
    rafRef.current = window.requestAnimationFrame(runFrame);
  }, [runFrame, scrollRef, stopFollow]);

  const scrollToBottom = useCallback((options: ScrollToBottomOptions = {}) => {
    const el = scrollRef.current;
    if (!el) return;
    if (options.forceSticky) markSticky();
    stopFollow();

    const mode = options.mode ?? 'instant';
    if (mode === 'instant') {
      el.scrollTop = maxScrollTop(el);
      return;
    }
    followBottom();
  }, [followBottom, markSticky, scrollRef, stopFollow]);

  useEffect(() => {
    if (!active) stopFollow();
  }, [active, stopFollow]);

  useEffect(() => stopFollow, [stopFollow]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !active) return undefined;

    const onScroll = () => {
      if (followingRef.current) return;
      checkSticky();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) cancelFollow();
    };
    const onTouchStart = () => cancelFollow();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
        cancelFollow();
      }
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    onScroll();

    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('keydown', onKeyDown);
    };
  }, [active, cancelFollow, checkSticky, scrollRef]);

  useLayoutEffect(() => {
    const ResizeObserverImpl = window.ResizeObserver;
    const target = contentRef?.current ?? scrollRef.current;
    if (!active || !target || !ResizeObserverImpl) return undefined;

    const observer = new ResizeObserverImpl(() => {
      followBottom();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [active, contentRef, followBottom, scrollRef]);

  return useMemo(() => ({
    isStickyRef,
    checkSticky,
    markSticky,
    cancelFollow,
    followBottom,
    scrollToBottom,
    armInstantLanding,
  }), [armInstantLanding, cancelFollow, checkSticky, followBottom, markSticky, scrollToBottom]);
}
