/**
 * desk.js — Desk 系统 REST API
 *
 * 提供 cron 任务、工作台文件的 HTTP 接口。
 * 前端通过这些接口直接操作（不经过 agent/LLM），
 * agent 通过 tool 操作（走 WebSocket 推送更新）。
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { parseSkillMetadata } from "../../lib/skills/skill-metadata.ts";
import { installSkillPackageFromPath } from "../../lib/skills/skill-package-installer.ts";
import { WORKSPACE_SKILL_DIRS } from "../../shared/workspace-skill-paths.ts";
import { DEFAULT_DISABLED_TOOL_NAMES } from "../../shared/tool-categories.ts";
import { applyMarkdownCoverFromGeneratedFile } from "../../plugins/beautify/lib/markdown-cover-service.ts";
import { resolveCoverGalleryPresetImagePath } from "../../plugins/beautify/lib/cover-gallery-assets.ts";
import { buildCoverStyleGuideForAgent } from "../../plugins/beautify/lib/cover-style-guide.ts";
import { createSubmitContext, validateImageModelRef } from "../../plugins/image-gen/lib/image-task-runner.ts";
import { DEFAULT_ACTIVITY_EXECUTION_TIMEOUT_MS, activityTimeoutPatch } from "../../lib/desk/activity-store.ts";
import { emitAppEvent } from "../app-events.ts";
import { t } from "../../lib/i18n.ts";
import { realPath, isSensitivePath } from "../utils/path-security.ts";
import { readAuthPrincipal } from "../http/capability-guard.ts";
import { jsonRouteError } from "../http/route-errors.ts";
import { isLocalOwnerPrincipal } from "../http/route-security.ts";
import { createRequestContext } from "../http/boundary.ts";
import { createModuleLogger } from "../../lib/debug-log.ts";
import { MountAwareFileError, MountAwareFileService } from "../../core/mount-aware-file-service.ts";
import { materializeUploadedSkillPackage } from "../utils/uploaded-skill-package.ts";

const log = createModuleLogger("desk");

/** 安全路径校验：target 必须在 baseDir 内部（解析 symlink 后比较） */
function isInsidePath(target, baseDir) {
  const base = realPath(baseDir);
  if (!base) return false;
  const resolved = realPath(target);
  if (resolved) return resolved === base || resolved.startsWith(base + path.sep);
  // 路径不存在（mkdir / rename 目标）：解析父目录 + 保留 basename
  const parentResolved = realPath(path.dirname(target));
  if (!parentResolved) return false;
  const full = path.join(parentResolved, path.basename(target));
  return full === base || full.startsWith(base + path.sep);
}

function isInsideAnyRoot(dir, roots) {
  const resolved = realPath(dir);
  if (!resolved) return false;
  return roots.filter(Boolean).some(root => {
    const r = realPath(root);
    if (!r) return false;
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

function selectedAgentDeskRoots(engine, agentId) {
  if (!agentId || typeof agentId !== "string") return [];
  return [
    typeof engine.getExplicitHomeCwd === "function" ? engine.getExplicitHomeCwd(agentId) : null,
    typeof engine.getHomeCwd === "function" ? engine.getHomeCwd(agentId) : null,
  ].filter(Boolean);
}

/** 校验 dir 覆盖：仅允许 engine 已知的根目录（解析 symlink 后比较） */
function isApprovedDir(dir, engine, { agentId = null } = {}) {
  if (isInsideAnyRoot(dir, selectedAgentDeskRoots(engine, agentId))) {
    return true;
  }
  if (typeof engine.isApprovedDeskDir === "function") {
    return engine.isApprovedDeskDir(dir, { agentId });
  }
  const approved = [
    engine.deskCwd,
    engine.homeCwd,
    ...(Array.isArray(engine.config?.cwd_history) ? engine.config.cwd_history : []),
  ].filter(Boolean);
  if (typeof engine.isApprovedWorkspaceDir === "function" && engine.isApprovedWorkspaceDir(dir, { agentId })) {
    return true;
  }
  return isInsideAnyRoot(dir, approved);
}

function defaultDeskDir(engine) {
  return engine.defaultDeskCwd || engine.homeCwd || engine.deskCwd;
}

function isPlainEntryName(value) {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\");
}

function normalizeMountId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function deskRouteError(c, code, message, status) {
  return jsonRouteError(c, { code, message, status });
}

function getStudioCronStore(engine) {
  return engine.getStudioCronStore?.() || null;
}

function normalizeRouteExecutionContext(value, actorAgentId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    kind: typeof value.kind === "string" && value.kind.trim() ? value.kind.trim() : "api_request",
    cwd: typeof value.cwd === "string" && value.cwd.trim() ? value.cwd : null,
    workspaceFolders: Array.isArray(value.workspaceFolders)
      ? value.workspaceFolders.filter(p => typeof p === "string" && p.trim())
      : [],
    sourceSessionPath: typeof value.sourceSessionPath === "string" && value.sourceSessionPath.trim()
      ? value.sourceSessionPath
      : null,
    createdByAgentId: typeof value.createdByAgentId === "string" && value.createdByAgentId.trim()
      ? value.createdByAgentId
      : actorAgentId,
  };
}

function normalizeRouteCreatedBy(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.kind === "string") {
    return JSON.parse(JSON.stringify(value));
  }
  return { kind: "user" };
}

function normalizeRouteExecutor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.kind !== "string") {
    return null;
  }
  return JSON.parse(JSON.stringify(value));
}

function validateRouteExecutor(executor) {
  if (!executor) return null;
  if (executor.kind === "agent_session") return null;
  return `unsupported automation executor: ${executor.kind}`;
}

/** 列出工作台目录下的文件（异步） */
async function listWorkspaceFiles(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // 目录不存在 → 空列表；权限错误等真实异常 → 向上抛
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const items = await Promise.all(
    entries
      .filter(e => !e.name.startsWith("."))
      .map(async (e) => {
        const fullPath = path.join(dir, e.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          return {
            name: e.name,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            isDir: e.isDirectory(),
          };
        } catch (err) {
          // ENOENT = 文件在 readdir 后被删除，正常跳过；其他错误也跳过单项不影响整体
          if (err.code !== "ENOENT") log.warn(`stat failed for ${e.name}: ${err.message}`);
          return null;
        }
      })
  );
  return items.filter(Boolean).sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
}

const WORKSPACE_SEARCH_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
]);
const WORKSPACE_SEARCH_LIMIT = 80;
const BEAUTIFY_OPTIONAL_TOOL_NAME = "beautify";
const MAX_COVER_UPLOAD_BYTES = 25 * 1024 * 1024;

function toRelativeSubdir(root, target) {
  const rel = path.relative(root, target);
  return rel.split(path.sep).filter(Boolean).join("/");
}

async function searchWorkspaceFiles(root, query, {
  limit = WORKSPACE_SEARCH_LIMIT,
} = {}) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [];
  const results = [];

  async function walk(dir) {
    if (results.length >= limit) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "EACCES") {
        log.warn(`search readdir failed for ${dir}: ${err.message}`);
      }
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      const isDir = entry.isDirectory();
      if (isDir && WORKSPACE_SEARCH_SKIP_DIRS.has(entry.name)) continue;
      const relativePath = toRelativeSubdir(root, fullPath);
      const parentSubdir = toRelativeSubdir(root, path.dirname(fullPath));

      if (entry.name.toLowerCase().includes(needle)) {
        try {
          const stat = await fs.promises.stat(fullPath);
          results.push({
            name: entry.name,
            relativePath,
            parentSubdir,
            isDir,
            size: isDir ? null : stat.size,
            mtime: stat.mtime.toISOString(),
          });
        } catch (err) {
          if (err.code !== "ENOENT") log.warn(`search stat failed for ${entry.name}: ${err.message}`);
        }
      }

      if (isDir) await walk(fullPath);
    }
  }

  await walk(root);
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "zh")).slice(0, limit);
}

export function createDeskRoute(engine, hub) {
  const route = new Hono();

  /** 从所有 agent 的 activityStore 中按 ID 查找 entry */
  function findActivityEntry(activityId) {
    for (const ag of engine.listAgents()) {
      const store = engine.getActivityStore(ag.id);
      const entry = store?.get(activityId);
      if (entry) return { entry, agentId: ag.id };
    }
    return { entry: null, agentId: null };
  }

  // ════════════════════════════
  //  助手活动
  // ════════════════════════════

  function emitActivityUpdate(activity, sessionPath = null) {
    hub?.eventBus?.emit?.({ type: "activity_update", activity }, sessionPath);
  }

  function emitActivityUpdates(activities) {
    for (const activity of activities || []) emitActivityUpdate(activity);
  }

  function buildBeautifyCoverPrompt({ filePath, themeTone, userGuidance }) {
    const styleGuide = buildCoverStyleGuideForAgent({ themeTone, userGuidance });
    return [
      "这是一个由编辑器 UI 按钮发起的 Beautify 后台任务，目标 Markdown 路径已经由按钮明确给出。",
      `目标文件：${filePath}`,
      "",
      "请按这个顺序完成：",
      "1. 阅读目标 Markdown 文件，理解文章内容和情绪。",
      "2. 你自己写一条给生图模型使用的英文提示词。",
      "3. 调用 media_generate-image 生成 1 张图片，ratio 固定传 3:2，resolution 传 2k。",
      "4. 调用 check_pending_tasks 查询本会话的图片生成任务；如果任务还没完成，停止当前轮次并说明 cover 会在后台任务完成后继续处理。",
      "5. 图片生成成功后，从 resolved 结果的 sessionFiles[0].filePath 取生成图片绝对路径。",
      "6. 调用 beautify_create-cover，把生成图片应用到 Markdown：",
      `   - targetFilePath: ${filePath}`,
      "   - generatedFilePath: <上一步生成图片的绝对路径>",
      "",
      styleGuide,
      "",
      "边界：Beautify 工具只负责把已有图片复制到附件文件夹并写入 cover frontmatter。图片来源未来也可以是内置头图库或用户本地图片，但当前按钮任务默认走生图工具。不要用 Beautify 工具生成提示词或提交生图任务，不要把生图 prompt、模型、provider、生成时间写进 Markdown。",
      "完成后用一句话说明图片已经应用为 cover，或说明失败原因。",
    ].filter(Boolean).join("\n");
  }

  function getBeautifyExecutorAgent(requestedAgentId) {
    const agentId = typeof requestedAgentId === "string" && requestedAgentId.trim()
      ? requestedAgentId.trim()
      : (engine.getPrimaryAgentId?.() || engine.currentAgentId || null);
    const agent = agentId ? engine.getAgent?.(agentId) : null;
    return {
      agent: agent || null,
      agentId: agent?.id || agentId || null,
    };
  }

  function isBeautifyPluginAvailable() {
    return (engine.pluginManager?.getAllTools?.() || [])
      .some((tool) => tool?._pluginId === BEAUTIFY_OPTIONAL_TOOL_NAME);
  }

  function isBeautifyEnabled(agent) {
    const disabled = Array.isArray(agent?.config?.tools?.disabled)
      ? agent.config.tools.disabled
      : DEFAULT_DISABLED_TOOL_NAMES;
    return !disabled.includes(BEAUTIFY_OPTIONAL_TOOL_NAME);
  }

  function beautifyAgentName(agent, agentId) {
    return agent?.agentName || agent?.name || agentId || null;
  }

  function getImageGenerationRuntime() {
    if (engine.media) {
      return {
        config: engine.media.config,
        resolveImageModelRef: (ref) => engine.media.resolveImageModelRef(ref),
      };
    }
    const imageGenCtx = engine.pluginManager?.getPlugin?.("image-gen")?.ctx || null;
    if (!imageGenCtx) return null;
    const registry = imageGenCtx._mediaGen?.registry || null;
    if (!registry) {
      return {
        config: imageGenCtx.config,
        unavailableReason: "image-generation-runtime-unavailable",
        unavailableMessage: "image generation runtime is unavailable",
      };
    }
    return {
      config: imageGenCtx.config,
      resolveImageModelRef: (ref) => validateImageModelRef(
        ref,
        registry,
        createSubmitContext(imageGenCtx),
      ),
    };
  }

  async function resolveDefaultImageModelStatus() {
    const imageRuntime = getImageGenerationRuntime();
    if (!imageRuntime) {
      return {
        ok: false,
        status: 404,
        reason: "image-gen-unavailable",
        error: "image generation runtime is unavailable",
        settingsTarget: "media",
      };
    }
    if (imageRuntime.unavailableReason) {
      return {
        ok: false,
        status: 409,
        reason: imageRuntime.unavailableReason,
        error: imageRuntime.unavailableMessage || "image generation runtime is unavailable",
        settingsTarget: "media",
      };
    }

    const defaultModel = imageRuntime.config?.get?.("defaultImageModel");
    if (!defaultModel?.provider || !defaultModel?.id) {
      return {
        ok: false,
        status: 409,
        reason: "default-image-model-missing",
        error: "default image model is not configured",
        settingsTarget: "media",
      };
    }

    try {
      const resolved = await imageRuntime.resolveImageModelRef({ providerId: defaultModel.provider, modelId: defaultModel.id });
      return { ok: true, resolved };
    } catch (err) {
      return {
        ok: false,
        status: 409,
        reason: "default-image-model-invalid",
        error: err?.message || String(err),
        settingsTarget: "media",
      };
    }
  }

  async function getBeautifyGenerationStatus(requestedAgentId) {
    const { agent, agentId } = getBeautifyExecutorAgent(requestedAgentId);
    const base = {
      available: false,
      enabled: false,
      executorAgentId: agentId,
      executorAgentName: beautifyAgentName(agent, agentId),
      disabledReason: null,
      message: null,
      settingsTarget: null,
    };

    if (!agentId || !agent) {
      return {
        ...base,
        disabledReason: "agent-unavailable",
        message: "agent unavailable",
      };
    }

    if (!isBeautifyPluginAvailable()) {
      return {
        ...base,
        disabledReason: "beautify-plugin-unavailable",
        message: "beautify tool is unavailable",
        settingsTarget: "plugins",
      };
    }

    if (!isBeautifyEnabled(agent)) {
      return {
        ...base,
        available: true,
        disabledReason: "beautify-disabled",
        message: "beautify tool is disabled for this agent",
        settingsTarget: "agent-tools",
      };
    }

    const imageStatus = await resolveDefaultImageModelStatus();
    if (!imageStatus.ok) {
      return {
        ...base,
        available: true,
        disabledReason: imageStatus.reason,
        message: imageStatus.error,
        settingsTarget: imageStatus.settingsTarget,
      };
    }

    return {
      ...base,
      available: true,
      enabled: true,
    };
  }

  function validateBeautifyMarkdownFilePath(filePath) {
    if (!filePath || !path.isAbsolute(filePath)) {
      return "filePath must be an absolute Markdown file path";
    }
    if (path.extname(filePath).toLowerCase() !== ".md") {
      return "filePath must point to a .md file";
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return "filePath must point to a file";
    } catch (err) {
      return `filePath is not readable: ${err.message}`;
    }
    return null;
  }

  function validateMarkdownCoverSystemAccess() {
    if (!isBeautifyPluginAvailable()) {
      return { error: "beautify tool is unavailable", status: 404 };
    }
    return {};
  }

  function canUseLocalAbsolutePaths(c) {
    const principal = readAuthPrincipal(c);
    return !principal || principal.kind === "unknown" || isLocalOwnerPrincipal(principal);
  }

  function fileServiceForRequest(c) {
    const requestContext = createRequestContext(c, engine);
    return new MountAwareFileService({
      hanakoHome: engine.hanakoHome,
      defaultRoot: defaultDeskDir(engine),
      studioId: requestContext?.studioId || engine.getRuntimeContext?.()?.studioId || null,
      createCheckpoint: typeof engine.createUserEditCheckpoint === "function"
        ? (args) => engine.createUserEditCheckpoint(args)
        : null,
      sshProvider: engine.sshProvider,
    });
  }

  function resolveWorkspaceRootFromRequest(c, body = null) {
    const mountId = normalizeMountId(body?.mountId || body?.rootId || c.req.query("mountId") || c.req.query("rootId"));
    if (mountId) {
      const files = fileServiceForRequest(c);
      const root = files.resolveRoot(mountId);
      return {
        dir: files.resolveDirectory(mountId, ""),
        mountId: root.mountId || root.id || mountId,
        mount: root,
      };
    }
    const dir = body?.dir || (c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine));
    return { dir, mountId: null, mount: null };
  }

  function normalizeWorkbenchCoverTarget(body) {
    const raw = body?.target || body?.remoteContentRef || null;
    if (!raw) return null;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw coverRouteError("target must be a workbench file target", "invalid_target", 400);
    }
    if (raw.kind !== "workbench-file" && raw.kind !== "mobile-workbench") {
      throw coverRouteError("target.kind must be workbench-file", "invalid_target", 400);
    }
    const mountId = typeof raw.mountId === "string" && raw.mountId.trim()
      ? raw.mountId.trim()
      : (typeof raw.rootId === "string" && raw.rootId.trim() ? raw.rootId.trim() : "default");
    return {
      kind: "workbench-file",
      mountId,
      rootId: typeof raw.rootId === "string" && raw.rootId.trim() ? raw.rootId.trim() : mountId,
      subdir: typeof raw.subdir === "string" ? raw.subdir : "",
      name: typeof raw.name === "string" ? raw.name : "",
    };
  }

  function resolveBeautifyMarkdownTarget(c, body) {
    try {
      const target = normalizeWorkbenchCoverTarget(body);
      if (target) {
        const resolved = fileServiceForRequest(c).writeFileTarget(target.mountId, target.subdir, target.name);
        const fileError = validateBeautifyMarkdownFilePath(resolved.target);
        if (fileError) return { error: fileError, status: 400 };
        return {
          filePath: resolved.target,
          target: {
            kind: "workbench-file",
            mountId: resolved.root?.mountId || resolved.root?.id || target.mountId,
            rootId: resolved.root?.id || target.rootId,
            subdir: target.subdir,
            name: resolved.filename,
          },
        };
      }

      const filePath = typeof body?.filePath === "string" ? body.filePath : "";
      if (!canUseLocalAbsolutePaths(c)) {
        return { error: "filePath requires local owner; use target for remote clients", status: 403 };
      }
      const fileError = validateBeautifyMarkdownFilePath(filePath);
      if (fileError) return { error: fileError, status: 400 };
      return { filePath, target: null };
    } catch (err) {
      if (err instanceof MountAwareFileError) {
        return { error: err.message, status: err.status };
      }
      return { error: err?.message || String(err), status: err?.status || 400 };
    }
  }

  function resolveLocalCoverImagePath(c, body) {
    const imageFilePath = typeof body?.imageFilePath === "string"
      ? body.imageFilePath
      : typeof body?.generatedFilePath === "string" ? body.generatedFilePath : "";
    if (!imageFilePath) return null;
    if (!canUseLocalAbsolutePaths(c)) {
      return { error: "imageFilePath requires local owner; upload image.contentBase64 for remote clients", status: 403 };
    }
    if (!path.isAbsolute(imageFilePath)) {
      return { error: "imageFilePath must be an absolute image file path", status: 400 };
    }
    return { filePath: imageFilePath, cleanup: null };
  }

  function writeUploadedCoverImage(body) {
    const image = body?.image && typeof body.image === "object" && !Array.isArray(body.image)
      ? body.image
      : null;
    const contentBase64 = typeof image?.contentBase64 === "string" ? image.contentBase64 : "";
    if (!contentBase64) return null;

    const base64 = contentBase64.includes(",") ? contentBase64.split(",").pop() : contentBase64;
    const buffer = Buffer.from(String(base64 || ""), "base64");
    if (buffer.byteLength === 0) {
      return { error: "image.contentBase64 is empty", status: 400 };
    }
    if (buffer.byteLength > MAX_COVER_UPLOAD_BYTES) {
      return { error: "image file too large", status: 413 };
    }

    const filename = typeof image.filename === "string" && image.filename.trim()
      ? image.filename.trim()
      : typeof image.name === "string" && image.name.trim() ? image.name.trim() : "cover.png";
    const ext = path.extname(filename).toLowerCase() || ".png";
    const uploadRoot = path.join(engine.hanakoHome || os.tmpdir(), "tmp", "markdown-cover-uploads");
    fs.mkdirSync(uploadRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(uploadRoot, "cover-"));
    const filePath = path.join(tempDir, `upload-${crypto.randomBytes(4).toString("hex")}${ext}`);
    fs.writeFileSync(filePath, buffer);
    return {
      filePath,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    };
  }

  function coverImageFromRequest(c, body) {
    const local = resolveLocalCoverImagePath(c, body);
    if (local) return local;
    const uploaded = writeUploadedCoverImage(body);
    if (uploaded) return uploaded;
    return { error: "imageFilePath or image.contentBase64 is required", status: 400 };
  }

  function coverRouteError(message, code, status) {
    const err: any = new Error(message);
    err.code = code;
    err.status = status;
    return err;
  }

  function emitMarkdownCoverUpdated(targetInfo) {
    if (targetInfo.target) {
      emitAppEvent(engine, "markdown-cover-updated", { target: targetInfo.target });
    } else {
      emitAppEvent(engine, "markdown-cover-updated", { filePath: targetInfo.filePath });
    }
  }

  async function validateBeautifyGenerationAccess(body) {
    const status = await getBeautifyGenerationStatus(body?.executorAgentId || body?.agentId);
    if (!status.executorAgentId) return { error: "agent unavailable", status: 500, reason: "agent-unavailable" };
    if (!status.enabled) {
      const httpStatus = status.disabledReason === "beautify-disabled"
        ? 403
        : status.disabledReason === "beautify-plugin-unavailable" || status.disabledReason === "image-gen-unavailable"
          ? 404
          : 409;
      return {
        error: status.message || "beautify generation is unavailable",
        status: httpStatus,
        reason: status.disabledReason,
        settingsTarget: status.settingsTarget,
      };
    }
    const agent = engine.getAgent?.(status.executorAgentId);
    return { agent, agentId: status.executorAgentId };
  }

  route.get("/desk/beautify/status", async (c) => {
    const systemCover = { available: isBeautifyPluginAvailable() };
    const agentGenerate = await getBeautifyGenerationStatus(c.req.query("executorAgentId") || c.req.query("agentId"));
    return c.json({
      systemCover,
      agentGenerate,
      // Compatibility for older renderer code while the desktop bundle updates.
      available: systemCover.available,
      enabled: agentGenerate.enabled,
      agentId: agentGenerate.executorAgentId,
    });
  });

  route.post("/desk/beautify/cover/apply", async (c) => {
    const body = await safeJson(c);
    const targetInfo = resolveBeautifyMarkdownTarget(c, body);
    if (targetInfo.error) return c.json({ error: targetInfo.error }, targetInfo.status as any);

    const access = validateMarkdownCoverSystemAccess();
    if (access.error) return c.json({ error: access.error }, access.status as any);

    const image = coverImageFromRequest(c, body);
    if (image.error) return c.json({ error: image.error }, image.status as any);

    try {
      const result = await (applyMarkdownCoverFromGeneratedFile as any)({
        markdownFilePath: targetInfo.filePath,
        generatedFilePath: image.filePath,
      });
      emitMarkdownCoverUpdated(targetInfo);
      return c.json({
        ok: true,
        ...(targetInfo.target ? { target: targetInfo.target } : {}),
        cover: result.cover,
        beautifyCover: result,
      });
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    } finally {
      image.cleanup?.();
    }
  });

  route.post("/desk/beautify/cover/preset/apply", async (c) => {
    const body = await safeJson(c);
    const targetInfo = resolveBeautifyMarkdownTarget(c, body);
    if (targetInfo.error) return c.json({ error: targetInfo.error }, targetInfo.status as any);

    const access = validateMarkdownCoverSystemAccess();
    if (access.error) return c.json({ error: access.error }, access.status as any);

    const presetId = typeof body?.presetId === "string" ? body.presetId : "";
    let imageFilePath;
    try {
      imageFilePath = resolveCoverGalleryPresetImagePath(presetId);
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    }

    try {
      const result = await (applyMarkdownCoverFromGeneratedFile as any)({
        markdownFilePath: targetInfo.filePath,
        generatedFilePath: imageFilePath,
      });
      emitMarkdownCoverUpdated(targetInfo);
      return c.json({
        ok: true,
        ...(targetInfo.target ? { target: targetInfo.target } : {}),
        cover: result.cover,
        beautifyCover: result,
      });
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    }
  });

  route.post("/desk/beautify/cover", async (c) => {
    const body = await safeJson(c);
    const targetInfo = resolveBeautifyMarkdownTarget(c, body);
    if (targetInfo.error) return c.json({ error: targetInfo.error }, targetInfo.status as any);
    const filePath = targetInfo.filePath;

    const access = await validateBeautifyGenerationAccess(body);
    if (access.error) {
      return c.json({
        error: access.error,
        reason: access.reason,
        settingsTarget: access.settingsTarget,
      }, access.status as any);
    }
    const { agent, agentId } = access;

    const activityId = `beautify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const activityDir = path.join(engine.agentsDir, agentId, "activity");
    const store = engine.getActivityStore(agentId);
    const activity = store.add({
      id: activityId,
      type: "beautify",
      label: "Markdown cover",
      status: "running",
      agentId,
      agentName: agent?.agentName || agent?.name || agentId,
      summary: `正在为 ${path.basename(filePath)} 生成 cover`,
      startedAt: Date.now(),
      finishedAt: null,
      sessionFile: null,
      targetFilePath: filePath,
    });
    emitActivityUpdate(activity);

    const themeTone = body?.themeTone === "dark" ? "dark" : "light";
    const userGuidance = typeof body?.userGuidance === "string" ? body.userGuidance.trim() : "";
    const abortController = new AbortController();
    let finalized = false;
    let timeoutTimer;
    const finishActivity = (patch, sessionPath = null) => {
      if (finalized) return null;
      finalized = true;
      clearTimeout(timeoutTimer);
      const updated = store.update(activityId, patch);
      if (updated) emitActivityUpdate(updated, sessionPath);
      return updated;
    };
    timeoutTimer = setTimeout(() => {
      abortController.abort();
      finishActivity(activityTimeoutPatch(activity, Date.now(), DEFAULT_ACTIVITY_EXECUTION_TIMEOUT_MS));
    }, DEFAULT_ACTIVITY_EXECUTION_TIMEOUT_MS);
    timeoutTimer.unref?.();

    void engine.executeIsolated(buildBeautifyCoverPrompt({ filePath, themeTone, userGuidance }), {
      agentId,
      cwd: path.dirname(filePath),
      persist: activityDir,
      activityType: "beautify",
      toolFilter: "*",
      signal: abortController.signal,
      onSessionReady: (sessionPath) => {
        if (!sessionPath || finalized) return;
        const updated = store.update(activityId, { sessionFile: path.basename(sessionPath) });
        if (updated) emitActivityUpdate(updated, sessionPath);
      },
    }).then((result) => {
      const error = result?.error || (Array.isArray(result?.toolErrors) && result.toolErrors.length ? result.toolErrors.join("; ") : null);
      finishActivity({
        status: error ? "error" : "done",
        finishedAt: Date.now(),
        summary: error
          ? `Cover 生成失败：${error}`
          : `已应用 ${path.basename(filePath)} 的 cover`,
        ...(error ? { error } : {}),
        ...(result?.sessionPath ? { sessionFile: path.basename(result.sessionPath) } : {}),
      }, result?.sessionPath || null);
    }).catch((err) => {
      finishActivity({
        status: "error",
        finishedAt: Date.now(),
        error: err?.message || String(err),
        summary: `Cover 生成失败：${err?.message || err}`,
      });
    });

    return c.json({ ok: true, activity });
  });

  /** 活动列表（合并所有 agent） */
  route.get("/desk/activities", async (c) => {
    const allActivities = [];
    const now = Date.now();
    for (const ag of engine.listAgents()) {
      const store = engine.getActivityStore(ag.id);
      emitActivityUpdates(store?.reconcileOverdueRunning?.({ now }));
      const items = store?.list() || [];
      for (const a of items) {
        allActivities.push({
          ...a,
          agentId: a.agentId || ag.id,
          agentName: a.agentName || ag.name,
        });
      }
    }
    // 按 startedAt 倒序
    allActivities.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return c.json({ activities: allActivities });
  });

  /** 读取指定活动的 session 对话消息（只读查看用） */
  route.get("/desk/activities/:id/session", async (c) => {
    const id = c.req.param("id");
    // 从所有 agent 的 activityStore 中查找
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return deskRouteError(c, "activity_not_found", "activity not found", 404);
    if (!entry.sessionFile) return deskRouteError(c, "activity_session_unavailable", "no session file", 404);

    const activityDir = path.join(engine.agentsDir, foundAgentId, "activity");
    const sessionPath = path.join(activityDir, entry.sessionFile);
    if (!fs.existsSync(sessionPath)) return deskRouteError(c, "activity_session_missing", "session file missing", 404);

    try {
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const lines = raw.trim().split("\n").map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const messages = [];
      for (const line of lines) {
        if (line.type !== "message") continue;
        const msg = line.message;
        if (!msg) continue;
        if (msg.role !== "user" && msg.role !== "assistant") continue;

        const content = Array.isArray(msg.content)
          ? msg.content.filter(b => b.type === "text" && b.text).map(b => b.text).join("")
          : (typeof msg.content === "string" ? msg.content : "");

        if (!content) continue;
        messages.push({ role: msg.role, content });
      }

      return c.json({
        activity: {
          id: entry.id,
          type: entry.type,
          label: entry.label || null,
          agentId: entry.agentId || foundAgentId,
          agentName: entry.agentName || engine.getAgent(foundAgentId)?.agentName || foundAgentId,
          summary: entry.summary,
          startedAt: entry.startedAt,
          finishedAt: entry.finishedAt,
        },
        messages,
      });
    } catch (err) {
      return c.json({ error: err.message });
    }
  });

  /** 将活动 session 提升为正常 session（从 activity/ 移到 sessions/） */
  route.post("/desk/activities/:id/promote", async (c) => {
    const id = c.req.param("id");
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return c.json({ error: "activity not found" });
    if (!entry.sessionFile) return c.json({ error: "no session file" });

    const newPath = await engine.promoteActivitySession(entry.sessionFile, foundAgentId);
    if (!newPath) return c.json({ error: "promote failed" });

    // 从 ActivityStore 移除已升格的条目
    const store = engine.getActivityStore(foundAgentId);
    store?.remove(id);

    return c.json({ ok: true, sessionPath: newPath, agentId: foundAgentId });
  });

  /** 用小工具模型快速摘要（DevTools 调试用） */
  route.post("/desk/activities/summarize", async (c) => {
    const body = await safeJson(c);
    const { id } = body;
    if (!id) return c.json({ error: "id required" });
    try {
      const summary = await engine.summarizeActivityQuick(id);
      return c.json({ summary: summary || null });
    } catch (err) {
      return c.json({ error: err.message });
    }
  });

  /** DevTools 日志（历史） */
  route.get("/desk/logs", async (c) => {
    return c.json({ logs: engine.getDevLogs() });
  });

  /** 手动触发心跳巡检（调试用） */
  route.post("/desk/heartbeat", async (c) => {
    const agentId = c.req.query("agentId");
    if (!agentId) return c.json({ error: "agentId is required" }, 400);
    const hb = hub?.scheduler?.getHeartbeat(agentId);
    if (!hb) return deskRouteError(c, "heartbeat_unavailable", "Heartbeat not initialized", 503);
    hb.triggerNow();
    return c.json({ ok: true, message: t("error.heartbeatTriggered") });
  });

  // ════════════════════════════
  //  Cron 任务
  // ════════════════════════════

  /** 列出 cron 任务 */
  route.get("/desk/cron", async (c) => {
    const store = getStudioCronStore(engine);
    if (!store) return c.json({ jobs: [] });
    return c.json({ jobs: store.listJobs() });
  });

  /** 操作 cron 任务 */
  route.post("/desk/cron", async (c) => {
    const store = getStudioCronStore(engine);
    if (!store) return deskRouteError(c, "cron_store_unavailable", "Desk not initialized", 503);

    const body = await safeJson(c);
    const { action, ...params } = body;

    switch (action) {
      case "add": {
        const type = params.scheduleType || params.type;
        const executor = normalizeRouteExecutor(params.executor);
        const executorError = validateRouteExecutor(executor);
        if (executorError) return c.json({ error: executorError }, 400);
        const enabled = params.enabled !== false;
        const requiresPrompt = enabled && (!executor || executor.kind === "agent_session");
        if (!type || !params.schedule || (requiresPrompt && !params.prompt)) {
          return c.json({ error: "scheduleType, schedule, prompt required" }, 400);
        }
        const VALID_TYPES = new Set(["at", "every", "cron"]);
        if (!VALID_TYPES.has(type)) {
          return c.json({ error: `Invalid scheduleType: ${type}. Must be at/every/cron.` }, 400);
        }
        if (type === "every") {
          const minutes = parseInt(params.schedule, 10);
          if (isNaN(minutes) || minutes <= 0) {
            return c.json({ error: "every schedule must be a positive number (minutes)" }, 400);
          }
          params.schedule = minutes * 60_000;
        }
        const actorAgentId = typeof params.actorAgentId === "string" && params.actorAgentId.trim()
          ? params.actorAgentId.trim()
          : null;
        const executionContext = normalizeRouteExecutionContext(params.executionContext, actorAgentId);
        if (!actorAgentId || !executionContext) {
          return c.json({ error: "actorAgentId and executionContext required" }, 400);
        }
        if (typeof engine.getAgent === "function" && !engine.getAgent(actorAgentId)) {
          return c.json({ error: `agent not found: ${actorAgentId}` }, 404);
        }
        const job = store.addJob({
          type,
          schedule: params.schedule,
          prompt: typeof params.prompt === "string" ? params.prompt : "",
          label: params.label,
          model: params.model,
          actorAgentId,
          executionContext,
          executor,
          createdBy: normalizeRouteCreatedBy(params.createdBy),
          enabled,
        });
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      case "remove": {
        if (!params.id) return c.json({ error: "id required" });
        const ok = store.removeJob(params.id);
        if (!ok) return c.json({ error: "not found" });
        return c.json({ ok: true, jobs: store.listJobs() });
      }

      case "toggle": {
        if (!params.id) return c.json({ error: "id required" });
        let job;
        try {
          job = store.toggleJob(params.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return c.json({ error: message }, 400);
        }
        if (!job) return c.json({ error: "not found" });
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      case "update": {
        if (!params.id) return c.json({ error: "id required" });
        const { id, ...fields } = params;
        const existingJob = store.getJob(id);
        if (!existingJob) return c.json({ error: "not found" });
        if (Object.prototype.hasOwnProperty.call(fields, "executor")) {
          fields.executor = normalizeRouteExecutor(fields.executor);
          const executorError = validateRouteExecutor(fields.executor);
          if (executorError) return c.json({ error: executorError }, 400);
        }
        if (Object.prototype.hasOwnProperty.call(fields, "actorAgentId")) {
          fields.actorAgentId = typeof fields.actorAgentId === "string" && fields.actorAgentId.trim()
            ? fields.actorAgentId.trim()
            : null;
          if (!fields.actorAgentId) return c.json({ error: "actorAgentId required" }, 400);
          if (typeof engine.getAgent === "function" && !engine.getAgent(fields.actorAgentId)) {
            return c.json({ error: `agent not found: ${fields.actorAgentId}` }, 404);
          }
        }
        if (Object.prototype.hasOwnProperty.call(fields, "executionContext")) {
          const actorAgentId = typeof fields.actorAgentId === "string" && fields.actorAgentId.trim()
            ? fields.actorAgentId.trim()
            : existingJob.actorAgentId;
          fields.executionContext = normalizeRouteExecutionContext(fields.executionContext, actorAgentId);
          if (!fields.executionContext) return c.json({ error: "executionContext required" }, 400);
        }
        const VALID_TYPES = new Set(["at", "every", "cron"]);
        if (fields.type !== undefined && !VALID_TYPES.has(fields.type)) {
          return c.json({ error: `Invalid scheduleType: ${fields.type}. Must be at/every/cron.` }, 400);
        }
        if (fields.type !== undefined && fields.type !== existingJob.type && fields.schedule === undefined) {
          return c.json({ error: "schedule required when changing scheduleType" }, 400);
        }
        const nextType = fields.type || existingJob.type;
        if (fields.schedule !== undefined && nextType === "every") {
          if (typeof fields.schedule === "number") {
            if (!Number.isFinite(fields.schedule) || fields.schedule <= 0) {
              return c.json({ error: "every schedule must be a positive number" }, 400);
            }
            fields.schedule = fields.schedule < 60_000 ? fields.schedule * 60_000 : fields.schedule;
          } else {
            const minutes = parseInt(fields.schedule, 10);
            if (isNaN(minutes) || minutes <= 0) {
              return c.json({ error: "every schedule must be a positive number (minutes)" }, 400);
            }
            fields.schedule = minutes * 60_000;
          }
        }
        let job;
        try {
          job = store.updateJob(id, fields);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return c.json({ error: message }, 400);
        }
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      default:
        return deskRouteError(c, "unknown_cron_action", `unknown action: ${action}`, 400);
    }
  });

  // ════════════════════════════
  //  工作台文件（直接使用 cwd）
  // ════════════════════════════

  /** 扫描工作台下的项目级技能 */
  route.get("/desk/skills", async (c) => {
    try {
      const agentId = c.req.query("agentId") || null;
      const workspace = resolveWorkspaceRootFromRequest(c);
      const dir = workspace.dir;
      if (!dir) return c.json({ skills: [] });
      if (!workspace.mountId && c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ skills: [] });

      const results = [];
      for (const { sub, label } of WORKSPACE_SKILL_DIRS) {
        const skillsDir = path.join(dir, sub);
        if (!fs.existsSync(skillsDir)) continue;
        try {
          for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
            if (!fs.existsSync(skillFile)) continue;
            try {
              const content = fs.readFileSync(skillFile, "utf-8");
              const meta = parseSkillMetadata(content, entry.name);
              results.push({
                name: meta.name,
                description: meta.description,
                source: label,
                dirPath: skillsDir,
                filePath: skillFile,
                baseDir: path.join(skillsDir, entry.name),
                workspaceMountId: workspace.mountId,
              });
            } catch { /* ignore malformed workspace skill entries */ }
          }
        } catch { /* ignore unreadable workspace skill roots */ }
      }
      return c.json({ skills: results });
    } catch (err) {
      if (err instanceof MountAwareFileError) return c.json({ error: err.message, code: err.code }, err.status as any);
      return c.json({ error: err?.message || String(err) }, err?.status || 500);
    }
  });

  /**
   * 拖拽安装项目技能
   * 接收文件路径，自动创建 .agents/skills/ 并安装
   * 支持文件夹（直接复制）和 .zip/.skill（解压）
   */
  route.post("/desk/install-skill", async (c) => {
    const body = await safeJson(c);
    let uploadedSource = null;
    try {
      const { filePath, dir } = body;
      const agentId = body.agentId || null;
      const workspace = resolveWorkspaceRootFromRequest(c, body);
      const cwd = workspace.dir;
      const sourcePath = filePath || (uploadedSource = materializeUploadedSkillPackage(engine, body))?.sourcePath;
      if (!sourcePath || !cwd) {
        return c.json({ error: "skill package and active workspace required" }, 400);
      }
      if (!workspace.mountId && dir && !isApprovedDir(cwd, engine, { agentId })) {
        return c.json({ error: "workspace is not approved" }, 403);
      }

      const skillsDir = path.join(cwd, ".agents", "skills");

      // 确保 .agents/skills/ 存在
      fs.mkdirSync(skillsDir, { recursive: true });

      // macOS: 隐藏 .agents 目录（chflags hidden）
      if (process.platform === "darwin") {
        const agentsDir = path.join(cwd, ".agents");
        try { execFileSync("chflags", ["hidden", agentsDir]); } catch { /* best effort macOS Finder hint */ }
      }

      const installed = await installSkillPackageFromPath({
        sourcePath,
        installDir: skillsDir,
        owner: "workspace",
      });
      if (typeof engine.syncWorkspaceSkillPaths === "function") {
        await engine.syncWorkspaceSkillPaths(cwd, { reload: true, emitEvent: true, force: true, agentId });
      }
      return c.json({
        ok: true,
        name: installed.name,
        installedSkillSource: installed.installedSkillSource,
      });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    } finally {
      uploadedSource?.cleanup?.();
    }
  });

  /** 删除项目技能 */
  route.post("/desk/delete-skill", async (c) => {
    const body = await safeJson(c);
    const { skillDir } = body;
    const agentId = body.agentId || null;
    if (!skillDir) {
      return c.json({ error: "skillDir is required" }, 400);
    }
    try {
      // 安全检查：必须在当前工作区的已知技能目录下
      const workspace = resolveWorkspaceRootFromRequest(c, body);
      const cwd = workspace.dir;
      if (!cwd) {
        return c.json({ error: "No active workspace" }, 400);
      }
      const ALLOWED_SKILL_SUBS = WORKSPACE_SKILL_DIRS.map(({ sub }) => sub);
      const allowed = ALLOWED_SKILL_SUBS.some(sub =>
        isInsidePath(skillDir, path.join(cwd, sub))
      );
      if (!allowed) {
        return c.json({ error: "Only skills in current workspace skill directories can be deleted" }, 403);
      }
      fs.rmSync(skillDir, { recursive: true, force: true });
      if (typeof engine.syncWorkspaceSkillPaths === "function") {
        await engine.syncWorkspaceSkillPaths(cwd, { reload: true, emitEvent: true, force: true, agentId });
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  /** 工作台路径 */
  route.get("/desk/path", async (c) => {
    const agentId = c.req.query("agentId") || null;
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine);
    if (!dir) return c.json({ path: null });
    if (c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    fs.mkdirSync(dir, { recursive: true });
    return c.json({ path: dir });
  });

  /** 列出工作台文件（支持 ?subdir=xxx 浏览子目录, ?dir=xxx 覆盖基目录） */
  route.get("/desk/files", async (c) => {
    const agentId = c.req.query("agentId") || null;
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine);
    if (!dir) return c.json({ files: [], subdir: "", basePath: null });
    if (c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    const subdir = c.req.query("subdir") || "";
    // 安全：禁止路径穿越
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });
    return c.json({ files: await listWorkspaceFiles(target), subdir: subdir || "", basePath: dir });
  });

  /** 搜索工作台文件名（递归，默认跳过隐藏目录和常见依赖/构建目录） */
  route.get("/desk/search-files", async (c) => {
    const agentId = c.req.query("agentId") || null;
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine);
    if (!dir) return c.json({ results: [], basePath: null, query: c.req.query("q") || "" });
    if (c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    const query = c.req.query("q") || "";
    const limitRaw = Number.parseInt(c.req.query("limit") || "", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, WORKSPACE_SEARCH_LIMIT)
      : WORKSPACE_SEARCH_LIMIT;
    let stat = null;
    try {
      stat = await fs.promises.stat(dir);
    } catch {
      return c.json({ results: [], basePath: dir, query });
    }
    if (!stat.isDirectory()) return c.json({ error: t("error.pathNotFound") });
    return c.json({ results: await searchWorkspaceFiles(dir, query, { limit }), basePath: dir, query });
  });

  /** 读取指定目录的 jian.md */
  route.get("/desk/jian", async (c) => {
    const agentId = c.req.query("agentId") || null;
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine);
    if (!dir) return c.json({ content: null });
    if (c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    const subdir = c.req.query("subdir") || "";
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });
    const jianPath = path.join(target, "jian.md");
    if (!fs.existsSync(jianPath)) return c.json({ content: null });
    try {
      return c.json({ content: fs.readFileSync(jianPath, "utf-8") });
    } catch {
      return c.json({ content: null });
    }
  });

  /** 保存指定目录的 jian.md（自动创建 / 内容为空时删除） */
  route.post("/desk/jian", async (c) => {
    const body = await safeJson(c);
    const agentId = body.agentId || null;
    const dir = body.dir ? body.dir : defaultDeskDir(engine);
    if (!dir) return c.json({ error: t("error.noWorkspace") });
    if (body.dir && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    const { subdir, content } = body;
    const sub = subdir || "";
    if (sub && (sub.includes("\\") || sub.includes("..") || sub.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = sub ? path.join(dir, sub) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });
    const jianPath = path.join(target, "jian.md");

    try {
      if (content === null || content === undefined || content.trim() === "") {
        // 内容为空 → 删除 jian.md
        if (fs.existsSync(jianPath)) fs.unlinkSync(jianPath);
        return c.json({ ok: true, content: null });
      }
      // 确保目录存在
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(jianPath, content, "utf-8");
      return c.json({ ok: true, content });
    } catch (err) {
      return c.json({ error: err.message });
    }
  });

  /** 工作台文件操作（支持 subdir + dir override） */
  route.post("/desk/files", async (c) => {
    const body = await safeJson(c);
    const agentId = body.agentId || null;
    const baseDir = body.dir || defaultDeskDir(engine);
    if (!baseDir) return c.json({ error: t("error.noWorkspace") });
    if (body.dir && !isApprovedDir(baseDir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    fs.mkdirSync(baseDir, { recursive: true });

    const { action, subdir: sub, paths, name, content, oldName, newName } = body;

    // 解析子目录
    const isValidSubdir = (value) => {
      const subdir = value || "";
      return !(subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."));
    };
    const subdirStr = sub || "";
    if (!isValidSubdir(subdirStr)) return c.json({ error: "invalid subdir" });
    const dir = subdirStr ? path.join(baseDir, subdirStr) : baseDir;
    if (!isInsidePath(dir, baseDir)) return c.json({ error: "invalid path" });

    const subdirToDir = (value) => {
      const subdir = value || "";
      if (!isValidSubdir(subdir)) return null;
      const target = subdir ? path.join(baseDir, subdir) : baseDir;
      return isInsidePath(target, baseDir) ? target : null;
    };

    switch (action) {
      case "upload": {
        // upload 接受调用方提供的绝对源路径列表，把本机文件复制进 desk。
        // 该语义只为桌面 owner 端的本机拖拽设计；远端 paired 设备不应能借此
        // 把 desk dir 之外的任意可读路径（~/Documents、Library、shell init 等）
        // 拷进工作区再读回。远端要上传文件应走 /api/workbench/upload。
        if (!isLocalOwnerPrincipal(readAuthPrincipal(c))) {
          return c.json({ error: "upload by absolute path requires local owner" }, 403);
        }
        if (!Array.isArray(paths) || paths.length === 0) {
          return deskRouteError(c, "workspace_file_validation_failed", "paths required", 400);
        }
        const results = [];
        for (const srcPath of paths) {
          try {
            if (!path.isAbsolute(srcPath) || !fs.existsSync(srcPath)) {
              results.push({ src: srcPath, error: "invalid path" });
              continue;
            }
            if (isSensitivePath(srcPath, engine.hanakoHome)) {
              results.push({ src: srcPath, error: "sensitive path blocked" });
              continue;
            }
            const fname = path.basename(srcPath);
            const dest = path.join(dir, fname);
            const stat = fs.statSync(srcPath);
            if (stat.isDirectory()) {
              fs.cpSync(srcPath, dest, { recursive: true });
            } else {
              fs.copyFileSync(srcPath, dest);
            }
            results.push({ src: srcPath, name: fname });
          } catch (err) {
            results.push({ src: srcPath, error: err.message });
          }
        }
        return c.json({ ok: true, results, files: await listWorkspaceFiles(dir) });
      }

      case "create": {
        if (!name || content === undefined) {
          return deskRouteError(c, "workspace_file_validation_failed", "name and content required", 400);
        }
        if (!isPlainEntryName(name)) return c.json({ error: "invalid name" });
        const createTarget = path.join(dir, name);
        if (!isInsidePath(createTarget, dir)) return c.json({ error: "invalid name" });
        if (fs.existsSync(createTarget)) return c.json({ error: "target already exists" });
        fs.writeFileSync(createTarget, content, "utf-8");
        return c.json({ ok: true, files: await listWorkspaceFiles(dir) });
      }

      case "mkdir": {
        if (!name) return deskRouteError(c, "workspace_file_validation_failed", "name required", 400);
        if (!isPlainEntryName(name)) return c.json({ error: "invalid name" });
        const mkTarget = path.join(dir, name);
        if (!isInsidePath(mkTarget, dir)) return c.json({ error: "invalid name" });
        if (fs.existsSync(mkTarget)) return c.json({ error: "already exists" });
        fs.mkdirSync(mkTarget, { recursive: true });
        return c.json({ ok: true, files: await listWorkspaceFiles(dir) });
      }

      case "rename": {
        if (!oldName || !newName) return deskRouteError(c, "workspace_file_validation_failed", "oldName and newName required", 400);
        if (!isPlainEntryName(oldName) || !isPlainEntryName(newName)) return c.json({ error: "invalid name" });
        const src = path.join(dir, oldName);
        const dest = path.join(dir, newName);
        if (!isInsidePath(src, dir) || !isInsidePath(dest, dir)) return c.json({ error: "invalid name" });
        if (!fs.existsSync(src)) return c.json({ error: "not found" });
        if (fs.existsSync(dest)) return c.json({ error: "target already exists" });
        fs.renameSync(src, dest);
        return c.json({ ok: true, files: await listWorkspaceFiles(dir) });
      }

      case "move": {
        const names = body.names;
        const destFolder = body.destFolder;
        if (!Array.isArray(names) || names.length === 0 || !destFolder) {
          return deskRouteError(c, "workspace_file_validation_failed", "names[] and destFolder required", 400);
        }
        if (names.includes(destFolder)) {
          return c.json({ error: "cannot move folder into itself" });
        }
        const destDir = path.join(dir, path.basename(destFolder));
        if (!isInsidePath(destDir, dir)) return c.json({ error: "invalid destFolder" });
        if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
          return c.json({ error: "destFolder is not a directory" });
        }
        const results = [];
        for (const n of names) {
          const src = path.join(dir, path.basename(n));
          const dest = path.join(destDir, path.basename(n));
          if (!isInsidePath(src, dir)) { results.push({ name: n, error: "invalid name" }); continue; }
          if (!fs.existsSync(src)) { results.push({ name: n, error: "not found" }); continue; }
          if (fs.existsSync(dest)) { results.push({ name: n, error: "target already exists" }); continue; }
          try {
            fs.renameSync(src, dest);
            results.push({ name: n, ok: true });
          } catch (err) {
            results.push({ name: n, error: err.message });
          }
        }
        return c.json({ ok: true, results, files: await listWorkspaceFiles(dir) });
      }

      case "movePaths": {
        const items = body.items;
        const destSubdir = body.destSubdir || "";
        const currentSubdir = body.currentSubdir || "";
        if (!Array.isArray(items) || items.length === 0) {
          return deskRouteError(c, "workspace_file_validation_failed", "items[] required", 400);
        }
        const destDir = subdirToDir(destSubdir);
        if (!destDir) return c.json({ error: "invalid destSubdir" });
        if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
          return c.json({ error: "destSubdir is not a directory" });
        }

        const affectedSubdirs = new Set([destSubdir, currentSubdir]);
        const results = [];
        for (const item of items) {
          const sourceSubdir = item && typeof item.sourceSubdir === "string" ? item.sourceSubdir : "";
          const itemName = item && typeof item.name === "string" ? path.basename(item.name) : "";
          if (!itemName) { results.push({ name: item?.name, error: "invalid name" }); continue; }
          const sourceDir = subdirToDir(sourceSubdir);
          if (!sourceDir) { results.push({ name: itemName, error: "invalid sourceSubdir" }); continue; }

          const src = path.join(sourceDir, itemName);
          const dest = path.join(destDir, itemName);
          if (!isInsidePath(src, sourceDir) || !isInsidePath(dest, destDir)) {
            results.push({ name: itemName, error: "invalid path" });
            continue;
          }
          if (!fs.existsSync(src)) { results.push({ name: itemName, error: "not found" }); continue; }
          if (src === dest) { results.push({ name: itemName, ok: true, skipped: true }); continue; }
          if (fs.existsSync(dest)) { results.push({ name: itemName, error: "target already exists" }); continue; }

          const sourceRel = sourceSubdir ? `${sourceSubdir}/${itemName}` : itemName;
          if (fs.statSync(src).isDirectory() && (destSubdir === sourceRel || destSubdir.startsWith(`${sourceRel}/`))) {
            results.push({ name: itemName, error: "cannot move folder into itself" });
            continue;
          }

          try {
            fs.renameSync(src, dest);
            affectedSubdirs.add(sourceSubdir);
            affectedSubdirs.add(destSubdir);
            results.push({ name: itemName, ok: true });
          } catch (err) {
            results.push({ name: itemName, error: err.message });
          }
        }

        const filesByPath = {};
        for (const subdir of affectedSubdirs) {
          if (!isValidSubdir(subdir)) continue;
          const targetDir = subdirToDir(subdir);
          if (targetDir && fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
            filesByPath[subdir] = await listWorkspaceFiles(targetDir);
          }
        }
        return c.json({ ok: true, results, filesByPath, files: await listWorkspaceFiles(dir) });
      }

      case "remove": {
        if (!name) return deskRouteError(c, "workspace_file_validation_failed", "name required", 400);
        const rmTarget = path.join(dir, path.basename(name));
        if (!isInsidePath(rmTarget, dir)) return c.json({ error: "invalid name" });
        if (!fs.existsSync(rmTarget)) return c.json({ error: "not found" });
        fs.rmSync(rmTarget, { recursive: true, force: true });
        return c.json({ ok: true, files: await listWorkspaceFiles(dir) });
      }

      default:
        return deskRouteError(c, "unknown_workspace_file_action", `unknown action: ${action}`, 400);
    }
  });

  return route;
}
