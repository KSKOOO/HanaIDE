import fs from "fs";
import path from "path";
import {
  readDirectoryLikeDirentsSync,
  readFileLikePathsSync,
} from "../../shared/link-aware-fs.ts";
import { normalizeSessionPermissionMode } from "../session-permission-mode.ts";
import { normalizeSessionLocatorPath } from "./path-normalizer.ts";

function readJsonFile(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function hydrateSessionMetaPayloads(sessionDir, metaPath, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const hydrated: any = {};
  for (const [sessionFile, entry] of Object.entries(data) as [string, any][]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      hydrated[sessionFile] = entry;
      continue;
    }
    const next = { ...entry };
    for (const field of ["promptSnapshot", "memoryReflectionSnapshot"]) {
      const ref = next[field];
      if (
        !ref
        || typeof ref !== "object"
        || Array.isArray(ref)
        || ref.kind !== "session-meta-payload"
        || ref.field !== field
        || typeof ref.path !== "string"
      ) {
        continue;
      }
      try {
        next[field] = JSON.parse(fs.readFileSync(path.join(path.dirname(metaPath), ref.path), "utf-8"));
      } catch {
        delete next[field];
      }
    }
    hydrated[sessionFile] = next;
  }
  return hydrated;
}

function isSessionMetaBackupName(name) {
  return /^session-meta\.oversized\.\d+\.json$/.test(name)
    || /^session-meta\.json\.pre-v\d+\.bak$/.test(name);
}

function readSessionMetaSources(sessionDir) {
  const sources: any[] = [];
  const currentPath = path.join(sessionDir, "session-meta.json");
  const current = readJsonFile(currentPath, null);
  if (current && typeof current === "object" && !Array.isArray(current)) {
    sources.push({
      source: "legacy_session_meta",
      sourcePath: currentPath,
      data: hydrateSessionMetaPayloads(sessionDir, currentPath, current),
    });
  }

  let names: string[] = [];
  try {
    names = fs.readdirSync(sessionDir).filter(isSessionMetaBackupName).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const sourcePath = path.join(sessionDir, name);
    const data = readJsonFile(sourcePath, null);
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    sources.push({
      source: "legacy_session_meta_backup",
      sourcePath,
      data: hydrateSessionMetaPayloads(sessionDir, sourcePath, data),
    });
  }
  return sources;
}

function listDirectories(directory) {
  try {
    return readDirectoryLikeDirentsSync(directory).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listJsonlFiles(directory) {
  try {
    return readFileLikePathsSync(directory, { extension: ".jsonl" });
  } catch {
    return [];
  }
}

function hasLegacyPermissionFields(metaEntry) {
  return typeof metaEntry?.permissionMode === "string"
    || typeof metaEntry?.accessMode === "string"
    || typeof metaEntry?.planMode === "boolean";
}

function hasCapabilityFields(metaEntry) {
  return Array.isArray(metaEntry?.toolNames)
    || (metaEntry?.promptSnapshot && typeof metaEntry.promptSnapshot === "object")
    || typeof metaEntry?.capabilityDriftDismissedFingerprint === "string"
    || metaEntry?.capabilityDriftDismissedFingerprint === null;
}

function hasExecutorFields(metaEntry) {
  return typeof metaEntry?.executorAgentId === "string"
    || typeof metaEntry?.agentId === "string"
    || typeof metaEntry?.executorAgentNameSnapshot === "string"
    || typeof metaEntry?.executorAgentName === "string"
    || typeof metaEntry?.agentNameSnapshot === "string"
    || typeof metaEntry?.agentName === "string";
}

function normalizeExecutorMetadata(metaEntry: any = {}) {
  const executorAgentId =
    typeof metaEntry.executorAgentId === "string" && metaEntry.executorAgentId.trim()
      ? metaEntry.executorAgentId.trim()
      : typeof metaEntry.agentId === "string" && metaEntry.agentId.trim()
        ? metaEntry.agentId.trim()
        : null;
  const executorAgentNameSnapshot =
    typeof metaEntry.executorAgentNameSnapshot === "string" && metaEntry.executorAgentNameSnapshot.trim()
      ? metaEntry.executorAgentNameSnapshot.trim()
      : typeof metaEntry.executorAgentName === "string" && metaEntry.executorAgentName.trim()
        ? metaEntry.executorAgentName.trim()
        : typeof metaEntry.agentNameSnapshot === "string" && metaEntry.agentNameSnapshot.trim()
          ? metaEntry.agentNameSnapshot.trim()
          : typeof metaEntry.agentName === "string" && metaEntry.agentName.trim()
            ? metaEntry.agentName.trim()
            : null;
  if (!executorAgentId && !executorAgentNameSnapshot) return null;
  return {
    executorAgentId,
    executorAgentNameSnapshot,
    executorMetaVersion: Number.isFinite(metaEntry.executorMetaVersion) ? metaEntry.executorMetaVersion : 1,
  };
}

function toolNameCount(metaEntry) {
  return Array.isArray(metaEntry?.toolNames)
    ? metaEntry.toolNames.filter((item) => typeof item === "string" && item).length
    : 0;
}

function capabilityScore(metaEntry) {
  if (!hasCapabilityFields(metaEntry)) return 0;
  return toolNameCount(metaEntry) * 1000
    + (metaEntry?.promptSnapshot && typeof metaEntry.promptSnapshot === "object" ? 100 : 0)
    + (Object.prototype.hasOwnProperty.call(metaEntry || {}, "capabilityDriftDismissedFingerprint") ? 10 : 0);
}

function sessionMetaCandidates(metaSources, sessionPath) {
  const sessionFile = path.basename(sessionPath);
  return (metaSources || [])
    .map((source) => {
      const entry = source?.data?.[sessionFile];
      return entry && typeof entry === "object" && !Array.isArray(entry)
        ? { ...source, entry }
        : null;
    })
    .filter(Boolean);
}

function selectBestMetaCandidate(candidates) {
  return [...(candidates || [])].sort((a, b) => {
    const scoreDelta = capabilityScore(b.entry) - capabilityScore(a.entry);
    if (scoreDelta !== 0) return scoreDelta;
    if (a.source === "legacy_session_meta" && b.source !== "legacy_session_meta") return -1;
    if (b.source === "legacy_session_meta" && a.source !== "legacy_session_meta") return 1;
    return String(b.sourcePath || "").localeCompare(String(a.sourcePath || ""));
  })[0] || null;
}

function selectPermissionCandidate(candidates) {
  return candidates.find((candidate) => (
    candidate.source === "legacy_session_meta"
    && hasLegacyPermissionFields(candidate.entry)
  )) || candidates.find((candidate) => hasLegacyPermissionFields(candidate.entry)) || null;
}

function selectCapabilityCandidate(candidates) {
  return selectBestMetaCandidate(candidates.filter((candidate) => hasCapabilityFields(candidate.entry)));
}

function selectExecutorCandidate(candidates) {
  return candidates.find((candidate) => (
    candidate.source === "legacy_session_meta"
    && hasExecutorFields(candidate.entry)
  )) || candidates.find((candidate) => hasExecutorFields(candidate.entry)) || null;
}

function legacyMemoryPolicy(metaEntry) {
  if (metaEntry?.memoryEnabled === true) {
    return { mode: "enabled", inheritedFrom: "legacy_session_meta" };
  }
  if (metaEntry?.memoryEnabled === false) {
    return { mode: "disabled", inheritedFrom: "legacy_session_meta" };
  }
  return { mode: "inherit", inheritedFrom: "agent_default" };
}

function legacyWorkspaceScope(metaEntry) {
  const workspaceScope: any = {};
  if (Array.isArray(metaEntry?.workspaceFolders)) {
    workspaceScope.workspaceFolders = metaEntry.workspaceFolders.filter((item) => typeof item === "string");
  }
  if (Array.isArray(metaEntry?.authorizedFolders)) {
    workspaceScope.authorizedFolders = metaEntry.authorizedFolders.filter((item) => typeof item === "string");
  }
  if (typeof metaEntry?.primaryCwd === "string") {
    workspaceScope.primaryCwd = metaEntry.primaryCwd;
  }
  const mountId = typeof metaEntry?.workspaceMountId === "string"
    ? metaEntry.workspaceMountId
    : (typeof metaEntry?.mountId === "string" ? metaEntry.mountId : null);
  if (mountId) {
    workspaceScope.workspaceMount = {
      mountId,
      ...(typeof metaEntry?.workspaceLabel === "string" ? { label: metaEntry.workspaceLabel } : {}),
    };
  }
  return workspaceScope;
}

function legacyPlugin(metaEntry) {
  const plugin = metaEntry?.plugin && typeof metaEntry.plugin === "object" ? metaEntry.plugin : null;
  if (!plugin) return null;
  return {
    ownerPluginId: typeof plugin.ownerPluginId === "string" ? plugin.ownerPluginId : null,
    kind: typeof plugin.kind === "string" ? plugin.kind : null,
    visibility: typeof plugin.visibility === "string" ? plugin.visibility : "public",
  };
}

function legacyTitleFor(titles, sessionDir, sessionPath) {
  const activePath = path.join(sessionDir, path.basename(sessionPath));
  return titles[sessionPath] || titles[activePath] || titles[path.basename(sessionPath)] || null;
}

function buildLegacyManifestInput({
  agentId,
  sessionDir,
  sessionPath,
  lifecycle,
  metaSources,
  titles,
  migratedAt,
}) {
  const candidates = sessionMetaCandidates(metaSources, sessionPath);
  const bestCandidate = selectBestMetaCandidate(candidates);
  const permissionCandidate = selectPermissionCandidate(candidates);
  const metaEntry = bestCandidate?.entry || {};
  const permissionEntry = permissionCandidate?.entry || metaEntry;
  const plugin = legacyPlugin(metaEntry);
  const permissionHasLegacySource = hasLegacyPermissionFields(permissionEntry);
  return {
    sessionPath,
    ownerAgentId: agentId,
    domain: "desktop",
    kind: plugin?.kind || "chat",
    lifecycle,
    memoryPolicy: legacyMemoryPolicy(metaEntry),
    permissionModeSnapshot: {
      mode: normalizeSessionPermissionMode(permissionEntry),
      source: permissionHasLegacySource ? permissionCandidate.source : "migration_default",
      capturedAt: migratedAt,
    },
    thinkingLevel: typeof metaEntry?.thinkingLevel === "string" ? metaEntry.thinkingLevel : null,
    pinnedAt: typeof metaEntry?.pinnedAt === "string" ? metaEntry.pinnedAt : null,
    workspaceScope: legacyWorkspaceScope(metaEntry),
    plugin,
    provenance: {
      legacyAgentId: agentId,
      legacyLifecycle: lifecycle,
      legacyTitle: legacyTitleFor(titles, sessionDir, sessionPath),
    },
    migration: {
      legacySessionPath: sessionPath,
      source: "legacy_scan",
      migratedAt,
    },
    locatorReason: "legacy_scan",
  };
}

function capabilitySnapshotFromCandidate(candidate) {
  const entry = candidate?.entry;
  if (!entry || !hasCapabilityFields(entry)) return null;
  const snapshot: any = {};
  if (Array.isArray(entry.toolNames)) {
    const seen = new Set();
    snapshot.toolNames = entry.toolNames.filter((item) => {
      if (typeof item !== "string" || !item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  }
  if (entry.promptSnapshot && typeof entry.promptSnapshot === "object" && !Array.isArray(entry.promptSnapshot)) {
    snapshot.promptSnapshot = entry.promptSnapshot;
  }
  if (Object.prototype.hasOwnProperty.call(entry, "capabilityDriftDismissedFingerprint")) {
    snapshot.capabilityDriftDismissedFingerprint =
      typeof entry.capabilityDriftDismissedFingerprint === "string"
        ? entry.capabilityDriftDismissedFingerprint
        : null;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function shouldReplaceCapabilitySnapshot(existing, candidate) {
  if (!candidate) return false;
  if (!existing) return true;
  const existingSource = existing.source || "";
  if (!existingSource.startsWith("legacy_session_meta")) return false;
  const existingScore = (Array.isArray(existing.toolNames) ? existing.toolNames.length : 0) * 1000
    + (existing.promptSnapshot ? 100 : 0)
    + (Object.prototype.hasOwnProperty.call(existing, "capabilityDriftDismissedFingerprint") ? 10 : 0);
  return capabilityScore(candidate.entry) > existingScore;
}

function importLegacyCapabilitySnapshot(store, manifest, candidates) {
  if (!manifest?.sessionId || typeof store.getCapabilitySnapshot !== "function" || typeof store.setCapabilitySnapshot !== "function") {
    return;
  }
  const candidate = selectCapabilityCandidate(candidates);
  if (!candidate) return;
  const existing = store.getCapabilitySnapshot(manifest.sessionId);
  if (!shouldReplaceCapabilitySnapshot(existing, candidate)) return;
  const snapshot = capabilitySnapshotFromCandidate(candidate);
  if (!snapshot) return;
  store.setCapabilitySnapshot(manifest.sessionId, snapshot, { source: candidate.source });
}

function shouldReplaceExecutorMetadata(existing, candidate) {
  if (!candidate) return false;
  if (!existing) return true;
  const existingSource = existing.source || "";
  return existingSource.startsWith("legacy_session_meta");
}

function importLegacyExecutorMetadata(store, manifest, candidates) {
  if (!manifest?.sessionId || typeof store.getExecutorMetadata !== "function" || typeof store.setExecutorMetadata !== "function") {
    return;
  }
  const candidate = selectExecutorCandidate(candidates);
  if (!candidate) return;
  const existing = store.getExecutorMetadata(manifest.sessionId);
  if (!shouldReplaceExecutorMetadata(existing, candidate)) return;
  const metadata = normalizeExecutorMetadata(candidate.entry);
  if (!metadata) return;
  store.setExecutorMetadata(manifest.sessionId, metadata, { source: candidate.source });
}

function repairPermissionSnapshotFromLegacyMeta(store, manifest, candidates) {
  if (!manifest?.sessionId || typeof store.setPermissionModeSnapshot !== "function") return manifest;
  if (manifest.permissionModeSnapshot?.source !== "migration_default") return manifest;
  const candidate = selectPermissionCandidate(candidates);
  if (!candidate) return manifest;
  return store.setPermissionModeSnapshot(manifest.sessionId, {
    mode: normalizeSessionPermissionMode(candidate.entry),
    source: candidate.source,
  });
}

function repairExistingLocatorIfNeeded(store, existing, sessionPath) {
  if (!existing?.sessionId) return existing;
  const expectedPath = normalizeSessionLocatorPath(sessionPath);
  if (existing.currentLocator?.path === expectedPath) return existing;
  return store.updateLocator(existing.sessionId, sessionPath, "legacy_scan_repair");
}

export function migrateLegacySessions(opts: any = {}) {
  if (!opts.hanaHome) throw new Error("migrateLegacySessions requires hanaHome");
  if (!opts.store) throw new Error("migrateLegacySessions requires store");

  const hanaHome = path.resolve(opts.hanaHome);
  const agentsDir = path.resolve(opts.agentsDir || path.join(hanaHome, "agents"));
  const migratedAt = opts.migratedAt || new Date().toISOString();
  const result = { scanned: 0, created: 0, existing: 0, skipped: 0 };

  for (const agentId of listDirectories(agentsDir)) {
    const sessionGroups = [
      {
        sessionDir: path.join(agentsDir, agentId, "sessions"),
        sessionRowsFor: (sessionDir) => [
          ...listJsonlFiles(sessionDir).map((sessionPath) => ({ sessionPath, lifecycle: "active" })),
          ...listJsonlFiles(path.join(sessionDir, "archived")).map((sessionPath) => ({ sessionPath, lifecycle: "archived" })),
        ],
      },
      {
        sessionDir: path.join(agentsDir, agentId, "subagent-sessions"),
        sessionRowsFor: (sessionDir) => (
          listJsonlFiles(sessionDir).map((sessionPath) => ({ sessionPath, lifecycle: "active" }))
        ),
      },
    ];

    for (const group of sessionGroups) {
      const sessionDir = group.sessionDir;
      if (!fs.existsSync(sessionDir)) continue;
      const metaSources = readSessionMetaSources(sessionDir);
      const titles = readJsonFile(path.join(sessionDir, "session-titles.json"), {});
      const sessionRows = group.sessionRowsFor(sessionDir);

      for (const row of sessionRows) {
        result.scanned += 1;
        try {
          const existing = opts.store.resolveByLocatorPath(row.sessionPath);
          if (existing) {
            const repaired = repairExistingLocatorIfNeeded(opts.store, existing, row.sessionPath);
            const candidates = sessionMetaCandidates(metaSources, row.sessionPath);
            const permissionRepaired = repairPermissionSnapshotFromLegacyMeta(opts.store, repaired, candidates);
            importLegacyCapabilitySnapshot(opts.store, permissionRepaired || repaired, candidates);
            importLegacyExecutorMetadata(opts.store, permissionRepaired || repaired, candidates);
            result.existing += 1;
            continue;
          }

          const manifest = opts.store.createForPath(buildLegacyManifestInput({
            agentId,
            sessionDir,
            sessionPath: row.sessionPath,
            lifecycle: row.lifecycle,
            metaSources,
            titles,
            migratedAt,
          }));
          const candidates = sessionMetaCandidates(metaSources, row.sessionPath);
          importLegacyCapabilitySnapshot(opts.store, manifest, candidates);
          importLegacyExecutorMetadata(opts.store, manifest, candidates);
          result.created += 1;
        } catch (error) {
          if (opts.stopOnError === true) throw error;
          result.skipped += 1;
        }
      }
    }
  }

  return result;
}
