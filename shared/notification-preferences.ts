export type TurnCompletionNotificationMode = "never" | "when_unfocused" | "when_session_unfocused";

export interface NotificationPreferences {
  turnCompletion: TurnCompletionNotificationMode;
}

const TURN_COMPLETION_NEVER: TurnCompletionNotificationMode = "never";
const TURN_COMPLETION_WHEN_UNFOCUSED: TurnCompletionNotificationMode = "when_unfocused";
const TURN_COMPLETION_WHEN_SESSION_UNFOCUSED: TurnCompletionNotificationMode = "when_session_unfocused";

export const TURN_COMPLETION_NOTIFICATION_MODES: readonly TurnCompletionNotificationMode[] = Object.freeze([
  TURN_COMPLETION_NEVER,
  TURN_COMPLETION_WHEN_UNFOCUSED,
  TURN_COMPLETION_WHEN_SESSION_UNFOCUSED,
]);

export function normalizeTurnCompletionNotificationMode(value: unknown): TurnCompletionNotificationMode {
  return TURN_COMPLETION_NOTIFICATION_MODES.includes(value as TurnCompletionNotificationMode)
    ? (value as TurnCompletionNotificationMode)
    : TURN_COMPLETION_NEVER;
}

export function normalizeNotificationPreferences(value: unknown = {}): NotificationPreferences {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    turnCompletion: normalizeTurnCompletionNotificationMode(source.turnCompletion),
  };
}

export function mergeNotificationPreferences(existing: unknown = {}, patch: unknown = {}): NotificationPreferences {
  return normalizeNotificationPreferences({
    ...normalizeNotificationPreferences(existing),
    ...(patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}),
  });
}
