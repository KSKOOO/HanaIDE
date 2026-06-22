import fs from "fs";

export const DEFAULT_SESSION_JSONL_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_SESSION_JSONL_MAX_STRING_CHARS = 8192;
const DEFAULT_SESSION_JSONL_MAX_ARRAY_ITEMS = 128;
const DEFAULT_SESSION_JSONL_MAX_OBJECT_KEYS = 128;
const LARGE_SESSION_ENTRY_KEYS = new Set([
  "base64",
  "content",
  "data",
  "inlineData",
  "partialArgs",
  "snapshot",
  "text",
  "thumbnail",
]);
const TOOL_ARG_KEYS = new Set(["arguments", "args", "input"]);

/**
 * Parse a Pi SDK session JSONL file into entries. Oversized lines are projected
 * before callers can rewrite them; invalid files still return null.
 *
 * @param {string} raw
 * @param {object} [opts]
 * @param {number} [opts.maxLineBytes]
 * @returns {Array|null}
 */
export function parseSessionEntries(raw, opts: { maxLineBytes?: number } = {}) {
  const maxLineBytes = Math.max(1024, opts.maxLineBytes || DEFAULT_SESSION_JSONL_MAX_LINE_BYTES);
  const entries = [];
  const lines = String(raw || "").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(parseSessionLine(line, maxLineBytes).entry);
    } catch {
      return null;
    }
  }
  if (entries.length === 0) return null;
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string") {
    return null;
  }
  return entries;
}

function parseSessionLine(line, maxLineBytes) {
  const byteLength = Buffer.byteLength(line, "utf8");
  const parsed = JSON.parse(line);
  if (byteLength <= maxLineBytes) {
    return { entry: parsed, projected: false, byteLength };
  }
  const projected = projectOversizedSessionEntry(parsed, { originalByteLength: byteLength });
  return { entry: projected, projected: true, byteLength };
}

export function projectOversizedSessionEntry(entry, { originalByteLength = null } = {}) {
  const projected = projectSessionValue(entry, new Set(), {
    inToolArgs: false,
    originalByteLength,
  });
  if (projected && typeof projected === "object" && !Array.isArray(projected)) {
    return {
      ...projected,
      hanaRepair: {
        ...(projected.hanaRepair || {}),
        oversizedLineProjected: true,
        ...(originalByteLength ? { originalByteLength } : {}),
      },
    };
  }
  return projected;
}

export function repairOversizedSessionEntries(entries, opts: { maxLineBytes?: number } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { entries, projected: 0 };
  }
  const maxLineBytes = Math.max(1024, opts.maxLineBytes || DEFAULT_SESSION_JSONL_MAX_LINE_BYTES);
  let projected = 0;
  const repaired = entries.map((entry) => {
    const line = JSON.stringify(entry);
    const byteLength = Buffer.byteLength(line, "utf8");
    if (byteLength <= maxLineBytes) return entry;
    projected += 1;
    return projectOversizedSessionEntry(entry, { originalByteLength: byteLength });
  });
  return {
    entries: projected > 0 ? repaired : entries,
    projected,
  };
}

function projectSessionValue(value, seen, context) {
  if (typeof value === "string") {
    const limit = context.inToolArgs ? 512 : DEFAULT_SESSION_JSONL_MAX_STRING_CHARS;
    if (value.length <= limit) return value;
    return `[omitted ${value.length} chars by Hana session JSONL guard]`;
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value
      .slice(0, DEFAULT_SESSION_JSONL_MAX_ARRAY_ITEMS)
      .map((item) => projectSessionValue(item, seen, context));
    if (value.length > DEFAULT_SESSION_JSONL_MAX_ARRAY_ITEMS) {
      items.push(`[omitted ${value.length - DEFAULT_SESSION_JSONL_MAX_ARRAY_ITEMS} items by Hana session JSONL guard]`);
    }
    seen.delete(value);
    return items;
  }

  const out: Record<string, any> = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= DEFAULT_SESSION_JSONL_MAX_OBJECT_KEYS) {
      out._omittedKeys = Object.keys(value).length - count;
      break;
    }
    count += 1;
    const inToolArgs = context.inToolArgs || TOOL_ARG_KEYS.has(key);
    if ((LARGE_SESSION_ENTRY_KEYS.has(key) || inToolArgs) && typeof item === "string" && item.length > 512) {
      out[key] = `[omitted ${item.length} chars by Hana session JSONL guard]`;
      continue;
    }
    out[key] = projectSessionValue(item, seen, { ...context, inToolArgs });
  }
  seen.delete(value);
  return out;
}

/**
 * Serialize entries in the same line-oriented format SessionManager._rewriteFile
 * uses, including a single trailing newline.
 *
 * @param {Array} entries
 * @returns {string}
 */
export function serializeSessionEntries(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/**
 * @param {string} sessionPath
 * @returns {{ raw: string, entries: Array } | null}
 */
export function readSessionEntriesFile(sessionPath) {
  let raw;
  try {
    raw = fs.readFileSync(sessionPath, "utf-8");
  } catch {
    return null;
  }

  const entries = parseSessionEntries(raw);
  if (!entries) return null;
  return { raw, entries };
}

/**
 * Repair oversized JSONL lines before SessionManager.open reads the whole file.
 * A copy of the original file is kept next to the session for audit/recovery.
 *
 * @param {string} sessionPath
 * @param {object} [opts]
 * @param {number} [opts.maxLineBytes]
 * @returns {{repaired: boolean, projected: number, skipped: number, backupPath: string|null}}
 */
export function repairOversizedSessionEntriesInFile(sessionPath, opts: { maxLineBytes?: number } = {}) {
  const maxLineBytes = Math.max(1024, opts.maxLineBytes || DEFAULT_SESSION_JSONL_MAX_LINE_BYTES);
  let raw;
  try {
    raw = fs.readFileSync(sessionPath, "utf-8");
  } catch {
    return { repaired: false, projected: 0, skipped: 0, backupPath: null };
  }

  let changed = false;
  let skipped = 0;
  const entries = [];
  for (const line of String(raw || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      entries.push(parsed);
    } catch {
      skipped += 1;
      changed = true;
    }
  }

  if (entries.length === 0) {
    return { repaired: false, projected: 0, skipped: 0, backupPath: null };
  }
  const repairedEntries = repairOversizedSessionEntries(entries, { maxLineBytes });
  if (repairedEntries.projected > 0) changed = true;
  if (!changed) {
    return { repaired: false, projected: 0, skipped: 0, backupPath: null };
  }
  const header = repairedEntries.entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string") {
    return { repaired: false, projected: 0, skipped: 0, backupPath: null };
  }

  const backupPath = `${sessionPath}.repair.jsonl`;
  try {
    if (!fs.existsSync(backupPath)) fs.copyFileSync(sessionPath, backupPath);
    writeSessionEntriesFile(sessionPath, repairedEntries.entries);
  } catch {
    return { repaired: false, projected: 0, skipped: 0, backupPath: null };
  }
  return { repaired: true, projected: repairedEntries.projected, skipped, backupPath };
}

/**
 * @param {string} sessionPath
 * @param {Array} entries
 */
export function writeSessionEntriesFile(sessionPath, entries) {
  fs.writeFileSync(sessionPath, serializeSessionEntries(entries));
}

function hasAssistantEntry(entries) {
  return Array.isArray(entries)
    && entries.some((entry) => entry?.type === "message" && entry.message?.role === "assistant");
}

/**
 * Pi SDK keeps first-turn entries in memory until an assistant message arrives.
 * Hana needs the session file to exist earlier for sidebar, archive, restart,
 * and failed pre-prompt work such as auxiliary vision. This helper writes the
 * manager's current in-memory entries and marks the SDK manager as flushed so
 * the next assistant append does not duplicate the already-written prefix.
 */
export function flushSessionManagerSnapshot(sessionManager, {
  preAssistantOnly = false,
}: { preAssistantOnly?: boolean } = {}) {
  if (!sessionManager || typeof sessionManager !== "object") return false;
  if (typeof sessionManager._rewriteFile !== "function") return false;
  const entries = Array.isArray(sessionManager.fileEntries) ? sessionManager.fileEntries : null;
  if (!entries?.length) return false;
  if (preAssistantOnly && hasAssistantEntry(entries)) return false;
  sessionManager._rewriteFile();
  if ("flushed" in sessionManager) sessionManager.flushed = true;
  return true;
}

export function schedulePreAssistantSessionManagerFlush(sessionManager) {
  const enqueue = typeof queueMicrotask === "function"
    ? queueMicrotask
    : (fn) => Promise.resolve().then(fn);
  enqueue(() => {
    try {
      flushSessionManagerSnapshot(sessionManager, { preAssistantOnly: true });
    } catch {
      // Best-effort lifecycle persistence must not change prompt behavior.
    }
  });
}
