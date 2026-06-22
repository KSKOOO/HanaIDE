/**
 * tool-session.js — 从 tool execute 的 ctx 中提取 sessionPath
 *
 * Pi SDK 调用 tool.execute(toolCallId, params, signal?, onUpdate?, ctx?) 时，
 * ctx.sessionManager.getSessionFile() 返回当前执行 session 的文件路径。
 * 所有工具应通过此函数获取 sessionPath，不再依赖焦点回调。
 */

/**
 * @param {object} [ctx] - Pi SDK tool execute 的第 5 个参数
 * @returns {string|null}
 */
export function getToolSessionPath(ctx) {
  return ctx?.sessionManager?.getSessionFile?.() ?? null;
}

function isAbortSignalLike(value) {
  return value
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function";
}

/**
 * Pi SDK 当前调用约定是 execute(toolCallId, params, signal, onUpdate, ctx)。
 * Hana 内部少量直接调用仍传 execute(toolCallId, params, runtimeCtx)。
 * 这里把两种入口统一成业务 ctx，避免 wrapper 把 AbortSignal 当成 runtimeCtx。
 *
 * @param {object|null|undefined} signalOrRuntimeCtx - 第 3 个 execute 参数
 * @param {object|null|undefined} piCtx - 第 5 个 execute 参数
 * @returns {{ ctx: object, hasExplicitCtx: boolean }}
 */
export function normalizeToolRuntimeContext(signalOrRuntimeCtx, piCtx) {
  if (piCtx && typeof piCtx === "object") {
    return { ctx: piCtx, hasExplicitCtx: true };
  }
  if (
    signalOrRuntimeCtx
    && typeof signalOrRuntimeCtx === "object"
    && !isAbortSignalLike(signalOrRuntimeCtx)
  ) {
    return { ctx: signalOrRuntimeCtx, hasExplicitCtx: true };
  }
  return { ctx: {}, hasExplicitCtx: false };
}

/**
 * @param {object} [ctx] - Pi SDK tool execute 的第 5 个参数
 * @returns {string|null}
 */
export function getToolSessionCwd(ctx) {
  return ctx?.sessionManager?.getCwd?.() ?? null;
}
