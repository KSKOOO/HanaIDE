import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_MANIFEST_DB_USER_VERSION,
  SessionManifestStore,
} from "../core/session-manifest/store.ts";
import { sessionLocatorKey } from "../core/session-manifest/path-normalizer.ts";

describe("SessionManifestStore", () => {
  let tmpDir;
  let store;
  let nextId;
  let nowIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-manifest-"));
    nextId = 1;
    nowIndex = 0;
    store = new SessionManifestStore({
      dbPath: path.join(tmpDir, "session-manifest.db"),
      idGenerator: () => `sess_test_${String(nextId++).padStart(4, "0")}`,
      now: () => `2026-06-18T00:00:${String(nowIndex++).padStart(2, "0")}.000Z`,
    });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSessionFile(name) {
    const sessionPath = path.join(tmpDir, "sessions", `${name}.jsonl`);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "");
    return sessionPath;
  }

  function linkDirectory(target, linkPath) {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  }

  it("creates one durable session identity for a session file path", () => {
    const sessionPath = createSessionFile("alpha");

    const manifest = store.createForPath({ sessionPath, domain: "home", kind: "chat" });
    const repeated = store.createForPath({ sessionPath, domain: "home", kind: "chat" });

    expect(manifest.sessionId).toBe("sess_test_0001");
    expect(repeated.sessionId).toBe(manifest.sessionId);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.domain).toBe("home");
    expect(manifest.kind).toBe("chat");
    expect(manifest.currentLocator.path).toBe(path.resolve(sessionPath));
    expect(manifest.currentLocator.key).toBe(sessionLocatorKey(sessionPath));
    expect(manifest.memoryPolicy).toEqual({ mode: "inherit", inheritedFrom: "agent_default" });
    expect(manifest.permissionModeSnapshot.mode).toBe("ask");
    expect(store.getBySessionId(manifest.sessionId)?.sessionId).toBe(manifest.sessionId);
    expect(store.resolveByLocatorPath(sessionPath)?.sessionId).toBe(manifest.sessionId);
    expect(store.db.pragma("user_version", { simple: true })).toBe(SESSION_MANIFEST_DB_USER_VERSION);
  });

  it("keeps previous locators resolvable when the session file moves", () => {
    const oldPath = createSessionFile("move-before");
    const nextPath = path.join(tmpDir, "archive", "move-after.jsonl");
    const manifest = store.createForPath({ sessionPath: oldPath, domain: "home" });
    const oldLocatorPath = path.resolve(oldPath);
    fs.mkdirSync(path.dirname(nextPath), { recursive: true });
    fs.renameSync(oldPath, nextPath);

    const moved = store.updateLocator(manifest.sessionId, nextPath, "archive");

    expect(moved.currentLocator.path).toBe(path.resolve(nextPath));
    expect(moved.currentLocator.reason).toBe("archive");
    expect(store.resolveByLocatorPath(oldPath)?.sessionId).toBe(manifest.sessionId);
    expect(store.resolveByLocatorPath(nextPath)?.sessionId).toBe(manifest.sessionId);
    expect(store.getLocatorHistory(manifest.sessionId)).toEqual([
      expect.objectContaining({
        path: oldLocatorPath,
        reason: "archive",
      }),
    ]);
  });

  it("updates manifest-owned policy, workspace, plugin, and thinking fields by session id", () => {
    const sessionPath = createSessionFile("fields");
    const manifest = store.createForPath({ sessionPath, domain: "home", kind: "chat" });

    store.setMemoryPolicy(manifest.sessionId, { mode: "disabled", inheritedFrom: "session_override" });
    store.setPermissionModeSnapshot(manifest.sessionId, { mode: "operate", source: "session_override" });
    store.setThinkingLevel(manifest.sessionId, "high");
    store.setWorkspaceScope(manifest.sessionId, {
      primaryCwd: tmpDir,
      workspaceFolders: [path.join(tmpDir, "workspace")],
      authorizedFolders: [path.join(tmpDir, "allowed")],
    });
    store.setPlugin(manifest.sessionId, {
      ownerPluginId: "image-gen",
      kind: "media",
      visibility: "private",
    });

    expect(store.getBySessionId(manifest.sessionId)).toMatchObject({
      memoryPolicy: { mode: "disabled", inheritedFrom: "session_override" },
      permissionModeSnapshot: { mode: "operate", source: "session_override" },
      thinkingLevel: "high",
      workspaceScope: {
        primaryCwd: tmpDir,
        workspaceFolders: [path.join(tmpDir, "workspace")],
        authorizedFolders: [path.join(tmpDir, "allowed")],
      },
      plugin: {
        ownerPluginId: "image-gen",
        kind: "media",
        visibility: "private",
      },
    });
  });

  it("stores capability snapshots by session id", () => {
    const sessionPath = createSessionFile("capabilities");
    const manifest = store.createForPath({ sessionPath, domain: "desktop", kind: "chat" });

    store.setCapabilitySnapshot(manifest.sessionId, {
      toolNames: ["read", "media_generate-image"],
      promptSnapshot: {
        version: 1,
        systemPrompt: "frozen prompt",
        appendSystemPrompt: [],
        skillsResult: { skills: [], diagnostics: [] },
        agentsFilesResult: { agentsFiles: [] },
      },
      capabilityDriftDismissedFingerprint: "fp-old",
    }, { source: "session_create" });

    expect(store.getCapabilitySnapshot(manifest.sessionId)).toMatchObject({
      sessionId: manifest.sessionId,
      source: "session_create",
      toolNames: ["read", "media_generate-image"],
      promptSnapshot: {
        systemPrompt: "frozen prompt",
      },
      capabilityDriftDismissedFingerprint: "fp-old",
    });
  });

  it("stores executor metadata by session id", () => {
    const sessionPath = createSessionFile("executor");
    const manifest = store.createForPath({ sessionPath, domain: "desktop", kind: "chat" });

    store.setExecutorMetadata(manifest.sessionId, {
      executorAgentId: "butter",
      executorAgentNameSnapshot: "Butter",
      executorMetaVersion: 1,
    }, { source: "subagent_runtime" });

    expect(store.getExecutorMetadata(manifest.sessionId)).toMatchObject({
      sessionId: manifest.sessionId,
      executorAgentId: "butter",
      executorAgentNameSnapshot: "Butter",
      executorMetaVersion: 1,
      source: "subagent_runtime",
    });
  });

  it("reports repairable conflicts instead of assigning one locator to two sessions", () => {
    const firstPath = createSessionFile("first");
    const secondPath = createSessionFile("second");
    const first = store.createForPath({ sessionPath: firstPath, domain: "home" });
    const second = store.createForPath({ sessionPath: secondPath, domain: "home" });

    expect(() => store.updateLocator(second.sessionId, firstPath, "repair")).toThrow(
      expect.objectContaining({
        code: "session_locator_conflict",
      }),
    );

    expect(store.resolveByLocatorPath(firstPath)?.sessionId).toBe(first.sessionId);
    expect(store.getBySessionId(second.sessionId)?.currentLocator.path).toBe(path.resolve(secondPath));
  });

  it("keeps the app-facing locator path when a session is reached through a symlinked directory", () => {
    const realSessionsDir = path.join(tmpDir, "external-sessions");
    const logicalSessionsDir = path.join(tmpDir, "agents", "hana", "sessions");
    fs.mkdirSync(realSessionsDir, { recursive: true });
    fs.mkdirSync(path.dirname(logicalSessionsDir), { recursive: true });
    linkDirectory(realSessionsDir, logicalSessionsDir);
    const realSessionPath = path.join(realSessionsDir, "linked.jsonl");
    const logicalSessionPath = path.join(logicalSessionsDir, "linked.jsonl");
    fs.writeFileSync(realSessionPath, "");

    const manifest = store.createForPath({ sessionPath: logicalSessionPath, domain: "desktop" });

    expect(manifest.currentLocator.path).toBe(path.resolve(logicalSessionPath));
    expect(manifest.currentLocator.key).toBe(sessionLocatorKey(realSessionPath));
    expect(store.resolveByLocatorPath(realSessionPath)?.sessionId).toBe(manifest.sessionId);
    expect(store.resolveByLocatorPath(logicalSessionPath)?.sessionId).toBe(manifest.sessionId);
  });

  it("persists migration state in the manifest database", () => {
    expect(store.getState("legacy-session-manifest-scan-v1")).toBeNull();

    store.setState("legacy-session-manifest-scan-v1", {
      checkpointDirectory: path.join(tmpDir, "checkpoints", "one"),
      completedAt: "2026-06-18T00:01:00.000Z",
      result: { scanned: 1, created: 1, existing: 0, skipped: 0 },
    });

    expect(store.getState("legacy-session-manifest-scan-v1")).toEqual({
      checkpointDirectory: path.join(tmpDir, "checkpoints", "one"),
      completedAt: "2026-06-18T00:01:00.000Z",
      result: { scanned: 1, created: 1, existing: 0, skipped: 0 },
    });
  });

  it("closes a partially opened database when initialization fails", () => {
    const dbPath = path.join(tmpDir, "broken-init.db");
    const close = vi.fn();
    class FailingDatabase {
      declare close: () => void;

      constructor(filePath: string) {
        expect(filePath).toBe(dbPath);
        this.close = close;
      }

      pragma() {
        throw new Error("file is not a database");
      }
    }

    expect(() => new SessionManifestStore({ dbPath, Database: FailingDatabase })).toThrow(
      "file is not a database",
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
