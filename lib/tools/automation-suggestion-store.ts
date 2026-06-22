function clonePlain<T>(value: T): T {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as T;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function defaultShortCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export class AutomationSuggestionStore {
  declare _entries: Map<string, any>;
  declare _generateShortCode: () => string;
  declare _sequence: number;

  constructor({ generateShortCode = defaultShortCode }: { generateShortCode?: () => string } = {}) {
    this._entries = new Map();
    this._generateShortCode = generateShortCode;
    this._sequence = 0;
  }

  create(entry: {
    sessionPath?: string | null;
    bridgeSessionKey?: string | null;
    operation?: "create" | "update";
    jobData: Record<string, unknown>;
    apply: (value?: unknown) => unknown;
  }) {
    if (!entry || typeof entry !== "object") throw new Error("automation suggestion entry is required");
    if (typeof entry.apply !== "function") throw new Error("automation suggestion apply function is required");
    const suggestionId = `automation_${Date.now().toString(36)}_${(++this._sequence).toString(36)}`;
    const shortCode = this._nextShortCode();
    const stored = {
      suggestionId,
      shortCode,
      sessionPath: text(entry.sessionPath) || null,
      bridgeSessionKey: text(entry.bridgeSessionKey) || null,
      operation: entry.operation === "update" ? "update" : "create",
      jobData: clonePlain(entry.jobData || {}),
      apply: entry.apply,
      createdAt: Date.now(),
    };
    this._entries.set(suggestionId, stored);
    return this._publicEntry(stored);
  }

  get(ref: string) {
    const entry = this._find({ ref });
    return entry ? this._publicEntry(entry) : null;
  }

  list(filter: { sessionPath?: string | null; bridgeSessionKey?: string | null } = {}) {
    return [...this._entries.values()]
      .filter((entry) => this._matchesScope(entry, filter))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => this._publicEntry(entry));
  }

  async apply({
    sessionPath = null,
    bridgeSessionKey = null,
    ref = null,
    value = undefined,
  }: {
    sessionPath?: string | null;
    bridgeSessionKey?: string | null;
    ref?: string | null;
    value?: unknown;
  } = {}) {
    const entry = this._find({ sessionPath, bridgeSessionKey, ref });
    if (!entry) return { ok: false, reason: "not-found" };
    const result = await entry.apply(value);
    this._entries.delete(entry.suggestionId);
    return {
      ok: true,
      suggestion: this._publicEntry(entry),
      result,
    };
  }

  _nextShortCode() {
    for (let i = 0; i < 200; i += 1) {
      const code = text(this._generateShortCode()) || defaultShortCode();
      if (![...this._entries.values()].some((entry) => entry.shortCode === code)) return code;
    }
    return String(10000 + this._sequence);
  }

  _find({ sessionPath = null, bridgeSessionKey = null, ref = null }: {
    sessionPath?: string | null;
    bridgeSessionKey?: string | null;
    ref?: string | null;
  }) {
    const scope = { sessionPath, bridgeSessionKey };
    const candidates = [...this._entries.values()]
      .filter((entry) => this._matchesScope(entry, scope))
      .sort((a, b) => b.createdAt - a.createdAt);
    if (!candidates.length) return null;
    const normalizedRef = text(ref);
    if (!normalizedRef) return candidates[0];
    return candidates.find((entry) => (
      entry.shortCode === normalizedRef
      || entry.suggestionId === normalizedRef
    )) || null;
  }

  _matchesScope(entry: any, filter: { sessionPath?: string | null; bridgeSessionKey?: string | null }) {
    const bridgeSessionKey = text(filter.bridgeSessionKey);
    if (bridgeSessionKey) return entry.bridgeSessionKey === bridgeSessionKey;
    const sessionPath = text(filter.sessionPath);
    if (sessionPath) return entry.sessionPath === sessionPath;
    return false;
  }

  _publicEntry(entry: any) {
    return {
      suggestionId: entry.suggestionId,
      shortCode: entry.shortCode,
      sessionPath: entry.sessionPath,
      bridgeSessionKey: entry.bridgeSessionKey,
      operation: entry.operation,
      jobData: clonePlain(entry.jobData),
      createdAt: entry.createdAt,
    };
  }
}
