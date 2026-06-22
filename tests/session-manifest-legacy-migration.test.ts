import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacySessions } from "../core/session-manifest/legacy-migration.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";

describe("session manifest legacy migration", () => {
  let hanaHome;
  let store;
  let nextId;

  beforeEach(() => {
    hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-manifest-migration-"));
    nextId = 1;
    store = new SessionManifestStore({
      dbPath: path.join(hanaHome, "session-manifest.db"),
      idGenerator: () => `sess_migrate_${String(nextId++).padStart(4, "0")}`,
      now: () => "2026-06-18T03:00:00.000Z",
    });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(hanaHome, { recursive: true, force: true });
  });

  function writeSession(agentId, fileName, { archived = false } = {}) {
    const sessionDir = path.join(hanaHome, "agents", agentId, "sessions");
    const targetDir = archived ? path.join(sessionDir, "archived") : sessionDir;
    const sessionPath = path.join(targetDir, fileName);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: fileName, timestamp: "2026-06-18T03:00:00.000Z", cwd: hanaHome }),
      "",
    ].join("\n"));
    return { sessionDir, sessionPath };
  }

  function writeSubagentSession(agentId, fileName) {
    const sessionDir = path.join(hanaHome, "agents", agentId, "subagent-sessions");
    const sessionPath = path.join(sessionDir, fileName);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: fileName, timestamp: "2026-06-18T03:00:00.000Z", cwd: hanaHome }),
      "",
    ].join("\n"));
    return { sessionDir, sessionPath };
  }

  function linkDirectory(target, linkPath) {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  }

  function insertConflictingHistoryLocator(firstPath, secondSessionId) {
    const locatorPath = fs.realpathSync.native(firstPath);
    const locatorKey = process.platform === "win32"
      ? locatorPath.toLocaleLowerCase("en-US")
      : locatorPath;
    store.db.prepare(`
      INSERT INTO session_locator_history (
        session_id,
        locator_type,
        locator_path,
        locator_key,
        reason,
        created_at
      ) VALUES (?, 'jsonl', ?, ?, 'test_conflict', '2026-06-18T03:01:00.000Z')
    `).run(secondSessionId, locatorPath, locatorKey);
  }

  it("creates manifests for active and archived legacy sessions with sidecar semantics", () => {
    const active = writeSession("hana", "active.jsonl");
    const archived = writeSession("hana", "old.jsonl", { archived: true });
    fs.writeFileSync(path.join(active.sessionDir, "session-meta.json"), JSON.stringify({
      "active.jsonl": {
        pinnedAt: "2026-06-18T03:01:00.000Z",
        memoryEnabled: false,
        permissionMode: "auto",
        thinkingLevel: "high",
        workspaceFolders: ["/workspace/a"],
        plugin: {
          ownerPluginId: "image-gen",
          kind: "media",
          visibility: "private",
        },
      },
      "old.jsonl": {
        memoryEnabled: true,
        accessMode: "read_only",
      },
    }, null, 2));
    fs.writeFileSync(path.join(active.sessionDir, "session-titles.json"), JSON.stringify({
      [active.sessionPath]: "Active title",
      [path.join(active.sessionDir, "old.jsonl")]: "Archived title",
    }, null, 2));

    const result = migrateLegacySessions({
      hanaHome,
      store,
      migratedAt: "2026-06-18T03:02:00.000Z",
    });

    expect(result).toEqual({ scanned: 2, created: 2, existing: 0, skipped: 0 });
    const activeManifest = store.resolveByLocatorPath(active.sessionPath);
    const archivedManifest = store.resolveByLocatorPath(archived.sessionPath);

    expect(activeManifest).toMatchObject({
      sessionId: "sess_migrate_0001",
      ownerAgentId: "hana",
      domain: "desktop",
      kind: "media",
      lifecycle: "active",
      pinnedAt: "2026-06-18T03:01:00.000Z",
      memoryPolicy: { mode: "disabled", inheritedFrom: "legacy_session_meta" },
      permissionModeSnapshot: {
        mode: "auto",
        source: "legacy_session_meta",
        capturedAt: "2026-06-18T03:02:00.000Z",
      },
      thinkingLevel: "high",
      workspaceScope: {
        workspaceFolders: ["/workspace/a"],
      },
      plugin: {
        ownerPluginId: "image-gen",
        kind: "media",
        visibility: "private",
      },
      provenance: {
        legacyTitle: "Active title",
        legacyAgentId: "hana",
      },
      migration: {
        legacySessionPath: active.sessionPath,
        source: "legacy_scan",
      },
    });
    expect(archivedManifest).toMatchObject({
      sessionId: "sess_migrate_0002",
      ownerAgentId: "hana",
      lifecycle: "archived",
      memoryPolicy: { mode: "enabled", inheritedFrom: "legacy_session_meta" },
      permissionModeSnapshot: {
        mode: "read_only",
        source: "legacy_session_meta",
      },
      provenance: {
        legacyTitle: "Archived title",
      },
    });
  });

  it("imports capability snapshots and repairs permission from oversized session-meta backups", () => {
    const active = writeSession("hana", "media.jsonl");
    fs.writeFileSync(path.join(active.sessionDir, "session-meta.json"), JSON.stringify({
      "media.jsonl": {
        toolNames: ["read", "bash"],
      },
    }, null, 2));
    fs.writeFileSync(path.join(active.sessionDir, "session-meta.oversized.1781913830749.json"), JSON.stringify({
      "media.jsonl": {
        permissionMode: "auto",
        accessMode: "operate",
        planMode: false,
        toolNames: ["read", "bash", "media_generate-image", "media_generate-video"],
        promptSnapshot: {
          version: 1,
          systemPrompt: "prompt with media tools",
          appendSystemPrompt: [],
          skillsResult: { skills: [], diagnostics: [] },
          agentsFilesResult: { agentsFiles: [] },
        },
      },
    }, null, 2));

    const result = migrateLegacySessions({
      hanaHome,
      store,
      migratedAt: "2026-06-18T03:02:00.000Z",
    });

    expect(result).toMatchObject({
      scanned: 1,
      created: 1,
      existing: 0,
      skipped: 0,
    });
    const manifest = store.resolveByLocatorPath(active.sessionPath);
    expect(manifest.permissionModeSnapshot).toMatchObject({
      mode: "auto",
      source: "legacy_session_meta_backup",
    });
    expect(store.getCapabilitySnapshot(manifest.sessionId)).toMatchObject({
      toolNames: ["read", "bash", "media_generate-image", "media_generate-video"],
      promptSnapshot: {
        systemPrompt: "prompt with media tools",
      },
      source: "legacy_session_meta_backup",
    });
  });

  it("imports subagent executor metadata from legacy subagent sidecars", () => {
    const child = writeSubagentSession("hana", "child.jsonl");
    fs.writeFileSync(path.join(child.sessionDir, "session-meta.json"), JSON.stringify({
      "child.jsonl": {
        executorAgentId: "butter",
        executorAgentNameSnapshot: "Butter",
        executorMetaVersion: 1,
      },
    }, null, 2));

    const result = migrateLegacySessions({
      hanaHome,
      store,
      migratedAt: "2026-06-18T03:02:00.000Z",
    });

    expect(result).toMatchObject({
      scanned: 1,
      created: 1,
      existing: 0,
      skipped: 0,
    });
    const manifest = store.resolveByLocatorPath(child.sessionPath);
    expect(manifest).toMatchObject({
      ownerAgentId: "hana",
      lifecycle: "active",
    });
    expect(store.getExecutorMetadata(manifest.sessionId)).toMatchObject({
      executorAgentId: "butter",
      executorAgentNameSnapshot: "Butter",
      executorMetaVersion: 1,
      source: "legacy_session_meta",
    });
  });

  it("is idempotent when rerun over the same legacy files", () => {
    const active = writeSession("hana", "active.jsonl");

    const first = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });
    const second = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:03:00.000Z" });

    expect(first).toEqual({ scanned: 1, created: 1, existing: 0, skipped: 0 });
    expect(second).toEqual({ scanned: 1, created: 0, existing: 1, skipped: 0 });
    expect(store.resolveByLocatorPath(active.sessionPath)?.sessionId).toBe("sess_migrate_0001");
    expect(store.list()).toHaveLength(1);
  });

  it("scans legacy sessions through symlinked agent directories", () => {
    const realAgentDir = path.join(hanaHome, "real-hana-agent");
    const linkedAgentDir = path.join(hanaHome, "agents", "hana");
    fs.mkdirSync(path.join(realAgentDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.dirname(linkedAgentDir), { recursive: true });
    linkDirectory(realAgentDir, linkedAgentDir);
    const logicalSessionPath = path.join(linkedAgentDir, "sessions", "linked.jsonl");
    fs.writeFileSync(path.join(realAgentDir, "sessions", "linked.jsonl"), `${JSON.stringify({
      type: "session",
      id: "linked",
      timestamp: "2026-06-18T03:00:00.000Z",
    })}\n`);

    const result = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });

    expect(result).toEqual({ scanned: 1, created: 1, existing: 0, skipped: 0 });
    expect(store.resolveByLocatorPath(logicalSessionPath)).toMatchObject({
      sessionId: "sess_migrate_0001",
      ownerAgentId: "hana",
      currentLocator: {
        path: path.resolve(logicalSessionPath),
      },
    });
  });

  it("skips a conflicted locator without aborting the whole legacy migration", () => {
    const first = writeSession("hana", "first.jsonl");
    const second = writeSession("hana", "second.jsonl");
    const firstManifest = store.createForPath({ sessionPath: first.sessionPath, ownerAgentId: "hana" });
    const secondManifest = store.createForPath({ sessionPath: second.sessionPath, ownerAgentId: "hana" });
    insertConflictingHistoryLocator(first.sessionPath, secondManifest.sessionId);

    const result = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });

    expect(result).toEqual({ scanned: 2, created: 0, existing: 1, skipped: 1 });
    expect(store.getBySessionId(firstManifest.sessionId)?.sessionId).toBe(firstManifest.sessionId);
    expect(store.getBySessionId(secondManifest.sessionId)?.sessionId).toBe(secondManifest.sessionId);
  });

  it("repairs realpath locator paths back to the app-facing legacy path during rescan", () => {
    const realSessionsDir = path.join(hanaHome, "real-sessions");
    const logicalSessionsDir = path.join(hanaHome, "agents", "hana", "sessions");
    fs.mkdirSync(realSessionsDir, { recursive: true });
    fs.mkdirSync(path.dirname(logicalSessionsDir), { recursive: true });
    linkDirectory(realSessionsDir, logicalSessionsDir);
    const realSessionPath = path.join(realSessionsDir, "alpha.jsonl");
    const logicalSessionPath = path.join(logicalSessionsDir, "alpha.jsonl");
    fs.writeFileSync(realSessionPath, `${JSON.stringify({
      type: "session",
      id: "alpha",
      timestamp: "2026-06-18T03:00:00.000Z",
    })}\n`);
    const existing = store.createForPath({ sessionPath: realSessionPath, ownerAgentId: "hana" });

    const result = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });

    expect(result).toEqual({ scanned: 1, created: 0, existing: 1, skipped: 0 });
    expect(store.getBySessionId(existing.sessionId)?.currentLocator.path).toBe(path.resolve(logicalSessionPath));
  });
});
