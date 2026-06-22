/**
 * sandbox/index.js — 沙盒入口（无状态工厂）
 *
 * 每次 buildTools 调用时创建 session 级的 PathGuard + OS 沙盒 exec。
 * 不持有 engine 级状态，天然支持多 agent 并发。
 */

import { deriveSandboxPolicy } from "./policy.ts";
import { PathGuard } from "./path-guard.ts";
import { detectPlatform, checkAvailability } from "./platform.ts";
import { createSeatbeltExec } from "./seatbelt.ts";
import { createBwrapExec } from "./bwrap.ts";
import { createWin32Exec } from "./win32-exec.ts";
import { wrapPathTool, wrapBashTool } from "./tool-wrapper.ts";
import { createEnhancedReadFile } from "./read-enhanced.ts";
import { wrapReadImageWithVisionBridge } from "./read-image-vision.ts";
import { wrapReadOfficeMedia } from "./read-office-media.ts";
import { createManagedConfigWriteGuard } from "./managed-config-guard.ts";
import { t } from "../i18n.ts";
import fs, { constants } from "fs";
import { access as fsAccess } from "fs/promises";
import path, { extname } from "path";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "../pi-sdk/index.ts";
import { normalizeWin32ShellPath } from "./win32-path.ts";
import { serializeSessionFile } from "../session-files/session-file-response.ts";

/**
 * 为一个 session 创建沙盒包装后的工具集
 *
 * 每次调用独立，不共享状态。
 * 当传入 getSandboxEnabled 回调时，工具在每次调用时动态检查沙盒状态，
 * 切换偏好后无需重建 session 即可生效。
 *
 * @param {string} cwd  工作目录
 * @param {object[]} customTools  自定义工具
 * @param {object} opts
 * @param {string} opts.agentDir
 * @param {string|null} opts.workspace
 * @param {string[]} [opts.workspaceFolders]
 * @param {string[]} [opts.authorizedFolders]
 * @param {() => string[]} [opts.getAuthorizedFolders]  当前 session 动态授权的额外沙盒目录
 * @param {string} opts.hanakoHome
 * @param {() => boolean} opts.getSandboxEnabled  动态沙盒开关（每次工具调用时求值）
 * @param {() => boolean} [opts.getSandboxNetworkEnabled]  动态沙盒联网开关（仅沙盒开启时生效）
 * @param {() => string[]} [opts.getExternalReadPaths]  当前 session 用户显式给过的外部只读路径
 * @param {() => string|null} [opts.getSessionPath]  当前工具调用归属的 sessionPath
 * @param {(sessionPath: string) => string|null} [opts.getSessionIdForPath]  sessionPath locator → sessionId
 * @param {(fileId: string, options?: {sessionPath?: string|null}) => object|null} [opts.resolveSessionFile]  SessionFile resolver
 * @param {(entry: object) => void} [opts.recordFileOperation]  记录 write/edit 触达的 session file
 * @param {() => object|null} [opts.getVisionBridge]  辅助视觉桥
 * @param {() => boolean} [opts.isVisionAuxiliaryEnabled]  辅助视觉开关
 * @param {object|null} [opts.legacyCleanupQueue] Windows 旧 ACL 清理队列
 * @returns {{ tools: object[], customTools: object[] }}
 */
export function createSandboxedTools(cwd, customTools, {
  agentDir,
  workspace,
  workspaceFolders = [],
  authorizedFolders = [],
  getAuthorizedFolders,
  hanakoHome,
  getSandboxEnabled,
  getSandboxNetworkEnabled,
  getExternalReadPaths,
  getSessionPath,
  getSessionIdForPath,
  resolveSessionFile,
  recordFileOperation,
  getVisionBridge,
  isVisionAuxiliaryEnabled,
  legacyCleanupQueue = null,
}) {
  // 始终按 standard 模式构建策略和 PathGuard，wrappers 在运行时动态 bypass
  const resolveAuthorizedFolders = () => {
    if (typeof getAuthorizedFolders === "function") {
      const folders = getAuthorizedFolders();
      return Array.isArray(folders) ? folders : [];
    }
    return Array.isArray(authorizedFolders) ? authorizedFolders : [];
  };
  const makePolicy = () => deriveSandboxPolicy({
    agentDir,
    cwd,
    workspace,
    workspaceFolders: [
      ...(Array.isArray(workspaceFolders) ? workspaceFolders : []),
      ...resolveAuthorizedFolders(),
    ],
    hanakoHome,
    mode: "standard",
  });
  const guard = {
    check: (absolutePath, operation) => new PathGuard(makePolicy()).check(absolutePath, operation),
  };

  // 增强 readFile：xlsx 解析 + 编码检测，保留 PI SDK 默认的 access / detectImageMimeType
  const IMAGE_MIMES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
  const readOps = {
    readFile: createEnhancedReadFile(),
    access: (p) => fsAccess(p, constants.R_OK),
    detectImageMimeType: async (p) => IMAGE_MIMES[extname(p).toLowerCase()] || undefined,
  };

  const platform = detectPlatform();
  const isWin32 = process.platform === "win32";
  const checkManagedConfigWrite = createManagedConfigWriteGuard({ hanakoHome });
  const wrapOpts = { getSandboxEnabled, getExternalReadPaths, checkManagedConfigWrite };
  const resolveSandboxNetworkEnabled = typeof getSandboxNetworkEnabled === "function"
    ? getSandboxNetworkEnabled
    : () => true;

  // 无 OS 沙盒时的 bash 工具（沙盒关闭时回退用）
  const normalBashTool = isWin32
    ? createBashTool(cwd, { operations: { exec: createWin32Exec() } })
    : createBashTool(cwd);

  const bashWrapOpts = { getSandboxEnabled, getExternalReadPaths, fallbackTool: normalBashTool, checkManagedConfigWrite };
  const writeTool = wrapFileTouchTool(createWriteTool(cwd), cwd, {
    origin: "agent_write",
    operationForPath: (filePath) => fs.existsSync(filePath) ? "modified" : "created",
    getSessionPath,
    recordFileOperation,
  });
  const editTool = wrapFileTouchTool(createEditTool(cwd), cwd, {
    origin: "agent_edit",
    operationForPath: () => "modified",
    getSessionPath,
    recordFileOperation,
  });
  const readTool = wrapSessionFilePathTool(wrapReadImageWithVisionBridge(wrapReadOfficeMedia(createReadTool(cwd, { operations: readOps }), cwd, {
    hanakoHome,
    getSessionPath,
    getSessionIdForPath,
    recordFileOperation,
    getVisionBridge,
    isVisionAuxiliaryEnabled,
  }), cwd, {
    getSessionPath,
    getSessionIdForPath,
    recordFileOperation,
    getVisionBridge,
    isVisionAuxiliaryEnabled,
  }), { getSessionPath, resolveSessionFile });

  // ── Windows: PathGuard 包装 + restricted-token exec，关闭沙盒时走 direct fallback ──
  if (platform === "win32-restricted-token") {
    const sandboxedBashTool = createBashTool(cwd, {
      operations: {
        exec: ((command, execCwd, execOpts) => createWin32Exec({
          sandbox: {
            policy: makePolicy(),
            hanakoHome,
            getExternalReadPaths,
            getSandboxNetworkEnabled: resolveSandboxNetworkEnabled,
            legacyCleanupQueue,
          },
        })(command, execCwd, execOpts)) as any,
      },
    });
    return {
      tools: [
        wrapPathTool(readTool, guard, "read", cwd, wrapOpts),
        wrapPathTool(writeTool, guard, "write", cwd, wrapOpts),
        wrapPathTool(editTool, guard, "write", cwd, wrapOpts),
        wrapBashTool(sandboxedBashTool, guard, cwd, bashWrapOpts),
        wrapPathTool(createGrepTool(cwd, undefined), guard, "read", cwd, wrapOpts),
        wrapPathTool(createFindTool(cwd, undefined), guard, "read", cwd, wrapOpts),
        wrapPathTool(createLsTool(cwd), guard, "read", cwd, wrapOpts),
      ],
      customTools,
    };
  }

  // ── macOS / Linux: PathGuard + OS 沙盒 ──
  let sandboxedBashTool = normalBashTool;
  if (checkAvailability(platform)) {
    const sandboxExec = platform === "seatbelt"
      ? (command, execCwd, execOpts) => createSeatbeltExec(
          makePolicy(),
          { getSandboxNetworkEnabled: resolveSandboxNetworkEnabled },
        )(command, execCwd, execOpts)
      : (command, execCwd, execOpts) => createBwrapExec(
          makePolicy(),
          { getExternalReadPaths, getSandboxNetworkEnabled: resolveSandboxNetworkEnabled },
        )(command, execCwd, execOpts);
    sandboxedBashTool = createBashTool(cwd, { operations: { exec: sandboxExec as any } });
  } else if (platform === "bwrap") {
    sandboxedBashTool = {
      ...normalBashTool,
      execute: async () => ({
        content: [{ type: "text" as const, text: t("sandbox.osRequired", { platform }) }],
      }) as any,
    };
  }

  return {
    tools: [
      wrapPathTool(readTool, guard, "read", cwd, wrapOpts),
      wrapPathTool(writeTool, guard, "write", cwd, wrapOpts),
      wrapPathTool(editTool, guard, "write", cwd, wrapOpts),
      wrapBashTool(sandboxedBashTool, guard, cwd, bashWrapOpts),
      wrapPathTool(createGrepTool(cwd, undefined), guard, "read", cwd, wrapOpts),
      wrapPathTool(createFindTool(cwd, undefined), guard, "read", cwd, wrapOpts),
      wrapPathTool(createLsTool(cwd), guard, "read", cwd, wrapOpts),
    ],
    customTools,
  };
}

function resolveToolPath(rawPath, cwd) {
  if (!rawPath) return null;
  if (process.platform === "win32") {
    return normalizeWin32ShellPath(rawPath, cwd, { allowRelative: true });
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function fileTouchToolPathParam(params) {
  if (!params || typeof params !== "object") return null;
  if (typeof params.path === "string" && params.path) return params.path;
  if (typeof params.file_path === "string" && params.file_path) return params.file_path;
  if (typeof params.filePath === "string" && params.filePath) return params.filePath;
  return null;
}

function normalizeFileTouchToolParams(params) {
  const rawPath = fileTouchToolPathParam(params);
  if (!rawPath || params?.path === rawPath) return params;
  return { ...params, path: rawPath };
}

function wrapFileTouchTool(tool, cwd, {
  origin,
  operationForPath,
  getSessionPath,
  recordFileOperation,
}: { origin?: any; operationForPath?: any; getSessionPath?: any; recordFileOperation?: any } = {}) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const normalizedParams = normalizeFileTouchToolParams(params);
      const absolutePath = resolveToolPath(fileTouchToolPathParam(normalizedParams), cwd);
      const operation = absolutePath ? operationForPath?.(absolutePath) : null;
      const result = await tool.execute(toolCallId, normalizedParams, ...rest);
      const sessionPath = getSessionPath?.() || null;
      if (!absolutePath || !sessionPath || typeof recordFileOperation !== "function") {
        return result;
      }
      if (!fs.existsSync(absolutePath)) return result;
      try {
        const sessionFile = serializeSessionFile(recordFileOperation({
          sessionPath,
          filePath: absolutePath,
          label: path.basename(absolutePath),
          origin,
          operation,
        }));
        return appendSessionFileDetails(result, sessionFile);
      } catch (err) {
        return appendRegistrationWarning(result, err);
      }
    },
  };
}

function addSessionFileParameters(parameters) {
  if (!parameters || typeof parameters !== "object" || !parameters.properties) return parameters;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((name) => name !== "path")
    : parameters.required;
  return {
    ...parameters,
    ...(required ? { required } : {}),
    properties: {
      ...parameters.properties,
      fileId: {
        type: "string",
        description: "SessionFile id from current_status/session_files or attached [SessionFile] context. Use this instead of path when fileId is available; it is resolved before path.",
      },
      sessionPath: {
        type: "string",
        description: "Optional session JSONL path that owns fileId. Usually omit to use the current session.",
      },
    },
  };
}

function sessionFilePath(file) {
  if (!file || typeof file !== "object") return null;
  if (file.status === "expired") {
    throw new Error(`SessionFile expired: ${file.fileId || file.id || "unknown"}`);
  }
  const filePath = file.realPath || file.filePath || file.path || null;
  if (!filePath || !path.isAbsolute(filePath)) {
    throw new Error(`SessionFile has no readable absolute path: ${file.fileId || file.id || "unknown"}`);
  }
  return filePath;
}

function wrapSessionFilePathTool(tool, { getSessionPath, resolveSessionFile }: { getSessionPath?: any; resolveSessionFile?: any } = {}) {
  return {
    ...tool,
    parameters: addSessionFileParameters(tool.parameters),
    execute: async (toolCallId, params: Record<string, any> = {}, ...rest) => {
      const fileId = typeof params.fileId === "string" && params.fileId.trim() ? params.fileId.trim() : null;
      if (!fileId) return tool.execute(toolCallId, params, ...rest);
      if (typeof resolveSessionFile !== "function") {
        return {
          content: [{ type: "text", text: `SessionFile resolver unavailable for fileId: ${fileId}` }],
        };
      }
      const lookupSessionPath = typeof params.sessionPath === "string" && params.sessionPath
        ? params.sessionPath
        : getSessionPath?.() || null;
      try {
        const file = resolveSessionFile(fileId, { sessionPath: lookupSessionPath });
        if (!file) {
          return { content: [{ type: "text", text: `SessionFile not found: ${fileId}` }] };
        }
        const resolvedPath = sessionFilePath(file);
        return tool.execute(toolCallId, { ...params, path: resolvedPath }, ...rest);
      } catch (err) {
        return {
          content: [{ type: "text", text: err?.message || String(err) }],
        };
      }
    },
  };
}

function appendSessionFileDetails(result, sessionFile) {
  if (!sessionFile) return result;
  return {
    ...(result || {}),
    details: {
      ...(result?.details || {}),
      sessionFile,
    },
  };
}

function appendRegistrationWarning(result, err) {
  const message = `Session file registration failed: ${err?.message || String(err)}`;
  const content = Array.isArray(result?.content) ? [...result.content] : [];
  return {
    ...(result || {}),
    content: [...content, { type: "text", text: message }],
  };
}
