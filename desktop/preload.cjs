/**
 * Hana Desktop — Preload 桥接
 *
 * 业务通信走 HTTP/WS 到 server。
 * IPC 仅用于：窗口管理、系统对话框、跨窗口消息转发。
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");
// ⚠️ 这是 preload 的"源文件"，不是 Electron 实际加载的。
// Vite (vite.config.preload.js) 会把这个文件和其依赖 bundle 成
// desktop/preload.bundle.cjs —— main.cjs 里 BrowserWindow 的
// webPreferences.preload 指向 bundle 产物。
// 可以放心 require 任何相对路径 / node_modules，bundler 会内联。
const { pathToFileUrl } = require("./src/shared/path-to-file-url.cjs");
const {
  HANA_IPC_CHANNELS,
  HANA_IPC_EVENTS,
  eventChannel,
  invokeChannel,
  sendChannel,
} = require("./src/shared/platform-contract.cjs");
const themeRegistry = require("./src/shared/theme-registry.cjs");

function resolveTheme() {
  const saved = localStorage.getItem(themeRegistry.STORAGE_KEY);
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return themeRegistry.resolveSavedTheme(saved, isDark).concrete;
}

contextBridge.exposeInMainWorld("hana", {
  getServerPort: () => ipcRenderer.invoke(invokeChannel("getServerPort")),
  getServerToken: () => ipcRenderer.invoke(invokeChannel("getServerToken")),
  runEditCommand: (command) => ipcRenderer.invoke(invokeChannel("runEditCommand"), command),
  getAppVersion: () => ipcRenderer.invoke(HANA_IPC_CHANNELS.getAppVersion),
  getAutoLaunchStatus: () => ipcRenderer.invoke(invokeChannel("getAutoLaunchStatus")),
  setAutoLaunchEnabled: (enabled) => ipcRenderer.invoke(invokeChannel("setAutoLaunchEnabled"), enabled),
  getKeepAwakeStatus: () => ipcRenderer.invoke(invokeChannel("getKeepAwakeStatus")),
  setKeepAwakeEnabled: (enabled) => ipcRenderer.invoke(invokeChannel("setKeepAwakeEnabled"), enabled),
  quickChatReloadShortcut: () => ipcRenderer.invoke(invokeChannel("quickChatReloadShortcut")),
  quickChatShortcutStatus: () => ipcRenderer.invoke(invokeChannel("quickChatShortcutStatus")),
  quickChatShow: () => ipcRenderer.invoke(invokeChannel("quickChatShow")),
  quickChatHide: () => ipcRenderer.invoke(invokeChannel("quickChatHide")),
  quickChatResize: (mode) => ipcRenderer.invoke(invokeChannel("quickChatResize"), mode),
  quickChatOpenSession: (sessionPath) => ipcRenderer.invoke(invokeChannel("quickChatOpenSession"), sessionPath),
  onQuickChatOpenSession: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on(eventChannel("onQuickChatOpenSession"), handler);
    return () => ipcRenderer.removeListener(eventChannel("onQuickChatOpenSession"), handler);
  },
  onQuickChatShown: (cb) => {
    const handler = () => cb();
    ipcRenderer.on(eventChannel("onQuickChatShown"), handler);
    return () => ipcRenderer.removeListener(eventChannel("onQuickChatShown"), handler);
  },
  appReady: () => ipcRenderer.invoke(invokeChannel("appReady")),
  syncWindowTheme: (theme) => ipcRenderer.send(sendChannel("syncWindowTheme"), theme),
  selectFolder: () => ipcRenderer.invoke(invokeChannel("selectFolder")),
  selectFiles: () => ipcRenderer.invoke(invokeChannel("selectFiles")),
  selectSkill: () => ipcRenderer.invoke(invokeChannel("selectSkill")),
  selectPlugin: () => ipcRenderer.invoke(invokeChannel("selectPlugin")),
  openFolder: (path) => ipcRenderer.invoke(invokeChannel("openFolder"), path),
  openFile: (path) => ipcRenderer.invoke(invokeChannel("openFile"), path),
  openExternal: (url) => ipcRenderer.invoke(invokeChannel("openExternal"), url),
  showInFinder: (path) => ipcRenderer.invoke(invokeChannel("showInFinder"), path),
  trashItem: (path) => ipcRenderer.invoke(invokeChannel("trashItem"), path),
  readFile: (path) => ipcRenderer.invoke(invokeChannel("readFile"), path),
  writeFile: (filePath, content) => ipcRenderer.invoke(invokeChannel("writeFile"), filePath, content),
  readFileSnapshot: (path) => ipcRenderer.invoke(invokeChannel("readFileSnapshot"), path),
  writeFileIfUnchanged: (filePath, content, expectedVersion) => ipcRenderer.invoke(invokeChannel("writeFileIfUnchanged"), filePath, content, expectedVersion),
  writeFileBinary: (filePath, base64Data) => ipcRenderer.invoke(invokeChannel("writeFileBinary"), filePath, base64Data),
  copyFile: (sourcePath, destinationPath) => ipcRenderer.invoke(invokeChannel("copyFile"), sourcePath, destinationPath),
  screenshotRender: (payload) => ipcRenderer.invoke(invokeChannel("screenshotRender"), payload),
  watchFile: (filePath) => ipcRenderer.invoke(invokeChannel("watchFile"), filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke(invokeChannel("unwatchFile"), filePath),
  onFileChanged: (cb) => ipcRenderer.on(eventChannel("onFileChanged"), (_, filePath) => cb(filePath)),
  watchWorkspace: (rootPath) => ipcRenderer.invoke(invokeChannel("watchWorkspace"), rootPath),
  unwatchWorkspace: (rootPath) => ipcRenderer.invoke(invokeChannel("unwatchWorkspace"), rootPath),
  onWorkspaceChanged: (cb) => ipcRenderer.on(eventChannel("onWorkspaceChanged"), (_, payload) => cb(payload)),
  readFileBase64: (path) => ipcRenderer.invoke(invokeChannel("readFileBase64"), path),
  // 本地路径 → file:// URL（同步，纯字符串转换，无 IPC）。逻辑见 src/shared/path-to-file-url.cjs
  getFileUrl: (filePath) => pathToFileUrl(filePath),
  readDocxHtml: (path) => ipcRenderer.invoke(invokeChannel("readDocxHtml"), path),
  readXlsxHtml: (path) => ipcRenderer.invoke(invokeChannel("readXlsxHtml"), path),
  getFilePath: (file) => webUtils.getPathForFile(file),
  getAvatarPath: (role) => ipcRenderer.invoke(invokeChannel("getAvatarPath"), role),
  getSplashInfo: () => ipcRenderer.invoke(invokeChannel("getSplashInfo")),
  reloadMainWindow: () => ipcRenderer.invoke(invokeChannel("reloadMainWindow")),
  // Onboarding
  onboardingComplete: () => ipcRenderer.invoke(invokeChannel("onboardingComplete")),
  debugOpenOnboarding: () => ipcRenderer.invoke(invokeChannel("debugOpenOnboarding")),
  debugOpenOnboardingPreview: () => ipcRenderer.invoke(invokeChannel("debugOpenOnboardingPreview")),
  // Skill Viewer overlay（主进程 → 渲染进程）
  onShowSkillViewer: (cb) => ipcRenderer.on(eventChannel("onShowSkillViewer"), (_, data) => cb(data)),
  // 设置窗口
  openSettings: (tab) => ipcRenderer.invoke(invokeChannel("openSettings"), tab, resolveTheme()),
  settingsChanged: (type, data) => ipcRenderer.send(sendChannel("settingsChanged"), type, data),
  onSettingsChanged: (cb) => {
    const handler = (_, type, data) => cb(type, data);
    ipcRenderer.on(eventChannel("onSettingsChanged"), handler);
    return () => ipcRenderer.removeListener(eventChannel("onSettingsChanged"), handler);
  },
  onOpenSettingsModal: (cb) => {
    const handler = (_, tab) => cb(tab);
    ipcRenderer.on(eventChannel("onOpenSettingsModal"), handler);
    return () => ipcRenderer.removeListener(eventChannel("onOpenSettingsModal"), handler);
  },
  onSwitchTab: (cb) => {
    const handler = (_, tab) => cb(tab);
    ipcRenderer.on(eventChannel("onSwitchTab"), handler);
    return () => ipcRenderer.removeListener(eventChannel("onSwitchTab"), handler);
  },
  onServerRestarted: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on(eventChannel("onServerRestarted"), handler);
    return () => ipcRenderer.removeListener(eventChannel("onServerRestarted"), handler);
  },
  // 浏览器查看器窗口
  openBrowserViewer: (url) => ipcRenderer.invoke(invokeChannel("openBrowserViewer"), resolveTheme(), url),
  getVscodeWorkbenchStatus: () => ipcRenderer.invoke(invokeChannel("getVscodeWorkbenchStatus")),
  openVscodeWorkbench: () => ipcRenderer.invoke(invokeChannel("openVscodeWorkbench")),
  closeVscodeWorkbench: () => ipcRenderer.invoke(invokeChannel("closeVscodeWorkbench")),
  reloadVscodeWorkbench: () => ipcRenderer.invoke(invokeChannel("reloadVscodeWorkbench")),
  setVscodeWorkbenchBounds: (bounds) => ipcRenderer.invoke(invokeChannel("setVscodeWorkbenchBounds"), bounds),
  onVscodeWorkbenchStatus: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on(eventChannel("onVscodeWorkbenchStatus"), handler);
    return () => ipcRenderer.removeListener(eventChannel("onVscodeWorkbenchStatus"), handler);
  },
  onBrowserUpdate: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on(eventChannel("onBrowserUpdate"), handler);
    return () => ipcRenderer.removeListener(eventChannel("onBrowserUpdate"), handler);
  },
  browserGoBack: () => ipcRenderer.invoke(invokeChannel("browserGoBack")),
  browserGoForward: () => ipcRenderer.invoke(invokeChannel("browserGoForward")),
  browserReload: () => ipcRenderer.invoke(invokeChannel("browserReload")),
  browserNewTab: () => ipcRenderer.invoke(invokeChannel("browserNewTab")),
  browserSwitchTab: (tabId) => ipcRenderer.invoke(invokeChannel("browserSwitchTab"), tabId),
  browserCloseTab: (tabId) => ipcRenderer.invoke(invokeChannel("browserCloseTab"), tabId),
  closeBrowserViewer: () => ipcRenderer.invoke(invokeChannel("closeBrowserViewer")),
  browserEmergencyStop: () => ipcRenderer.invoke(invokeChannel("browserEmergencyStop")),
  // 派生 Viewer 窗口（只读文件副本，多实例）
  spawnViewer: (data) => ipcRenderer.invoke(invokeChannel("spawnViewer"), data),
  onViewerLoad: (cb) => ipcRenderer.on(eventChannel("onViewerLoad"), (_, data) => cb(data)),
  viewerClose: () => ipcRenderer.invoke(invokeChannel("viewerClose")),
  onViewerClosed: (cb) => ipcRenderer.on(eventChannel("onViewerClosed"), (_, windowId) => cb(windowId)),
  // Skill 预览窗口
  openSkillViewer: (data) => ipcRenderer.invoke(invokeChannel("openSkillViewer"), data),
  listSkillFiles: (baseDir) => ipcRenderer.invoke(invokeChannel("listSkillFiles"), baseDir),
  readSkillFile: (filePath) => ipcRenderer.invoke(invokeChannel("readSkillFile"), filePath),
  onSkillViewerLoad: (cb) => ipcRenderer.on(eventChannel("onSkillViewerLoad"), (_, data) => cb(data)),
  closeSkillViewer: () => ipcRenderer.invoke(invokeChannel("closeSkillViewer")),
  // 原生拖拽（书桌文件拖到 Finder / 聊天区）
  startDrag: (filePaths) => ipcRenderer.send(sendChannel("startDrag"), filePaths),
  // 系统通知（agentId 标识触发的助手，主进程据此设头像 icon；缺失则无 icon）
  showNotification: (title, body, agentId, options) => ipcRenderer.invoke(invokeChannel("showNotification"), title, body, agentId ?? null, options || null),
  // 窗口控制（Windows/Linux 自绘标题栏）
  getPlatform: () => ipcRenderer.invoke(invokeChannel("getPlatform")),
  windowMinimize: () => ipcRenderer.invoke(invokeChannel("windowMinimize")),
  windowMaximize: () => ipcRenderer.invoke(invokeChannel("windowMaximize")),
  windowClose: () => ipcRenderer.invoke(invokeChannel("windowClose")),
  windowIsMaximized: () => ipcRenderer.invoke(invokeChannel("windowIsMaximized")),
  onMaximizeChange: (cb) => {
    ipcRenderer.on(HANA_IPC_EVENTS.windowMaximized, () => cb(true));
    ipcRenderer.on(HANA_IPC_EVENTS.windowUnmaximized, () => cb(false));
  },
});
