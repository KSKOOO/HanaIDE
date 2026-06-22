export const SESSION_PERMISSION_MODES = Object.freeze({
  AUTO: "auto",
  OPERATE: "operate",
  ASK: "ask",
  READ_ONLY: "read_only",
});

export const DEFAULT_SESSION_PERMISSION_MODE = SESSION_PERMISSION_MODES.ASK;
const BRIDGE_PERMISSION_MODE_VALUES = new Set([
  SESSION_PERMISSION_MODES.AUTO,
  SESSION_PERMISSION_MODES.OPERATE,
  SESSION_PERMISSION_MODES.READ_ONLY,
]);
const AUTOMATION_PERMISSION_MODE_VALUES = BRIDGE_PERMISSION_MODE_VALUES;

const INFORMATION_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  "current_status",
  "search_memory",
  "recall_experience",
]);

const SIDE_EFFECT_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "computer",
  "automation",
  "cron",
  "dm",
  "channel",
  "install_skill",
  "update_settings",
  "todo_write",
  "stage_files",
  "present_files",
  "subagent",
  "notify",
  "record_experience",
  "pin_memory",
  "unpin_memory",
]);

// subagent 上下文固定边界（与 permission mode 无关）：哪怕 operate 也拦。收口在拦截层而非剥离——
// subagent 工具对模型仍可见，调用时被拦（Codex 式甲），保证缓存前缀统一。未来加禁用工具加到这里。
// 范畴：① 防自递归与间接扇出；② 长期记忆（subagent 不碰）；③ agent 一生/对外副作用。
// 不含 computer（有独立全局开关兜底）、search_memory/recall_experience（只读记忆，允许查）。
const SUBAGENT_BLOCKED_TOOLS = new Set([
  // ① 扇出
  "subagent",          // 防自递归
  "workflow",          // 间接扇出
  // ② 长期记忆（与「subagent 不带长期记忆」原则一致：可读不可写）
  "pin_memory",
  "unpin_memory",
  "record_experience",
  // ③ agent 生命周期 / 对外副作用
  "automation",
  "cron",
  "channel",
  "dm",
  "notify",
  "install_skill",
  "update_settings",
  "session_folders",
]);

const BROWSER_READ_ACTIONS = new Set([
  "start",
  "navigate",
  "snapshot",
  "screenshot",
  "scroll",
  "wait",
  "show",
  "stop",
]);

const TERMINAL_READ_ACTIONS = new Set([
  "read",
  "list",
]);

const FILE_READ_ACTIONS = new Set([
  "stat",
]);

export function normalizeSessionPermissionMode(raw) {
  if (typeof raw === "string") return normalizeSessionPermissionMode({ permissionMode: raw });
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.AUTO) return SESSION_PERMISSION_MODES.AUTO;
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.OPERATE) return SESSION_PERMISSION_MODES.OPERATE;
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.ASK) return SESSION_PERMISSION_MODES.ASK;
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.READ_ONLY) return SESSION_PERMISSION_MODES.READ_ONLY;
  if (raw?.accessMode === "operate") return SESSION_PERMISSION_MODES.OPERATE;
  if (raw?.accessMode === "read_only") return SESSION_PERMISSION_MODES.READ_ONLY;
  if (raw?.planMode === true) return SESSION_PERMISSION_MODES.READ_ONLY;
  return DEFAULT_SESSION_PERMISSION_MODE;
}

export function normalizeBridgePermissionMode(raw) {
  const source = typeof raw === "string" ? raw : raw?.permissionMode;
  if (BRIDGE_PERMISSION_MODE_VALUES.has(source)) return source;
  if (raw?.readOnly === true) return SESSION_PERMISSION_MODES.READ_ONLY;
  return SESSION_PERMISSION_MODES.AUTO;
}

export function normalizeAutomationPermissionMode(raw) {
  const source = typeof raw === "string" ? raw : raw?.permissionMode;
  if (AUTOMATION_PERMISSION_MODE_VALUES.has(source)) return source;
  return SESSION_PERMISSION_MODES.AUTO;
}

export function legacyAccessModeFromPermissionMode(mode) {
  return normalizeSessionPermissionMode(mode) === SESSION_PERMISSION_MODES.READ_ONLY ? "read_only" : "operate";
}

export function isReadOnlyPermissionMode(mode) {
  return normalizeSessionPermissionMode(mode) === SESSION_PERMISSION_MODES.READ_ONLY;
}

// 拦截分层（#1614）：deny 必须标明是哪一层拦的 + 怎么解锁，让模型/用户能自助走出去。
//   - subagent_blocklist：subagent 固定边界（任何档位都不可用）
//   - subagent_access：subagent 只读档（出路：access:"write" 重派 + 父会话可操作）
//   - conversation：conversation tool mode（出路：会话设置面板切到 write）
//   - session：普通会话只读档，如 plan 模式（出路：切换会话权限档）
function blocked(toolName, { code = "ACTION_BLOCKED_BY_READ_ONLY", message, layer = "session" }: { code?: string; message?: string; layer?: string } = {}) {
  return {
    action: "deny",
    code,
    message: message || `${toolName} is blocked in read-only mode.`,
    details: { toolName, layer },
  };
}

function blockedByReadOnly(toolName, context) {
  if (context?.isSubagent) {
    return blocked(toolName, {
      layer: "subagent_access",
      message: `${toolName} is blocked: this subagent runs in read-only mode. `
        + `For write access, re-dispatch the subagent with access:"write" — this requires the parent session to be in an operable (non read-only) mode; a subagent's permission can never exceed its parent session.`,
    });
  }
  if (context?.surface === "conversation") {
    return blocked(toolName, {
      layer: "conversation",
      message: `${toolName} is blocked: this conversation's tool permission is read-only. `
        + `The user can switch this conversation to write mode in its conversation settings panel.`,
    });
  }
  return blocked(toolName, {
    layer: "session",
    message: `${toolName} is blocked: this session is in read-only mode. `
      + `Switch the session permission mode out of read-only (e.g. leave plan mode) to use this tool.`,
  });
}

function prompt(toolName) {
  return {
    action: "prompt",
    kind: "tool_action_approval",
    details: { toolName },
  };
}

function review(toolName) {
  return {
    action: "review",
    kind: "tool_action_approval",
    details: { toolName },
  };
}

function classifyBrowserAction(mode, action, context) {
  if (BROWSER_READ_ACTIONS.has(action)) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly("browser", context);
  if (mode === SESSION_PERMISSION_MODES.AUTO) return review("browser");
  if (mode === SESSION_PERMISSION_MODES.ASK) return prompt("browser");
  return { action: "allow" };
}

function classifyTerminalAction(mode, action, context) {
  if (TERMINAL_READ_ACTIONS.has(action)) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly("terminal", context);
  if (mode === SESSION_PERMISSION_MODES.AUTO) return review("terminal");
  if (mode === SESSION_PERMISSION_MODES.ASK) return prompt("terminal");
  return { action: "allow" };
}

function classifySessionFoldersAction(mode, action, context) {
  if (action === "list") return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly("session_folders", context);
  return { action: "allow" };
}

function classifyFileAction(mode, action, context) {
  if (FILE_READ_ACTIONS.has(action)) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly("file", context);
  if (mode === SESSION_PERMISSION_MODES.AUTO) return review("file");
  if (mode === SESSION_PERMISSION_MODES.ASK) return prompt("file");
  return { action: "allow" };
}

export function classifySessionPermission({ mode, toolName, params, context }: { mode?: any; toolName?: any; params?: any; context?: any } = {}) {
  let normalized = normalizeSessionPermissionMode(mode);
  const name = typeof toolName === "string" ? toolName : "";
  if (!name) return { action: "allow" };
  // subagent 上下文固定边界（与 mode 无关，优先于其它判定）：防自递归 + 禁越权工具。
  if (context?.isSubagent && SUBAGENT_BLOCKED_TOOLS.has(name)) {
    return blocked(name, {
      code: "ACTION_BLOCKED_IN_SUBAGENT",
      layer: "subagent_blocklist",
      message: `${name} is not available inside a subagent. `
        + `This tool is always blocked in subagent context regardless of access level; perform this action from the parent session instead.`,
    });
  }
  // 硬不变量：subagent 没有需要人类确认的模式。后台任务无人交互确认，若走 prompt/review
  // 会挂在永不到来的确认上（直到超时）。ASK/AUTO 在 subagent 上下文一律坍缩为 operate，
  // 与 subagent-tool-policy 的继承映射一致。即便上游绕过收口直接给了 ask/auto，也绝不挂起。
  if (context?.isSubagent && (
    normalized === SESSION_PERMISSION_MODES.ASK
    || normalized === SESSION_PERMISSION_MODES.AUTO
  )) {
    normalized = SESSION_PERMISSION_MODES.OPERATE;
  }
  if (INFORMATION_TOOLS.has(name)) return { action: "allow" };
  if (name === "browser") return classifyBrowserAction(normalized, params?.action, context);
  if (name === "terminal") return classifyTerminalAction(normalized, params?.action, context);
  if (name === "session_folders") return classifySessionFoldersAction(normalized, params?.action, context);
  if (name === "file") return classifyFileAction(normalized, params?.action, context);
  if (normalized === SESSION_PERMISSION_MODES.OPERATE) return { action: "allow" };
  if (normalized === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly(name, context);
  if (normalized === SESSION_PERMISSION_MODES.AUTO) return review(name);
  if (SIDE_EFFECT_TOOLS.has(name)) return prompt(name);
  return prompt(name);
}
