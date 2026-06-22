/**
 * upload.js — 文件上传路由
 *
 * POST /api/upload
 * Body: { paths: ["/absolute/path/to/file_or_dir", ...] }
 *
 * 纯粹的"搬运"操作：把文件或文件夹复制到统一的 uploads 目录。
 * 不做任何业务判断（PDF 解析、图片识别等由 skill 层处理）。
 *
 * 存储位置：
 * - 无 sessionPath：{hanakoHome}/uploads/，按 24 小时清理旧临时文件
 * - 有 sessionPath：{hanakoHome}/session-files/<session-hash>/，跟随 session 冷却清理
 */
import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { t } from "../../lib/i18n.ts";
import { isSensitivePath } from "../utils/path-security.ts";
import {
  MAX_CHAT_IMAGE_BASE64_CHARS,
  extensionFromChatImageMime,
  isAllowedChatImageMime,
  isChatImageBase64WithinLimit,
} from "../../shared/image-mime.ts";
import {
  MAX_CHAT_AUDIO_BASE64_CHARS,
  extensionFromChatAudioMime,
  isAllowedChatAudioMime,
  isAllowedUploadAudioMime,
  isChatAudioBase64WithinLimit,
} from "../../shared/audio-mime.ts";
import { registerSessionFileFromRequest, serializeSessionFile } from "../../lib/session-files/session-file-response.ts";
import { buildSessionFileSourceKey, sessionFilesCacheDir } from "../../lib/session-files/session-file-registry.ts";

const MAX_FILES = 9;
const MAX_FILENAME_BYTES = 255;
const WINDOWS_RESERVED_CHARS = new Set(["<", ">", ":", "\"", "/", "\\", "|", "?", "*"]);
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);
const SESSION_FILE_PRESENTATIONS = new Set(["attachment", "voice-input"]);

function extFromMime(mimeType) {
  return extensionFromChatImageMime(mimeType) || extensionFromChatAudioMime(mimeType);
}

function isAllowedUploadBlobMime(mimeType) {
  return isAllowedChatImageMime(mimeType) || isAllowedUploadAudioMime(mimeType);
}

function isUploadBlobBase64WithinLimit(base64Data, mimeType) {
  if (isAllowedChatImageMime(mimeType)) return isChatImageBase64WithinLimit(base64Data);
  if (isAllowedUploadAudioMime(mimeType)) return isChatAudioBase64WithinLimit(base64Data);
  return false;
}

function uploadBlobMaxBase64Chars(mimeType) {
  if (isAllowedUploadAudioMime(mimeType)) return MAX_CHAT_AUDIO_BASE64_CHARS;
  return MAX_CHAT_IMAGE_BASE64_CHARS;
}

function normalizeSessionFilePresentation(value) {
  if (value == null || value === "") return "attachment";
  if (typeof value !== "string") return null;
  return SESSION_FILE_PRESENTATIONS.has(value) ? value : null;
}

function originForPresentation(presentation) {
  return presentation === "voice-input" ? "voice_input" : "user_upload";
}

function listedForPresentation(presentation) {
  return presentation !== "voice-input";
}

function waveformForUploadPath(body, srcPath) {
  const metadataByPath = body?.metadataByPath;
  if (!metadataByPath || typeof metadataByPath !== "object" || Array.isArray(metadataByPath)) return undefined;
  const direct = metadataByPath[srcPath];
  if (!direct || typeof direct !== "object" || Array.isArray(direct)) return undefined;
  return direct.waveform;
}

function isControlCodePoint(codePoint) {
  return (codePoint >= 0x00 && codePoint <= 0x1f) || (codePoint >= 0x80 && codePoint <= 0x9f);
}

function truncateUtf8Bytes(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let used = 0;
  for (const char of value) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (used + bytes > maxBytes) break;
    result += char;
    used += bytes;
  }
  return result;
}

function stripUnsafeFileNameChars(value) {
  let cleaned = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint == null || isControlCodePoint(codePoint)) continue;
    if (WINDOWS_RESERVED_CHARS.has(char)) continue;
    cleaned += char;
  }
  return cleaned;
}

function trimWindowsTrailingChars(value) {
  return value.replace(/[ .]+$/u, "");
}

function normalizeWindowsDeviceName(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  if (!WINDOWS_RESERVED_DEVICE_NAMES.has(base.toLowerCase())) return filename;
  return `file-${filename}`;
}

function sanitizeFileNameCandidate(value) {
  const crossPlatformBase = path.posix.basename(value.replace(/\\/g, "/"));
  const stripped = stripUnsafeFileNameChars(crossPlatformBase).trim();
  const trimmed = trimWindowsTrailingChars(stripped);
  if (!trimmed || trimmed === "." || trimmed === "..") return "";
  return trimmed;
}

function sanitizeBlobName(name, mimeType) {
  const fallbackBase = isAllowedChatAudioMime(mimeType) ? "recording" : "pasted";
  const fallback = `${fallbackBase}${extFromMime(mimeType) || ".bin"}`;
  if (!name || typeof name !== "string") return fallback;
  // 用户传入的 name 不可信：只保留跨平台 basename，再清理文件系统保留字符。
  let base = sanitizeFileNameCandidate(name);
  if (!base) return fallback;
  // 强制扩展名匹配 mimeType（防止 .exe 假装 image/png）
  const want = extFromMime(mimeType);
  if (want && path.extname(base).toLowerCase() !== want) {
    base = path.basename(base, path.extname(base)) + want;
  }
  base = normalizeWindowsDeviceName(base);
  return truncateUtf8Bytes(base, MAX_FILENAME_BYTES) || fallback;
}

class UploadPathError extends Error {
  constructor(message) {
    super(message);
    this.name = "UploadPathError";
  }
}

/** 递归统计路径中的文件数量（异步） */
export async function countFiles(p, { limit = Infinity, seen = new Set() } = {}) {
  const stat = await fs.lstat(p);
  if (stat.isSymbolicLink()) {
    throw new UploadPathError("symlink not allowed");
  }
  if (!stat.isDirectory()) return 1;

  let realDir;
  try {
    realDir = await fs.realpath(p);
  } catch {
    realDir = path.resolve(p);
  }
  if (seen.has(realDir)) return 0;
  seen.add(realDir);

  let count = 0;
  const entries = await fs.readdir(p);
  for (const entry of entries) {
    const remaining = limit - count;
    if (remaining <= 0) return limit + 1;
    count += await countFiles(path.join(p, entry), { limit: remaining, seen });
    if (count > limit) return limit + 1;
  }
  return count;
}

/** 清理超过 24 小时的上传临时文件（异步，后台执行） */
async function cleanOldUploads(uploadsDir) {
  try {
    const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      const fullPath = path.join(uploadsDir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.mtimeMs < cutoff) {
          await fs.rm(fullPath, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

function normalizeSessionPath(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveUploadTarget(engine, sessionPath) {
  if (sessionPath) {
    const sessionId = engine?.getSessionIdForPath?.(sessionPath) || null;
    return {
      dir: sessionFilesCacheDir(engine.hanakoHome, { sessionId, sessionPath }),
      storageKind: "managed_cache",
      shouldCleanOldUploads: false,
    };
  }
  return {
    dir: path.join(engine.hanakoHome, "uploads"),
    storageKind: undefined,
    shouldCleanOldUploads: true,
  };
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sourceKeyForUploadPath({ realPath, stat }) {
  return buildSessionFileSourceKey("upload:path:v1", [
    realPath,
    stat.isDirectory() ? "directory" : "file",
    stat.size,
    stat.mtimeMs,
  ]);
}

function normalizeClientUploadSourceId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 512);
}

function sourceKeyForUploadBlob({ blob, body, mimeType, presentation, buffer }) {
  const clientSourceId = normalizeClientUploadSourceId(
    blob?.sourceId ?? blob?.uploadId ?? body?.sourceId ?? body?.uploadId,
  );
  if (clientSourceId) {
    return buildSessionFileSourceKey("upload:blob-client:v1", [presentation, mimeType, clientSourceId]);
  }
  return buildSessionFileSourceKey("upload:blob-content:v1", [presentation, mimeType, sha256Hex(buffer)]);
}

function existingSessionFileForSourceKey(engine, sessionPath, sourceKey) {
  if (!sessionPath || !sourceKey || typeof engine?.getSessionFileBySourceKey !== "function") return null;
  const existing = engine.getSessionFileBySourceKey(sourceKey, { sessionPath });
  if (!existing || existing.status === "expired") return null;
  const target = existing.realPath || existing.filePath;
  if (!target || !fsSync.existsSync(target)) return null;
  return serializeSessionFile(existing, { runtimeContext: safeRuntimeContext(engine) });
}

function safeRuntimeContext(engine) {
  try {
    if (typeof engine?.getRuntimeContext === "function") return engine.getRuntimeContext();
  } catch {}
  return engine?.runtimeContext || null;
}

function uniqueUploadName(base, ext) {
  const suffix = `_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const maxBaseBytes = Math.max(1, MAX_FILENAME_BYTES - Buffer.byteLength(suffix + ext, "utf8"));
  return `${truncateUtf8Bytes(base, maxBaseBytes)}${suffix}${ext}`;
}

export function createUploadRoute(engine) {
  const route = new Hono();

  route.post("/upload", async (c) => {
    const body = await safeJson(c);
    const { paths } = body;
    const sessionPath = normalizeSessionPath(body?.sessionPath);
    if (!Array.isArray(paths) || paths.length === 0) {
      return c.json({ error: t("error.pathsRequired") }, 400);
    }

    const uploadTarget = resolveUploadTarget(engine, sessionPath);
    const uploadsDir = uploadTarget.dir;

    await fs.mkdir(uploadsDir, { recursive: true });

    if (uploadTarget.shouldCleanOldUploads) {
      // 后台清理旧上传（不阻塞当前请求）
      cleanOldUploads(uploadsDir).catch(() => {});
    }

    const results = [];
    let totalFiles = 0;

    for (const srcPath of paths) {
      // 超出文件数限制后，对剩余路径统一报错
      if (totalFiles > MAX_FILES) {
        results.push({
          src: srcPath,
          error: t("error.tooManyFiles", { max: MAX_FILES, n: totalFiles }),
        });
        continue;
      }

      try {
        if (!path.isAbsolute(srcPath)) {
          results.push({ src: srcPath, error: "Path must be absolute" });
          continue;
        }
        let stat;
        try {
          stat = await fs.lstat(srcPath);
        } catch {
          results.push({ src: srcPath, error: t("error.pathNotFound") });
          continue;
        }
        if (stat.isSymbolicLink()) {
          results.push({ src: srcPath, error: "symlink not allowed" });
          continue;
        }
        if (isSensitivePath(srcPath, engine.hanakoHome)) {
          results.push({ src: srcPath, error: "sensitive path blocked" });
          continue;
        }

        let realSrcPath;
        try {
          realSrcPath = await fs.realpath(srcPath);
        } catch {
          realSrcPath = path.resolve(srcPath);
        }

        // 安全检查通过后再统计文件数
        const pathFileCount = await countFiles(srcPath, { limit: MAX_FILES - totalFiles });
        totalFiles += pathFileCount;
        if (totalFiles > MAX_FILES) {
          results.push({
            src: srcPath,
            error: t("error.tooManyFiles", { max: MAX_FILES, n: totalFiles }),
          });
          continue;
        }

        const name = path.basename(srcPath);
        const isDir = stat.isDirectory();
        const sourceKey = sessionPath ? sourceKeyForUploadPath({ realPath: realSrcPath, stat }) : null;
        const existingSessionFile = existingSessionFileForSourceKey(engine, sessionPath, sourceKey);
        if (existingSessionFile) {
          results.push({
            src: srcPath,
            dest: existingSessionFile.filePath,
            name,
            isDirectory: isDir,
            ...existingSessionFile,
          });
          continue;
        }

        // 统一命名：原名_时间戳（文件保留扩展名）
        const ext = isDir ? "" : path.extname(srcPath);
        const base = isDir ? name : path.basename(srcPath, ext);
        const destName = uniqueUploadName(base, ext);
        const destPath = path.join(uploadsDir, destName);

        if (isDir) {
          await fs.cp(srcPath, destPath, { recursive: true });
        } else {
          await fs.copyFile(srcPath, destPath);
        }

        const sessionFile = registerSessionFileFromRequest(engine, {
          sessionPath,
          filePath: destPath,
          label: name,
          origin: "user_upload",
          storageKind: uploadTarget.storageKind,
          presentation: undefined,
          listed: undefined,
          waveform: waveformForUploadPath(body, srcPath),
          sourceKey,
        });

        results.push({
          src: srcPath,
          dest: destPath,
          name,
          isDirectory: isDir,
          ...(sessionFile || {}),
        });
      } catch (err) {
        if (err instanceof UploadPathError) {
          results.push({ src: srcPath, error: err.message });
          continue;
        }
        results.push({ src: srcPath, error: err.message });
      }
    }

    return c.json({ uploads: results, uploadsDir });
  });

  // POST /api/upload-blob
  // Body: { blobs: [{ name, base64Data, mimeType }, ...] }  (also accepts singular { name, base64Data, mimeType })
  // 把内存中的 base64 图片/音频数据落到与 /api/upload 同一个 uploads 目录，输出形态保持一致
  route.post("/upload-blob", async (c) => {
    const body = await safeJson(c);
    const sessionPath = normalizeSessionPath(body?.sessionPath);
    let blobs = body?.blobs;
    if (!Array.isArray(blobs)) {
      if (body?.base64Data) {
        blobs = [{
          name: body.name,
          base64Data: body.base64Data,
          mimeType: body.mimeType,
          presentation: body.presentation,
          sourceId: body.sourceId,
          uploadId: body.uploadId,
        }];
      }
      else return c.json({ error: t("error.pathsRequired") }, 400);
    }
    if (blobs.length === 0) return c.json({ error: t("error.pathsRequired") }, 400);

    const uploadTarget = resolveUploadTarget(engine, sessionPath);
    const uploadsDir = uploadTarget.dir;
    await fs.mkdir(uploadsDir, { recursive: true });
    if (uploadTarget.shouldCleanOldUploads) {
      cleanOldUploads(uploadsDir).catch(() => {});
    }

    const results = [];
    for (let i = 0; i < blobs.length; i++) {
      if (i >= MAX_FILES) {
        results.push({ error: t("error.tooManyFiles", { max: MAX_FILES, n: blobs.length }) });
        continue;
      }
      const { name, base64Data, mimeType } = blobs[i] || {};
      try {
        if (typeof base64Data !== "string" || !base64Data) {
          results.push({ error: "base64Data required" });
          continue;
        }
        if (typeof mimeType !== "string" || !isAllowedUploadBlobMime(mimeType)) {
          results.push({ error: "unsupported mimeType" });
          continue;
        }
        if (!isUploadBlobBase64WithinLimit(base64Data, mimeType)) {
          results.push({ error: `blob too large (max ${uploadBlobMaxBase64Chars(mimeType)} bytes)` });
          continue;
        }
        const presentation = normalizeSessionFilePresentation(blobs[i]?.presentation ?? body?.presentation);
        if (!presentation) {
          results.push({ error: "unsupported presentation" });
          continue;
        }
        if (presentation === "voice-input" && !isAllowedUploadAudioMime(mimeType)) {
          results.push({ error: "voice-input requires audio mimeType" });
          continue;
        }
        const buf = Buffer.from(base64Data, "base64");
        if (buf.length === 0) {
          results.push({ error: "empty blob" });
          continue;
        }

        const safeName = sanitizeBlobName(name, mimeType);
        const ext = path.extname(safeName);
        const base = path.basename(safeName, ext);
        const sourceKey = sessionPath
          ? sourceKeyForUploadBlob({ blob: blobs[i], body, mimeType, presentation, buffer: buf })
          : null;
        const existingSessionFile = existingSessionFileForSourceKey(engine, sessionPath, sourceKey);
        if (existingSessionFile) {
          results.push({
            dest: existingSessionFile.filePath,
            name: safeName,
            isDirectory: false,
            ...existingSessionFile,
          });
          continue;
        }
        const destName = uniqueUploadName(base, ext);
        const destPath = path.join(uploadsDir, destName);

        await fs.writeFile(destPath, buf);

        const sessionFile = registerSessionFileFromRequest(engine, {
          sessionPath,
          filePath: destPath,
          label: safeName,
          origin: originForPresentation(presentation),
          storageKind: uploadTarget.storageKind,
          presentation,
          listed: listedForPresentation(presentation),
          waveform: blobs[i]?.waveform ?? body?.waveform,
          sourceKey,
        });

        results.push({
          dest: destPath,
          name: safeName,
          isDirectory: false,
          ...(sessionFile || {}),
        });
      } catch (err) {
        results.push({ error: err?.message || String(err) });
      }
    }

    return c.json({ uploads: results, uploadsDir });
  });

  return route;
}
