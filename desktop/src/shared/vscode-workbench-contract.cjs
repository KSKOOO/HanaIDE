const VSCODE_WORKBENCH_STATUS = Object.freeze({
  disabled: "disabled",
  unavailable: "unavailable",
  ready: "ready",
  starting: "starting",
  running: "running",
  failed: "failed",
});

const VSCODE_WORKBENCH_DEFAULTS = Object.freeze({
  enabled: false,
  galleryEnabled: true,
  extensionAutoUpdate: false,
  appAutoUpdate: false,
  fallbackToHanaOnFailure: true,
});

const VSCODE_WORKBENCH_IPC_CHANNELS = Object.freeze({
  getStatus: "vscode-workbench-get-status",
  open: "vscode-workbench-open",
  close: "vscode-workbench-close",
  reload: "vscode-workbench-reload",
  setBounds: "vscode-workbench-set-bounds",
});

const VSCODE_WORKBENCH_IPC_EVENTS = Object.freeze({
  status: "vscode-workbench-status",
});

function defaultVscodeWorkbenchDiagnostics(overrides = {}) {
  return {
    status: VSCODE_WORKBENCH_STATUS.disabled,
    enabled: VSCODE_WORKBENCH_DEFAULTS.enabled,
    runtimePath: null,
    runtimeExists: false,
    userDataPath: null,
    extensionsDir: null,
    logsDir: null,
    galleryEnabled: VSCODE_WORKBENCH_DEFAULTS.galleryEnabled,
    galleryServiceUrlHost: null,
    extensionHostKind: "node-workspace",
    extensionAutoUpdate: VSCODE_WORKBENCH_DEFAULTS.extensionAutoUpdate,
    appAutoUpdate: VSCODE_WORKBENCH_DEFAULTS.appAutoUpdate,
    fallbackToHanaOnFailure: VSCODE_WORKBENCH_DEFAULTS.fallbackToHanaOnFailure,
    message: "VSCode workbench is disabled until explicitly opened.",
    lastError: null,
    ...overrides,
  };
}

module.exports = {
  VSCODE_WORKBENCH_STATUS,
  VSCODE_WORKBENCH_DEFAULTS,
  VSCODE_WORKBENCH_IPC_CHANNELS,
  VSCODE_WORKBENCH_IPC_EVENTS,
  defaultVscodeWorkbenchDiagnostics,
};
