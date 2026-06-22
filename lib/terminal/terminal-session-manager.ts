import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../../shared/safe-fs.ts";
import { randomBytes } from "crypto";
import { assertExecutionCwd } from "../shell/execution-cwd.ts";

const TERMINAL_ROOT = path.join(".ephemeral", "terminal-sessions");

function defaultNow() {
  return Date.now();
}

async function createDefaultBackend() {
  const mod = await import("./node-pty-backend.ts");
  return mod.createAsyncNodePtyBackend();
}

async function createDefaultSshBackend() {
  const mod = await import("./ssh-terminal-backend.ts");
  return mod.createSshTerminalBackend();
}

function terminalId() {
  return `term_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function asNonEmptyString(value, name) {
  const text = typeof value === "string" ? value : "";
  if (!text.trim()) throw new Error(`${name} is required`);
  return text;
}

function normalizeString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeRemoteCwd(value) {
  const text = String(value || "").replace(/\\/g, "/").trim();
  if (!text.startsWith("/")) throw new Error("SSH cwd must be an absolute POSIX path");
  return path.posix.normalize(text) || "/";
}

function publicEntry(entry) {
  return {
    terminalId: entry.terminalId,
    sessionPath: entry.sessionPath,
    agentId: entry.agentId,
    provider: entry.provider || "local",
    workspaceMountId: entry.workspaceMountId || null,
    remoteAuthority: entry.remoteAuthority || null,
    cwd: entry.cwd,
    command: entry.command,
    startupCommand: entry.startupCommand || "",
    profile: entry.profile || "shell",
    label: entry.label,
    status: entry.status,
    seq: entry.seq,
    createdAt: entry.createdAt,
    lastActivityAt: entry.lastActivityAt,
    exitedAt: entry.exitedAt ?? null,
    exitCode: entry.exitCode ?? null,
    signal: entry.signal ?? null,
    transcriptPath: entry.transcriptPath,
  };
}

export class TerminalSessionManager {

declare _backendPromise: any;

declare _bySession: any;

declare _createBackend: any;

declare _createSshBackend: any;

declare _emitEvent: any;

declare _getSessionIdForPath: any;

declare _now: any;

declare _sshBackendPromise: any;

declare _terminals: any;

declare hanakoHome: any;

declare root: any;
  constructor({
    hanakoHome,
    createBackend = createDefaultBackend,
    createSshBackend = createDefaultSshBackend,
    getSessionIdForPath = null,
    now = defaultNow,
    emitEvent = null,
  }: any = {}) {
    this.hanakoHome = asNonEmptyString(hanakoHome, "hanakoHome");
    this.root = path.join(this.hanakoHome, TERMINAL_ROOT);
    this._createBackend = createBackend;
    this._createSshBackend = createSshBackend;
    this._getSessionIdForPath = typeof getSessionIdForPath === "function" ? getSessionIdForPath : () => null;
    this._now = now;
    this._emitEvent = emitEvent;
    this._backendPromise = null;
    this._sshBackendPromise = null;
    this._terminals = new Map();
    this._bySession = new Map();
    fs.mkdirSync(this.root, { recursive: true });
    this._loadPersistedTerminals();
  }

  async start({
    sessionPath,
    agentId = "",
    cwd,
    command = "",
    startupCommand = "",
    profile = "shell",
    label = "",
    cols = 80,
    rows = 24,
    env,
    provider = "local",
    workspaceMountId = null,
    rootLocator = null,
    remoteAuthority = null,
  }: any = {}) {
    const normalizedSessionPath = asNonEmptyString(sessionPath, "sessionPath");
    const normalizedProvider = provider === "ssh" ? "ssh" : "local";
    const normalizedCwd = normalizedProvider === "ssh"
      ? normalizeRemoteCwd(asNonEmptyString(cwd, "cwd"))
      : assertExecutionCwd(asNonEmptyString(cwd, "cwd"));
    const id = terminalId();
    const now = this._now();
    const entry = {
      terminalId: id,
      sessionPath: normalizedSessionPath,
      agentId: normalizeString(agentId),
      provider: normalizedProvider,
      workspaceMountId: normalizeString(workspaceMountId) || null,
      remoteAuthority: normalizeString(remoteAuthority) || null,
      cwd: normalizedCwd,
      command: normalizeString(command),
      startupCommand: normalizeString(startupCommand),
      profile: normalizeString(profile) || "shell",
      label: normalizeString(label),
      status: "running",
      seq: 0,
      createdAt: now,
      lastActivityAt: now,
      exitedAt: null,
      exitCode: null,
      signal: null,
      transcriptPath: this._transcriptPath(id),
      handle: null,
      rootLocator: normalizedProvider === "ssh" ? rootLocator : null,
    };

    this._terminals.set(id, entry);
    this._index(entry);
    try {
      const backend = normalizedProvider === "ssh" ? await this._getSshBackend() : await this._getBackend();
      entry.handle = backend.spawn({
        terminalId: id,
        sessionPath: normalizedSessionPath,
        provider: normalizedProvider,
        workspaceMountId: entry.workspaceMountId,
        rootLocator: entry.rootLocator,
        remoteAuthority: entry.remoteAuthority,
        command: entry.command,
        startupCommand: entry.startupCommand,
        profile: entry.profile,
        cwd: normalizedCwd,
        cols,
        rows,
        env,
        onData: (data) => this._recordData(id, data),
        onExit: (result) => this._markExited(id, result),
      });
      if (entry.startupCommand && typeof entry.handle?.write === "function") {
        entry.handle.write(entry.startupCommand.endsWith("\n") ? entry.startupCommand : `${entry.startupCommand}\n`);
      }
      this._persist(entry);
      this._emit("terminal_started", entry);
    } catch (err) {
      this._terminals.delete(id);
      this._bySession.get(this._sessionKeyForPath(normalizedSessionPath))?.delete(id);
      throw err;
    }
    return { ...publicEntry(entry), output: "" };
  }

  write({ sessionPath, terminalId, chars }: any = {}) {
    const entry = this._requireOwned({ sessionPath, terminalId });
    if (entry.status !== "running") {
      throw new Error(`terminal ${entry.terminalId} is not running`);
    }
    if (!entry.handle || typeof entry.handle.write !== "function") {
      throw new Error(`terminal ${entry.terminalId} has no live PTY handle`);
    }
    const sinceSeq = entry.seq;
    entry.handle.write(normalizeString(chars));
    return this.read({ sessionPath: entry.sessionPath, terminalId: entry.terminalId, sinceSeq });
  }

  read({ sessionPath, terminalId, sinceSeq = 0 }: any = {}) {
    const entry = this._requireOwned({ sessionPath, terminalId });
    const chunks = this._readTranscript(entry.transcriptPath, sinceSeq);
    return {
      ...publicEntry(entry),
      output: chunks.map((chunk) => chunk.data).join(""),
      chunks,
    };
  }

  close({ sessionPath, terminalId }: any = {}) {
    const entry = this._requireOwned({ sessionPath, terminalId });
    if (entry.status === "running") {
      entry.status = "killed";
      entry.exitedAt = this._now();
      entry.lastActivityAt = entry.exitedAt;
      try {
        if (typeof entry.handle?.dispose === "function") {
          entry.handle.dispose({
            terminalId: entry.terminalId,
            sessionPath: entry.sessionPath,
            reason: "close",
          });
        } else {
          entry.handle?.kill?.();
        }
      } finally {
        this._persist(entry);
        this._emit("terminal_closed", entry);
      }
    }
    return { ...publicEntry(entry), output: "" };
  }

  closeForSession(sessionPath) {
    const normalizedSessionPath = asNonEmptyString(sessionPath, "sessionPath");
    const ids = [...(this._bySession.get(this._sessionKeyForPath(normalizedSessionPath)) || [])];
    return ids.map((id) => this.close({
      sessionPath: normalizedSessionPath,
      terminalId: id,
    }));
  }

  closeAll() {
    const ids = [...this._terminals.keys()];
    return ids
      .map((id) => this._terminals.get(id))
      .filter(Boolean)
      .map((entry) => this.close({
        sessionPath: entry.sessionPath,
        terminalId: entry.terminalId,
      }));
  }

  list(sessionPath) {
    const normalizedSessionPath = asNonEmptyString(sessionPath, "sessionPath");
    const ids = this._bySession.get(this._sessionKeyForPath(normalizedSessionPath)) || new Set();
    const terminals = [...ids]
      .map((id) => this._terminals.get(id))
      .filter(Boolean)
      .map((entry) => this._entryMatchesSessionPath(entry, normalizedSessionPath)
        ? publicEntry({ ...entry, sessionPath: normalizedSessionPath })
        : publicEntry(entry))
      .sort((a, b) => a.createdAt - b.createdAt);
    return { sessionPath: normalizedSessionPath, terminals };
  }

  _getBackend() {
    if (!this._backendPromise) {
      this._backendPromise = Promise.resolve(this._createBackend());
    }
    return this._backendPromise;
  }

  _getSshBackend() {
    if (!this._sshBackendPromise) {
      this._sshBackendPromise = Promise.resolve(this._createSshBackend());
    }
    return this._sshBackendPromise;
  }

  _requireOwned({ sessionPath, terminalId }) {
    const id = asNonEmptyString(terminalId, "terminalId");
    const normalizedSessionPath = asNonEmptyString(sessionPath, "sessionPath");
    const entry = this._terminals.get(id);
    if (!entry) throw new Error(`terminal ${id} not found`);
    if (!this._entryMatchesSessionPath(entry, normalizedSessionPath)) {
      throw new Error(`terminal ${id} belongs to another session`);
    }
    if (entry.sessionPath !== normalizedSessionPath) {
      entry.sessionPath = normalizedSessionPath;
      this._persist(entry);
    }
    return entry;
  }

  _sessionKeyForPath(sessionPath) {
    const sessionId = this._getSessionIdForPath?.(sessionPath);
    return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : sessionPath;
  }

  _entryMatchesSessionPath(entry, sessionPath) {
    return this._sessionKeyForPath(entry.sessionPath) === this._sessionKeyForPath(sessionPath);
  }

  _index(entry) {
    const key = this._sessionKeyForPath(entry.sessionPath);
    if (!this._bySession.has(key)) {
      this._bySession.set(key, new Set());
    }
    this._bySession.get(key).add(entry.terminalId);
  }

  _metadataPath(id) {
    return path.join(this.root, `${id}.json`);
  }

  _transcriptPath(id) {
    return path.join(this.root, `${id}.jsonl`);
  }

  _persist(entry) {
    fs.mkdirSync(this.root, { recursive: true });
    atomicWriteSync(this._metadataPath(entry.terminalId), JSON.stringify(publicEntry(entry), null, 2));
  }

  _appendTranscript(entry, data) {
    fs.mkdirSync(path.dirname(entry.transcriptPath), { recursive: true });
    fs.appendFileSync(entry.transcriptPath, JSON.stringify({
      seq: entry.seq,
      ts: entry.lastActivityAt,
      data,
    }) + "\n");
  }

  _recordData(id, data) {
    const entry = this._terminals.get(id);
    if (!entry) return;
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
    if (!text) return;
    entry.seq += 1;
    entry.lastActivityAt = this._now();
    this._appendTranscript(entry, text);
    this._persist(entry);
    this._emit("terminal_output", entry, { seq: entry.seq, data: text });
  }

  _markExited(id, result: any = {}) {
    const entry = this._terminals.get(id);
    if (!entry) return;
    if (entry.status === "running") {
      entry.status = "exited";
    }
    entry.exitCode = Number.isFinite(result.exitCode) ? result.exitCode : null;
    entry.signal = typeof result.signal === "string" ? result.signal : null;
    entry.exitedAt = this._now();
    entry.lastActivityAt = entry.exitedAt;
    entry.handle = null;
    this._persist(entry);
    this._emit("terminal_exited", entry);
  }

  _readTranscript(transcriptPath, sinceSeq = 0) {
    if (!fs.existsSync(transcriptPath)) return [];
    const minSeq = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0;
    const raw = fs.readFileSync(transcriptPath, "utf8");
    const chunks = [];
    for (const line of raw.split(/\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (Number(item.seq) > minSeq) chunks.push(item);
      } catch {}
    }
    return chunks;
  }

  _loadPersistedTerminals() {
    if (!fs.existsSync(this.root)) return;
    for (const file of fs.readdirSync(this.root)) {
      if (!file.endsWith(".json")) continue;
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(this.root, file), "utf8"));
        if (!entry?.terminalId || !entry?.sessionPath) continue;
        const restored = {
          ...entry,
          status: entry.status === "running" ? "stale" : entry.status,
          handle: null,
          transcriptPath: entry.transcriptPath || this._transcriptPath(entry.terminalId),
        };
        this._terminals.set(restored.terminalId, restored);
        this._index(restored);
        if (restored.status !== entry.status) this._persist(restored);
      } catch {}
    }
  }

  _emit(type, entry, extra: any = {}) {
    this._emitEvent?.({
      type,
      terminalId: entry.terminalId,
      status: entry.status,
      seq: entry.seq,
      ...(extra || {}),
    }, entry.sessionPath);
  }
}
