import { sessionScopedKey, sessionScopedListIncludes, type SessionLocatorState } from './session-slice';

export interface ContextSlice {
  /** Context usage — token count for the current session */
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  /** 按 session identity key 存储的 context usage（读旧 path key 兼容） */
  contextBySession: Record<string, { tokens: number | null; window: number | null; percent: number | null }>;
  /** Session identity keys currently undergoing compaction */
  compactingSessions: string[];
  addCompactingSession: (path: string) => void;
  removeCompactingSession: (path: string) => void;
}

export const createContextSlice = (
  set: (partial: Partial<ContextSlice> | ((s: ContextSlice) => Partial<ContextSlice>)) => void
): ContextSlice => ({
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  contextBySession: {},
  compactingSessions: [],
  addCompactingSession: (path) => set((s) => {
    const key = sessionScopedKey(s as ContextSlice & SessionLocatorState, path) || path;
    const compactingSessions = s.compactingSessions.filter((item) => item !== key && item !== path);
    return { compactingSessions: [...compactingSessions, key] };
  }),
  removeCompactingSession: (path) => set((s) => {
    const key = sessionScopedKey(s as ContextSlice & SessionLocatorState, path) || path;
    return { compactingSessions: s.compactingSessions.filter(p => p !== key && p !== path) };
  }),
});

// ── Selectors ──
export const selectContextTokens = (s: ContextSlice) => s.contextTokens;
export const selectContextWindow = (s: ContextSlice) => s.contextWindow;
export const selectContextPercent = (s: ContextSlice) => s.contextPercent;

export function isSessionCompacting(
  state: ContextSlice & SessionLocatorState,
  sessionPath: string | null | undefined,
): boolean {
  return sessionScopedListIncludes(state, state.compactingSessions, sessionPath);
}
