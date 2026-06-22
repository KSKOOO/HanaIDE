import fs from "fs";
import path from "path";

/**
 * Read and JSON-parse a file, retrying on EMFILE/ENFILE (file handle exhaustion).
 *
 * Windows has no ulimit-equivalent, so nft trace can exhaust the OS handle quota.
 * EMFILE means "temporarily can't open" — the file exists and is valid. Treating
 * it the same as ENOENT is a contract bug: it maps an I/O resource error onto a
 * product-integrity failure, which is exactly the misdiagnosis that kills Windows builds.
 *
 * @param {string} filePath - Absolute path to the JSON file.
 * @param {{ maxRetries?: number, baseDelayMs?: number }} [opts]
 * @returns {unknown} Parsed JSON value.
 * @throws On ENOENT, JSON parse failure, or EMFILE after all retries.
 */
export function readPackageJsonWithRetry(filePath, { maxRetries = 5, baseDelayMs = 50 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
      const code = err && err.code;
      // EMFILE = too many open file descriptors (Windows/macOS kernel limit hit).
      // ENFILE = system-wide file table full (rarer but same transient nature).
      // Both are recoverable: wait and retry. Do NOT treat as "file missing".
      if (code === "EMFILE" || code === "ENFILE") {
        lastErr = err;
        if (attempt < maxRetries) {
          // Synchronous exponential backoff — this is a build script, blocking is fine.
          // Atomics.wait on a fresh SharedArrayBuffer gives a true sync sleep without
          // spinning and without requiring a running event loop.
          const delayMs = baseDelayMs * Math.pow(2, attempt);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
          continue;
        }
        // Exhausted retries: re-throw the original EMFILE so the caller knows why.
        throw lastErr;
      }
      // ENOENT = file truly absent. JSON SyntaxError = corrupt file.
      // All other errors: propagate as-is.
      throw err;
    }
  }
}

function getLockedPackageVersion(rootLock, packageName) {
  const packagePath = `node_modules/${packageName}`;
  const lockedPackage = rootLock?.packages?.[packagePath];
  if (!lockedPackage?.version) {
    throw new Error(`[build-server] package-lock.json does not contain ${packagePath}`);
  }
  return lockedPackage.version;
}

export function buildExternalPackage(
  rootPkg,
  externalDeps,
  { rootLock, pinnedTransitiveDeps = [] } = {},
) {
  const dependencies = {};

  for (const [packageName, requestedVersion] of Object.entries(externalDeps)) {
    dependencies[packageName] = rootLock
      ? getLockedPackageVersion(rootLock, packageName)
      : requestedVersion;
  }

  for (const packageName of pinnedTransitiveDeps) {
    dependencies[packageName] = getLockedPackageVersion(rootLock, packageName);
  }

  return {
    name: "hanako-server",
    version: rootPkg.version,
    type: "module",
    dependencies,
  };
}

export function collectInstalledOptionalDependencyDirs(nmDir, packageNames) {
  const dirs = [];

  for (const packageName of packageNames) {
    const packageJsonPath = path.join(nmDir, packageName, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    } catch {
      continue;
    }

    for (const optionalName of Object.keys(pkg.optionalDependencies || {})) {
      const optionalDir = path.join(nmDir, optionalName);
      if (fs.existsSync(optionalDir)) {
        dirs.push(path.resolve(optionalDir));
      }
    }
  }

  return dirs;
}

export function buildJiebaRuntimeSmokeScript() {
  return [
    "import { createRequire } from 'node:module';",
    "const require = createRequire(new URL('./package.json', import.meta.url));",
    "const { Jieba } = require('@node-rs/jieba');",
    "const { dict } = require('@node-rs/jieba/dict');",
    "const jieba = Jieba.withDict(dict);",
    "jieba.loadDict(Buffer.from('session_search 1000 nz\\nA2A通信 1000 nz\\n聊天记录 1000 nz', 'utf8'));",
    "const tokens = jieba.cutForSearch('聊天记录 A2A通信 session_search', true);",
    "for (const token of ['聊天记录', 'A2A通信', 'session_search']) {",
    "  if (!tokens.includes(token)) {",
    "    throw new Error(`@node-rs/jieba runtime smoke failed: missing ${token} from ${tokens.join('|')}`);",
    "  }",
    "}",
    "console.log('[build-server] jieba runtime smoke passed');",
    "",
  ].join("\n");
}

export function buildBetterSqliteRuntimeSmokeScript() {
  return [
    "import { createRequire } from 'node:module';",
    "const require = createRequire(new URL('./package.json', import.meta.url));",
    "const Database = require('better-sqlite3');",
    "const db = new Database(':memory:');",
    "try {",
    "  const row = db.prepare('select 1 as ok').get();",
    "  if (row?.ok !== 1) {",
    "    throw new Error(`better-sqlite3 runtime smoke failed: ${JSON.stringify(row)}`);",
    "  }",
    "} finally {",
    "  db.close();",
    "}",
    "console.log('[build-server] better-sqlite3 runtime smoke passed');",
    "",
  ].join("\n");
}

function collectRuntimeExportTargets(exportValue, targets = []) {
  if (typeof exportValue === "string") {
    targets.push(exportValue);
    return targets;
  }

  if (!exportValue || typeof exportValue !== "object") {
    return targets;
  }

  for (const [condition, value] of Object.entries(exportValue)) {
    if (condition === "types") continue;
    collectRuntimeExportTargets(value, targets);
  }

  return targets;
}

function getRootExport(exportsField) {
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return exportsField;
  }

  if (Object.hasOwn(exportsField, ".")) {
    return exportsField["."];
  }

  const keys = Object.keys(exportsField);
  const isSubpathMap = keys.some((key) => key.startsWith("."));
  return isSubpathMap ? undefined : exportsField;
}

export function verifyExternalEntrypoints(outDir, packageNames, { readRetries, readBaseDelayMs } = {}) {
  const failures = [];
  const retryOpts = {};
  if (readRetries !== undefined) retryOpts.maxRetries = readRetries;
  if (readBaseDelayMs !== undefined) retryOpts.baseDelayMs = readBaseDelayMs;

  for (const packageName of packageNames) {
    const packageDir = path.join(outDir, "node_modules", packageName);
    const packageJsonPath = path.join(packageDir, "package.json");

    let pkg;
    try {
      // readPackageJsonWithRetry retries on EMFILE/ENFILE (transient handle exhaustion).
      // It only throws ENOENT or parse errors after retries — those are genuine failures.
      pkg = readPackageJsonWithRetry(packageJsonPath, retryOpts);
    } catch (err) {
      const code = err && err.code;
      // EMFILE/ENFILE after all retries: the file exists but we couldn't open it.
      // This is an I/O resource failure, NOT a missing package. Don't count it as
      // a missing entrypoint — doing so is the contract bug that caused #1307.
      // Re-throw so the caller (build-server.mjs) sees a hard I/O error and can
      // decide to abort with an accurate message rather than a misleading "missing" report.
      if (code === "EMFILE" || code === "ENFILE") {
        throw err;
      }
      // ENOENT: package.json truly absent — the package was not installed.
      // JSON SyntaxError: package.json is corrupt.
      // Both are genuine product-integrity failures.
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${packageName}: ${msg}`);
      continue;
    }

    const rootExport = getRootExport(pkg.exports);
    const targets = rootExport === undefined
      ? [pkg.main, pkg.module].filter(Boolean)
      : collectRuntimeExportTargets(rootExport);

    for (const target of targets) {
      if (typeof target !== "string" || !target.startsWith("./") || target.includes("*")) {
        continue;
      }

      const targetPath = path.join(packageDir, target);
      if (!fs.existsSync(targetPath)) {
        failures.push(`${packageName}: ${target} resolves to missing file ${targetPath}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error([
      "[build-server] external package entrypoint verification failed:",
      ...failures.map((failure) => `  - ${failure}`),
    ].join("\n"));
  }
}
