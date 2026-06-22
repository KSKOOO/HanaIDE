import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const root = process.cwd();

function extractMacro(source, name) {
  const match = source.match(new RegExp(`!macro ${name}(?:\\s|$)[\\s\\S]*?!macroend`));
  return match?.[0] || "";
}

describe("Windows NSIS installer contract", () => {
  it("does not let stale old-uninstaller failures abort a HanaIDE-owned overlay", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const macro = extractMacro(source, "customUnInstallCheck");

    expect(macro).toContain("hanakoPrepareOwnedOverlay");
    expect(macro).toContain("ClearErrors");
    expect(macro).not.toContain("$(uninstallFailed)");
    expect(macro).not.toContain("Quit");
  });

  it("bypasses the previous uninstaller during installer overlay upgrades", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const bypass = extractMacro(source, "hanakoBypassOldUninstallerForUpdate");
    const checkRunning = extractMacro(source, "customCheckAppRunning");

    expect(checkRunning).toContain("hanakoBypassOldUninstallerForUpdate");
    expect(bypass).toContain("${isUpdated}");
    expect(bypass).toContain("hanakoPrepareOwnedOverlay");
    expect(bypass).toContain('DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"');
  });

  it("cleans the replaceable bundled server tree before overlaying new files", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");

    expect(source).toContain('RMDir /r "$INSTDIR\\resources\\server"');
  });

  it("removes legacy unpacked Electron app directories before overlaying new files", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const macro = extractMacro(source, "hanakoRemoveOwnedInstallTrees");

    expect(macro).toContain('RMDir /r "$INSTDIR\\resources\\app"');
  });

  it("cleans processes by install-directory ownership, not only fixed image names", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const macro = extractMacro(source, "hanakoStopInstallDirProcesses");
    const cleaner = extractMacro(source, "hanakoWriteInstallDirProcessCleaner");

    expect(macro).toContain("HANA_INSTALL_DIR");
    expect(macro).toContain("hanakoWriteInstallDirProcessCleaner");
    expect(cleaner).toContain("Get-CimInstance Win32_Process");
    expect(cleaner).toContain("CommandLine");
    expect(cleaner).toContain("Stop-Process");
  });

  it("escapes PowerShell variables written through NSIS FileWrite", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const cleaner = extractMacro(source, "hanakoWriteInstallDirProcessCleaner");
    const fileWrites = cleaner
      .split("\n")
      .filter((line) => line.includes("FileWrite"))
      .join("\n");

    expect(fileWrites).toContain("$$_.CommandLine");
    expect(fileWrites).toContain("$$installDir");
    expect(fileWrites).not.toMatch(/(^|[^$])\$(?:_|install|self|PID|false|value|full)/);
  });

  it("does not classify the running installer as a stale app process via the /D argument", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const cleaner = extractMacro(source, "hanakoWriteInstallDirProcessCleaner");
    const finder = extractMacro(source, "hanakoWriteInstallDirProcessFinder");

    for (const macro of [cleaner, finder]) {
      expect(macro).toContain("$$installerPid");
      expect(macro).toContain("$$_.ProcessId -ne $$installerPid");
      expect(macro).not.toContain("return $$value.IndexOf($$installFull");
    }
  });

  it("future uninstallers remove HanaIDE-owned install surfaces without atomic old-install staging", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const macro = extractMacro(source, "customRemoveFiles");

    expect(macro).toContain("hanakoRemoveOwnedInstallTrees");
    expect(macro).toContain('Delete "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"');
    expect(macro).not.toContain("old-install");
    expect(macro).not.toContain("un.atomicRMDir");
  });

  it("removes legacy Hanako-branded install entries without blind global shortcut deletion", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const macro = extractMacro(source, "hanakoRemoveOwnedInstallTrees");
    const overlay = extractMacro(source, "hanakoPrepareOwnedOverlay");
    const shortcutCleaner = extractMacro(source, "hanakoWriteLegacyShortcutCleaner");

    expect(macro).toContain('Delete "$INSTDIR\\Hanako.exe"');
    expect(macro).toContain('Delete "$INSTDIR\\HanaAgent.exe"');
    expect(macro).toContain('Delete "$INSTDIR\\Uninstall Hanako.exe"');
    expect(macro).toContain('Delete "$INSTDIR\\hanako-install-diagnostics.log"');
    expect(macro).not.toContain('Delete "$DESKTOP\\Hanako.lnk"');
    expect(macro).not.toContain('Delete "$SMPROGRAMS\\Hanako.lnk"');
    expect(macro).not.toContain('RMDir /r "$SMPROGRAMS\\Hanako"');
    expect(macro).toContain("hanakoRemoveLegacyGlobalShortcuts");
    expect(shortcutCleaner).toContain("WScript.Shell");
    expect(shortcutCleaner).toContain("CreateShortcut");
    expect(shortcutCleaner).toContain("Test-HanaInstallPath $$shortcut.TargetPath");
    expect(shortcutCleaner).toContain("Test-HanaInstallPath $$shortcut.WorkingDirectory");
    expect(shortcutCleaner).not.toContain("Remove-Item -LiteralPath $$legacyDir -Recurse");
    expect(macro).not.toContain('Delete "$INSTDIR\\*.exe"');
    expect(overlay).toContain("hanakoRemoveOwnedInstallTrees");
  });

  it("overrides app-running detection to close HanaIDE, legacy HanaAgent/Hanako, and the bundled server explicitly", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const macro = extractMacro(source, "customCheckAppRunning");

    expect(macro).toContain("HanaIDE.exe");
    expect(macro).toContain("HanaAgent.exe");
    expect(macro).toContain("Hanako.exe");
    expect(macro).toContain("hana-server.exe");
    expect(macro).toContain("appCannotBeClosed");
    expect(macro).toContain("MB_RETRYCANCEL");
    expect(macro).toContain("DetailPrint");
    expect(macro).not.toContain("StartsWith('$INSTDIR'");
  });

  it("keeps silent overlay upgrades eligible to relaunch after install", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

    expect(pkg.build.nsis.runAfterFinish).not.toBe(false);
  });

  it("keeps Windows installs on a stable managed install root", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

    expect(pkg.build.nsis.allowToChangeInstallationDirectory).toBe(false);
  });

  it("pins the Windows executable name to the current product identity", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

    expect(pkg.build.win.executableName).toBe("HanaIDE");
    expect(pkg.build.nsis.shortcutName).toBe("HanaIDE");
  });

  it("runs an install surface self-check and writes diagnostics before aborting", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const customInstall = extractMacro(source, "customInstall");
    const verify = extractMacro(source, "hanakoVerifyInstallSurface");

    expect(customInstall).toContain("hanakoVerifyInstallSurface");
    expect(verify).toContain('hanaagent-install-diagnostics.log');
    expect(verify).toContain('$INSTDIR\\${APP_EXECUTABLE_FILENAME}');
    expect(verify).toContain('$INSTDIR\\resources\\app.asar');
    expect(verify).toContain('$INSTDIR\\resources\\server\\hana-server.exe');
    expect(verify).toContain('$INSTDIR\\resources\\server\\bootstrap.js');
    expect(verify).toContain('$INSTDIR\\resources\\server\\bundle\\index.js');
    expect(verify).toContain('$INSTDIR\\resources\\server\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node');
    expect(verify).toContain('$INSTDIR\\resources\\git\\cmd\\git.exe');
    expect(verify).toContain('MessageBox MB_OK|MB_ICONSTOP');
    expect(verify).toContain('Quit');
  });

  it("records installer phase timing without changing install success conditions", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const timing = extractMacro(source, "hanakoInstallTimingMark");
    const persist = extractMacro(source, "hanakoPersistInstallTiming");
    const customInit = extractMacro(source, "customInit");
    const customCheck = extractMacro(source, "customCheckAppRunning");
    const customInstall = extractMacro(source, "customInstall");
    const stopProcesses = extractMacro(source, "hanakoStopInstallDirProcesses");
    const removeTrees = extractMacro(source, "hanakoRemoveOwnedInstallTrees");
    const verify = extractMacro(source, "hanakoVerifyInstallSurface");

    expect(timing).toContain("GetTickCount");
    expect(timing).toContain("$PLUGINSDIR\\hanaagent-install-timing.log");
    expect(timing).toContain("phase=${_PHASE}");
    expect(timing).not.toContain("Quit");
    expect(persist).toContain("$INSTDIR\\hanaagent-install-timing.log");
    expect(customInit).toContain('hanakoInstallTimingMark "customInit" "start"');
    expect(customInit).toContain('hanakoInstallTimingMark "customInit" "end"');
    expect(customCheck).toContain('hanakoInstallTimingMark "customCheckAppRunning" "start"');
    expect(customCheck).toContain('hanakoInstallTimingMark "customCheckAppRunning" "end"');
    expect(customInstall).toContain('hanakoInstallTimingMark "customInstall" "start"');
    expect(customInstall).toContain('hanakoInstallTimingMark "customInstall" "end"');
    expect(stopProcesses).toContain('hanakoInstallTimingMark "stopInstallDirProcesses" "start"');
    expect(stopProcesses).toContain('hanakoInstallTimingMark "stopInstallDirProcesses" "end"');
    expect(removeTrees).toContain('hanakoInstallTimingMark "removeOwnedInstallTrees" "start"');
    expect(removeTrees).toContain('hanakoInstallTimingMark "removeOwnedInstallTrees" "end"');
    expect(verify).toContain("hanakoPersistInstallTiming");
  });
});
