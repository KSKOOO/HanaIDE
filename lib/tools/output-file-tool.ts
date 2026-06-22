/**
 * output-file-tool.js — 文件暂存工具（stage_files）
 *
 * Legacy compatibility layer:
 * stage_files is retained for existing Agent prompts, old sessions, block
 * extractors, and delivery cards. Do not grow new Resource/Storage behavior in
 * this tool; add new file-resource behavior behind FileRef/ResourceIO instead.
 *
 * agent 声明持有文件，框架按上下文投递（桌面渲染 / bridge 发送）。
 * 服务端拦截 tool_execution_end 事件，通过 WebSocket 推送 file_output 事件给前端。
 *
 * 参数：{ filepaths: string[] } 或 { fileIds: string[] }
 * 同时向下兼容旧的单文件调用：{ filePath: string, fileId?: string, label?: string }
 */
import fs from "fs";
import path from "path";
import { Type } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import { getToolSessionPath } from "./tool-session.ts";

/** 修正 LLM 常见的路径问题：转义空格、URL 编码、多余引号 */
function sanitizePath(p: any) {
  p = p.trim().replace(/^["']|["']$/g, "");
  p = p.replace(/\\ /g, " ");
  if (p.includes("%20")) {
    try { p = decodeURIComponent(p); } catch {}
  }
  return p;
}

export function createStageFilesTool({ registerSessionFile, resolveSessionFile, getSessionPath }: { registerSessionFile?: any; resolveSessionFile?: any; getSessionPath?: any } = {}) {
  return {
    name: "stage_files",
    label: "Stage Files",
    description: "Deliver files to the user, desktop, or Bridge platforms. Accepts SessionFile ids or local absolute paths.",
    parameters: Type.Object({
      fileIds: Type.Optional(Type.Array(Type.String(), {
        minItems: 1,
        description: "SessionFile ids to deliver. Prefer this for files already shown by current_status or returned by another tool.",
      })),
      fileId: Type.Optional(Type.String({ description: "(Compat) Single SessionFile id to deliver. Prefer fileIds for new calls." })),
      filepaths: Type.Optional(Type.Array(Type.String(), {
        minItems: 1,
        description: "Local absolute file paths to deliver when no SessionFile id is available. StageFile will register them for desktop, Bridge, or future mobile consumers.",
      })),
      // 向下兼容旧接口
      filePath: Type.Optional(Type.String({ description: "(Compat) Single local absolute file path. Prefer filepaths for new calls." })),
      label: Type.Optional(Type.String({ description: "(Compat) File name shown to the user. Usually omit this; the filename is used by default." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const results = [];
      const errors = [];
      const sessionPath = getToolSessionPath(ctx) || ctx?.sessionPath || getSessionPath?.() || null;

      // 优先交付已登记 SessionFile：用 fileId 找真相源，再复用 stage_files 的交付语义。
      let fileIds = params.fileIds;
      if (!fileIds || fileIds.length === 0) {
        fileIds = params.fileId ? [params.fileId] : [];
      }
      for (const fileId of fileIds || []) {
        if (!fileId || typeof fileId !== "string") continue;
        if (typeof resolveSessionFile !== "function") {
          errors.push("stage_files requires a SessionFile resolver to deliver fileIds");
          continue;
        }
        try {
          const sessionFile = await resolveSessionFile(fileId, { sessionPath });
          if (!sessionFile) {
            errors.push(`SessionFile not found: ${fileId}`);
            continue;
          }
          const resolvedPath = sessionFile.filePath || sessionFile.realPath || "";
          const label = params.label || sessionFile.label || sessionFile.displayName || sessionFile.filename || fileId;
          const ext = sessionFile.ext || path.extname(sessionFile.filename || resolvedPath || "").toLowerCase().replace(".", "");
          const effectiveSessionPath = sessionPath || sessionFile.sessionPath || null;
          let deliveredFile = sessionFile;
          if (
            typeof registerSessionFile === "function"
            && effectiveSessionPath
            && resolvedPath
            && path.isAbsolute(resolvedPath)
            && fs.existsSync(resolvedPath)
          ) {
            deliveredFile = await registerSessionFile({
              sessionPath: effectiveSessionPath,
              filePath: resolvedPath,
              label,
              origin: "stage_files",
            });
          }
          results.push(toStageFileResult(deliveredFile, { filePath: resolvedPath, label, ext }));
        } catch (err) {
          errors.push(err?.message || String(err));
        }
      }

      // 统一为路径数组：优先使用 filepaths，兼容 filePath。
      let paths = params.filepaths;
      if (!paths || paths.length === 0) {
        if (params.filePath) {
          paths = [params.filePath];
        } else {
          paths = [];
        }
      }

      for (const raw of paths) {
        const fp = sanitizePath(raw);

        if (!path.isAbsolute(fp)) {
          errors.push(t("error.outputFileNotAbsolute", { path: fp }));
          continue;
        }
        if (!fs.existsSync(fp)) {
          errors.push(t("error.outputFileNotFound", { path: fp }));
          continue;
        }

        const displayLabel = path.basename(fp);
        const ext = path.extname(fp).toLowerCase().replace(".", "");
        const label = params.label || displayLabel;
        if (registerSessionFile) {
          if (!sessionPath) {
            errors.push("stage_files requires an active sessionPath to register files");
            continue;
          }
          try {
            const sessionFile = await registerSessionFile({
              sessionPath,
              filePath: fp,
              label,
              origin: "stage_files",
            });
            results.push(toStageFileResult(sessionFile, { filePath: fp, label, ext }));
          } catch (err) {
            errors.push(err?.message || String(err));
          }
        } else {
          results.push({ filePath: fp, label, ext });
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: errors.join("\n") || t("error.outputFileNeedPaths") }],
          details: {},
        };
      }

      const summary = results.map(r => r.label).join(", ");
      return {
        content: [{ type: "text", text: t("error.outputFilePresented", { summary }) }],
        details: {
          files: results,
          media: {
            ...(results.some(r => r.fileId) ? { items: results.map(toMediaItem).filter(Boolean) } : {}),
            mediaUrls: results.map(r => r.filePath),
          },
        },
      };
    },
  };
}

function toStageFileResult(sessionFile: any, legacy: any) {
  const fileId = sessionFile?.id || sessionFile?.fileId || null;
  return {
    ...(fileId ? { id: fileId, fileId } : {}),
    filePath: sessionFile?.filePath || legacy.filePath,
    label: legacy.label || sessionFile?.displayName || sessionFile?.label,
    ext: sessionFile?.ext || legacy.ext || "",
    ...(sessionFile?.mime ? { mime: sessionFile.mime } : {}),
    ...(sessionFile?.size !== undefined ? { size: sessionFile.size } : {}),
    ...(sessionFile?.kind ? { kind: sessionFile.kind } : {}),
    ...(sessionFile?.sessionPath ? { sessionPath: sessionFile.sessionPath } : {}),
    ...(sessionFile?.origin ? { origin: sessionFile.origin } : {}),
    ...(sessionFile?.storageKind ? { storageKind: sessionFile.storageKind } : {}),
    ...(sessionFile?.status ? { status: sessionFile.status } : {}),
    ...(sessionFile?.missingAt !== undefined ? { missingAt: sessionFile.missingAt } : {}),
    ...(sessionFile?.resource ? { resource: sessionFile.resource } : {}),
  };
}

function toMediaItem(file: any) {
  if (!file?.fileId) return null;
  return {
    type: "session_file",
    fileId: file.fileId,
    sessionPath: file.sessionPath,
    filePath: file.filePath,
    filename: path.basename(file.filePath),
    label: file.label,
    mime: file.mime,
    size: file.size,
    kind: file.kind,
  };
}
