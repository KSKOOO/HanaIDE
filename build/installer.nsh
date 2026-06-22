; installer.nsh - NSIS custom hooks for HanaIDE installer
;
; Owns the Windows overlay boundary for HanaIDE installs. The installer may
; replace HanaIDE-owned program files, while user/runtime state stays outside
; $INSTDIR.

; Disable CRC integrity check. electron-builder's post-compilation PE editing
; (signtool + rcedit) corrupts the NSIS CRC when no signing cert is configured,
; causing "Installer integrity check has failed" on Windows.
CRCCheck off

!include LogicLib.nsh

!macro hanakoInstallTimingMark _PHASE _EVENT
  Push $0
  Push $1
  InitPluginsDir
  System::Call 'kernel32::GetTickCount() i.r0'
  FileOpen $1 "$PLUGINSDIR\hanaagent-install-timing.log" a
  ${IfNot} ${Errors}
    FileWrite $1 "tickMs=$0 phase=${_PHASE} event=${_EVENT}$\r$\n"
    FileClose $1
  ${EndIf}
  ClearErrors
  Pop $1
  Pop $0
!macroend

!macro hanakoPersistInstallTiming
  IfFileExists "$PLUGINSDIR\hanaagent-install-timing.log" 0 +2
    CopyFiles /SILENT "$PLUGINSDIR\hanaagent-install-timing.log" "$INSTDIR\hanaagent-install-timing.log"
!macroend

!macro hanakoFindProcess _NAME _RETURN
  nsExec::ExecToLog `"$SYSDIR\cmd.exe" /D /C tasklist /FI "IMAGENAME eq ${_NAME}" /FO CSV | "$SYSDIR\find.exe" "${_NAME}"`
  Pop ${_RETURN}
!macroend

!macro hanakoFindRunningProcesses _RETURN
  !insertmacro hanakoFindProcess HanaIDE.exe ${_RETURN}
  ${If} ${_RETURN} != 0
    !insertmacro hanakoFindProcess HanaAgent.exe ${_RETURN}
  ${EndIf}
  ${If} ${_RETURN} != 0
    !insertmacro hanakoFindProcess Hanako.exe ${_RETURN}
  ${EndIf}
  ${If} ${_RETURN} != 0
    !insertmacro hanakoFindProcess hana-server.exe ${_RETURN}
  ${EndIf}
!macroend

!macro hanakoKillProcess _NAME _FORCE
  Push $0
  Push $1
  ${If} ${_FORCE} == 1
    StrCpy $0 "/F"
  ${Else}
    StrCpy $0 ""
  ${EndIf}
  nsExec::ExecToLog `"$SYSDIR\cmd.exe" /D /C taskkill $0 /T /IM "${_NAME}"`
  Pop $1
  Pop $1
  Pop $0
!macroend

!macro hanakoKillRunningProcesses _FORCE
  !insertmacro hanakoKillProcess HanaIDE.exe ${_FORCE}
  !insertmacro hanakoKillProcess HanaAgent.exe ${_FORCE}
  !insertmacro hanakoKillProcess Hanako.exe ${_FORCE}
  !insertmacro hanakoKillProcess hana-server.exe ${_FORCE}
!macroend

!macro hanakoRequireInstallSurfaceFile _PATH _LABEL
  IfFileExists "${_PATH}" +2 0
    StrCpy $R2 "$R2$\r$\n- ${_LABEL}: ${_PATH}"
!macroend

!macro hanakoVerifyInstallSurface
  !insertmacro hanakoInstallTimingMark "installSurfaceSelfCheck" "start"
  Push $0
  Push $R2
  StrCpy $R2 ""
  !insertmacro hanakoRequireInstallSurfaceFile "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "HanaIDE.exe"
  !insertmacro hanakoRequireInstallSurfaceFile "$INSTDIR\resources\app.asar" "resources\app.asar"
  !insertmacro hanakoRequireInstallSurfaceFile "$INSTDIR\resources\server\hana-server.exe" "resources\server\hana-server.exe"
  !insertmacro hanakoRequireInstallSurfaceFile "$INSTDIR\resources\server\bootstrap.js" "resources\server\bootstrap.js"
  !insertmacro hanakoRequireInstallSurfaceFile "$INSTDIR\resources\server\bundle\index.js" "resources\server\bundle\index.js"
  !insertmacro hanakoRequireInstallSurfaceFile "$INSTDIR\resources\server\node_modules\better-sqlite3\build\Release\better_sqlite3.node" "better-sqlite3 native addon"
  !insertmacro hanakoRequireInstallSurfaceFile "$INSTDIR\resources\git\cmd\git.exe" "PortableGit git.exe"
  IfFileExists "$INSTDIR\resources\git\bin\bash.exe" +3 0
    IfFileExists "$INSTDIR\resources\git\usr\bin\bash.exe" +2 0
      StrCpy $R2 "$R2$\r$\n- PortableGit bash.exe: $INSTDIR\resources\git\bin\bash.exe or $INSTDIR\resources\git\usr\bin\bash.exe"

  ${If} $R2 != ""
    DetailPrint "HanaIDE install surface self-check failed."
    FileOpen $0 "$INSTDIR\hanaagent-install-diagnostics.log" w
    FileWrite $0 "HanaIDE install surface self-check failed.$\r$\n"
    FileWrite $0 "Install dir: $INSTDIR$\r$\n"
    FileWrite $0 "Missing or unreadable files:$R2$\r$\n"
    FileClose $0
    MessageBox MB_OK|MB_ICONSTOP "HanaIDE installation is incomplete. Missing or unreadable files:$R2$\r$\n$\r$\nDiagnostic file:$\r$\n$INSTDIR\hanaagent-install-diagnostics.log"
    SetErrorLevel 1
    !insertmacro hanakoInstallTimingMark "installSurfaceSelfCheck" "failed"
    !insertmacro hanakoPersistInstallTiming
    Pop $R2
    Pop $0
    Quit
  ${Else}
    Delete "$INSTDIR\hanaagent-install-diagnostics.log"
    Delete "$INSTDIR\hanako-install-diagnostics.log"
    DetailPrint "HanaIDE install surface self-check passed."
  ${EndIf}
  Pop $R2
  Pop $0
  !insertmacro hanakoInstallTimingMark "installSurfaceSelfCheck" "end"
!macroend

!macro hanakoWriteInstallDirProcessCleaner _SCRIPT
  Push $0
  FileOpen $0 "${_SCRIPT}" w
  FileWrite $0 `$$ErrorActionPreference = 'SilentlyContinue'$\r$\n`
  FileWrite $0 `$$installDir = [Environment]::GetEnvironmentVariable('HANA_INSTALL_DIR')$\r$\n`
  FileWrite $0 `if ([string]::IsNullOrWhiteSpace($$installDir)) { exit 0 }$\r$\n`
  FileWrite $0 `$$installFull = [System.IO.Path]::GetFullPath($$installDir).TrimEnd('\')$\r$\n`
  FileWrite $0 `$$installPrefix = $$installFull + '\'$\r$\n`
  FileWrite $0 `$$selfPid = $$PID$\r$\n`
  FileWrite $0 `$$self = Get-CimInstance Win32_Process -Filter "ProcessId = $$selfPid"$\r$\n`
  FileWrite $0 `$$installerPid = if ($$self) { $$self.ParentProcessId } else { -1 }$\r$\n`
  FileWrite $0 `function Test-HanaPath([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    $$full = [System.IO.Path]::GetFullPath($$value)$\r$\n`
  FileWrite $0 `    return $$full.Equals($$installFull, [StringComparison]::OrdinalIgnoreCase) -or $$full.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase)$\r$\n`
  FileWrite $0 `  } catch { return $$false }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `function Test-HanaCommand([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  $$quotedPrefix = '"' + $$installPrefix$\r$\n`
  FileWrite $0 `  return $$value.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase) -or $$value.IndexOf($$quotedPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $$value.IndexOf(' ' + $$installPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `Get-CimInstance Win32_Process | Where-Object {$\r$\n`
  FileWrite $0 `  $$_.ProcessId -ne $$selfPid -and $$_.ProcessId -ne $$installerPid -and ((Test-HanaPath $$_.ExecutablePath) -or (Test-HanaCommand $$_.CommandLine))$\r$\n`
  FileWrite $0 `} | ForEach-Object {$\r$\n`
  FileWrite $0 `  Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileClose $0
  Pop $0
!macroend

!macro hanakoWriteInstallDirProcessFinder _SCRIPT
  Push $0
  FileOpen $0 "${_SCRIPT}" w
  FileWrite $0 `$$ErrorActionPreference = 'SilentlyContinue'$\r$\n`
  FileWrite $0 `$$installDir = [Environment]::GetEnvironmentVariable('HANA_INSTALL_DIR')$\r$\n`
  FileWrite $0 `if ([string]::IsNullOrWhiteSpace($$installDir)) { exit 1 }$\r$\n`
  FileWrite $0 `$$installFull = [System.IO.Path]::GetFullPath($$installDir).TrimEnd('\')$\r$\n`
  FileWrite $0 `$$installPrefix = $$installFull + '\'$\r$\n`
  FileWrite $0 `$$selfPid = $$PID$\r$\n`
  FileWrite $0 `$$self = Get-CimInstance Win32_Process -Filter "ProcessId = $$selfPid"$\r$\n`
  FileWrite $0 `$$installerPid = if ($$self) { $$self.ParentProcessId } else { -1 }$\r$\n`
  FileWrite $0 `function Test-HanaPath([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    $$full = [System.IO.Path]::GetFullPath($$value)$\r$\n`
  FileWrite $0 `    return $$full.Equals($$installFull, [StringComparison]::OrdinalIgnoreCase) -or $$full.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase)$\r$\n`
  FileWrite $0 `  } catch { return $$false }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `function Test-HanaCommand([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  $$quotedPrefix = '"' + $$installPrefix$\r$\n`
  FileWrite $0 `  return $$value.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase) -or $$value.IndexOf($$quotedPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $$value.IndexOf(' ' + $$installPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$$matches = @(Get-CimInstance Win32_Process | Where-Object {$\r$\n`
  FileWrite $0 `  $$_.ProcessId -ne $$selfPid -and $$_.ProcessId -ne $$installerPid -and ((Test-HanaPath $$_.ExecutablePath) -or (Test-HanaCommand $$_.CommandLine))$\r$\n`
  FileWrite $0 `})$\r$\n`
  FileWrite $0 `$$matches | ForEach-Object {$\r$\n`
  FileWrite $0 `  Write-Output ("HanaIDE-owned process still running: {0} pid={1} path={2}" -f $$_.Name, $$_.ProcessId, $$_.ExecutablePath)$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `if ($$matches.Count -gt 0) { exit 0 } else { exit 1 }$\r$\n`
  FileClose $0
  Pop $0
!macroend

!macro hanakoStopInstallDirProcesses
  ; Stop every process launched from this install root. This catches renamed
  ; helper processes and stale child processes that do not use fixed image names.
  !insertmacro hanakoInstallTimingMark "stopInstallDirProcesses" "start"
  Push $0
  Push $1
  InitPluginsDir
  StrCpy $1 "$PLUGINSDIR\hanako-stop-install-dir.ps1"
  !insertmacro hanakoWriteInstallDirProcessCleaner "$1"
  System::Call 'kernel32::SetEnvironmentVariable(t "HANA_INSTALL_DIR", t "$INSTDIR") i.r0'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1"`
  Pop $0
  Pop $1
  Pop $0
  !insertmacro hanakoInstallTimingMark "stopInstallDirProcesses" "end"
!macroend

!macro hanakoFindInstallDirProcesses _RETURN
  !insertmacro hanakoInstallTimingMark "findInstallDirProcesses" "start"
  Push $0
  Push $1
  InitPluginsDir
  StrCpy $1 "$PLUGINSDIR\hanako-find-install-dir.ps1"
  !insertmacro hanakoWriteInstallDirProcessFinder "$1"
  System::Call 'kernel32::SetEnvironmentVariable(t "HANA_INSTALL_DIR", t "$INSTDIR") i.r0'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1"`
  Pop ${_RETURN}
  Pop $1
  Pop $0
  !insertmacro hanakoInstallTimingMark "findInstallDirProcesses" "end"
!macroend

!macro hanakoBypassOldUninstallerForUpdate
  ${If} ${isUpdated}
    DetailPrint "Update mode detected; bypassing the previous uninstaller and preparing a HanaIDE-owned overlay."
    !insertmacro hanakoPrepareOwnedOverlay
    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    !ifdef UNINSTALL_REGISTRY_KEY_2
      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"
    !endif
    ClearErrors
  ${EndIf}
!macroend

!macro customInstallMode
  ${If} ${isUpdated}
    ${If} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${Else}
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro hanakoInstallTimingMark "customInstall" "start"
  !insertmacro hanakoVerifyInstallSurface
  !insertmacro hanakoInstallTimingMark "customInstall" "end"
  !insertmacro hanakoPersistInstallTiming
  ${If} ${isUpdated}
  ${AndIf} ${isForceRun}
    !insertmacro hanakoInstallTimingMark "relaunch" "start"
    !insertmacro hanakoPersistInstallTiming
    HideWindow
    StrCpy $1 "--updated"
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  ${EndIf}
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif

  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customCheckAppRunning
  !insertmacro hanakoInstallTimingMark "customCheckAppRunning" "start"
  !insertmacro hanakoBypassOldUninstallerForUpdate
  !insertmacro hanakoStopInstallDirProcesses
  !insertmacro hanakoFindInstallDirProcesses $R0
  ${If} $R0 == 0
    DetailPrint "Detected HanaIDE-owned process in install directory; closing it before install."
    Sleep 500
    !insertmacro hanakoStopInstallDirProcesses

    StrCpy $R1 0
    hanako_check_install_dir_processes:
      !insertmacro hanakoFindInstallDirProcesses $R0
      ${If} $R0 == 0
        IntOp $R1 $R1 + 1
        DetailPrint "Waiting for HanaIDE-owned install-directory processes to close."
        ${If} $R1 > 2
          DetailPrint "HanaIDE-owned install-directory processes still running; asking user to retry."
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY hanako_retry_install_dir_close
          Quit
          hanako_retry_install_dir_close:
          StrCpy $R1 0
        ${EndIf}
        !insertmacro hanakoStopInstallDirProcesses
        Sleep 1000
        Goto hanako_check_install_dir_processes
      ${EndIf}
  ${EndIf}

  ${IfNot} ${isUpdated}
  !insertmacro hanakoFindRunningProcesses $R0
  ${If} $R0 == 0
    DetailPrint "Detected HanaIDE.exe, HanaAgent.exe, Hanako.exe, or hana-server.exe; closing them before install."
    !insertmacro hanakoKillRunningProcesses 0
    Sleep 500

    !insertmacro hanakoFindRunningProcesses $R0
    ${If} $R0 == 0
      !insertmacro hanakoKillRunningProcesses 1
      Sleep 1000
    ${EndIf}

    StrCpy $R1 0
    hanako_check_processes:
      !insertmacro hanakoFindRunningProcesses $R0
      ${If} $R0 == 0
        IntOp $R1 $R1 + 1
        DetailPrint "Waiting for HanaIDE.exe, HanaAgent.exe, Hanako.exe, or hana-server.exe to close."
        ${If} $R1 > 2
          DetailPrint "HanaIDE.exe, HanaAgent.exe, Hanako.exe, or hana-server.exe still running; asking user to retry."
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY hanako_retry_close
          Quit
          hanako_retry_close:
          StrCpy $R1 0
        ${EndIf}
        !insertmacro hanakoKillRunningProcesses 1
        Sleep 1000
        Goto hanako_check_processes
      ${EndIf}
  ${EndIf}
  ${EndIf}
  !insertmacro hanakoInstallTimingMark "customCheckAppRunning" "end"
!macroend

!macro hanakoCleanBundledServer
  ; resources\server is generated on every build. Remove it before copying
  ; new files so a failed stale uninstall cannot leave mixed bundle/deps/native files.
  IfFileExists "$INSTDIR\resources\server\*.*" 0 +3
    DetailPrint "Removing old bundled server resources"
    RMDir /r "$INSTDIR\resources\server"
!macroend

!macro hanakoWriteLegacyShortcutCleaner _SCRIPT
  Push $0
  FileOpen $0 "${_SCRIPT}" w
  FileWrite $0 `$$ErrorActionPreference = 'SilentlyContinue'$\r$\n`
  FileWrite $0 `$$installDir = [Environment]::GetEnvironmentVariable('HANA_INSTALL_DIR')$\r$\n`
  FileWrite $0 `if ([string]::IsNullOrWhiteSpace($$installDir)) { exit 0 }$\r$\n`
  FileWrite $0 `$$installFull = [System.IO.Path]::GetFullPath($$installDir).TrimEnd('\')$\r$\n`
  FileWrite $0 `$$installPrefix = $$installFull + '\'$\r$\n`
  FileWrite $0 `$$shell = New-Object -ComObject WScript.Shell$\r$\n`
  FileWrite $0 `function Test-HanaInstallPath([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    $$expanded = [Environment]::ExpandEnvironmentVariables($$value)$\r$\n`
  FileWrite $0 `    $$full = [System.IO.Path]::GetFullPath($$expanded)$\r$\n`
  FileWrite $0 `    return $$full.Equals($$installFull, [StringComparison]::OrdinalIgnoreCase) -or $$full.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase)$\r$\n`
  FileWrite $0 `  } catch { return $$false }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `function Remove-OwnedShortcut([string]$$path) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$path)) { return }$\r$\n`
  FileWrite $0 `  if (-not (Test-Path -LiteralPath $$path -PathType Leaf)) { return }$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    $$shortcut = $$shell.CreateShortcut($$path)$\r$\n`
  FileWrite $0 `    if ((Test-HanaInstallPath $$shortcut.TargetPath) -or (Test-HanaInstallPath $$shortcut.WorkingDirectory)) {$\r$\n`
  FileWrite $0 `      Remove-Item -LiteralPath $$path -Force$\r$\n`
  FileWrite $0 `    }$\r$\n`
  FileWrite $0 `  } catch {}$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `Remove-OwnedShortcut ([Environment]::GetEnvironmentVariable('HANA_DESKTOP_LEGACY_SHORTCUT'))$\r$\n`
  FileWrite $0 `Remove-OwnedShortcut ([Environment]::GetEnvironmentVariable('HANA_STARTMENU_LEGACY_SHORTCUT'))$\r$\n`
  FileWrite $0 `$$legacyDir = [Environment]::GetEnvironmentVariable('HANA_STARTMENU_LEGACY_DIR')$\r$\n`
  FileWrite $0 `if (-not [string]::IsNullOrWhiteSpace($$legacyDir) -and (Test-Path -LiteralPath $$legacyDir -PathType Container)) {$\r$\n`
  FileWrite $0 `  Get-ChildItem -LiteralPath $$legacyDir -Filter '*.lnk' | Where-Object { -not $$_.PSIsContainer } | ForEach-Object { Remove-OwnedShortcut $$_.FullName }$\r$\n`
  FileWrite $0 `  try { Remove-Item -LiteralPath $$legacyDir -Force -ErrorAction Stop } catch {}$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileClose $0
  Pop $0
!macroend

!macro hanakoRemoveLegacyGlobalShortcuts
  !insertmacro hanakoInstallTimingMark "legacyShortcutCleanup" "start"
  Push $0
  Push $1
  InitPluginsDir
  StrCpy $1 "$PLUGINSDIR\hanako-clean-legacy-shortcuts.ps1"
  !insertmacro hanakoWriteLegacyShortcutCleaner "$1"
  System::Call 'kernel32::SetEnvironmentVariable(t "HANA_INSTALL_DIR", t "$INSTDIR") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "HANA_DESKTOP_LEGACY_SHORTCUT", t "$DESKTOP\Hanako.lnk") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "HANA_STARTMENU_LEGACY_SHORTCUT", t "$SMPROGRAMS\Hanako.lnk") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "HANA_STARTMENU_LEGACY_DIR", t "$SMPROGRAMS\Hanako") i.r0'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1"`
  Pop $0
  Pop $1
  Pop $0
  !insertmacro hanakoInstallTimingMark "legacyShortcutCleanup" "end"
!macroend

!macro hanakoRemoveOwnedInstallTrees
  !insertmacro hanakoInstallTimingMark "removeOwnedInstallTrees" "start"
  DetailPrint "Removing HanaIDE-owned install files"
  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR\resources\server"
  RMDir /r "$INSTDIR\resources\git"
  RMDir /r "$INSTDIR\resources\screenshot-themes"
  RMDir /r "$INSTDIR\resources\app"
  RMDir /r "$INSTDIR\resources\app.asar.unpacked"
  Delete "$INSTDIR\resources\app.asar"
  Delete "$INSTDIR\resources\elevate.exe"
  RMDir "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\swiftshader"
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  Delete "$INSTDIR\HanaAgent.exe"
  Delete "$INSTDIR\Hanako.exe"
  Delete "$INSTDIR\Uninstall Hanako.exe"
  Delete "$INSTDIR\hanako-install-diagnostics.log"
  !insertmacro hanakoRemoveLegacyGlobalShortcuts
  Delete "$INSTDIR\uninstallerIcon.ico"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\LICENSE*"
  Delete "$INSTDIR\*.ico"
  !insertmacro hanakoInstallTimingMark "removeOwnedInstallTrees" "end"
!macroend

!macro hanakoPrepareOwnedOverlay
  !insertmacro hanakoInstallTimingMark "prepareOwnedOverlay" "start"
  !insertmacro hanakoStopInstallDirProcesses
  !insertmacro hanakoRemoveOwnedInstallTrees
  ClearErrors
  !insertmacro hanakoInstallTimingMark "prepareOwnedOverlay" "end"
!macroend

!macro customInit
  !insertmacro hanakoInstallTimingMark "customInit" "start"
  !insertmacro hanakoStopInstallDirProcesses
  ; Wait for file handles to release.
  Sleep 2000
  !insertmacro hanakoInstallTimingMark "customInit" "end"
!macroend

!macro customUnInstallCheck
  !insertmacro hanakoInstallTimingMark "customUnInstallCheck" "start"
  ${If} ${Errors}
    DetailPrint `Previous uninstaller could not be launched; preparing a HanaIDE-owned overlay.`
  ${ElseIf} $R0 != 0
    DetailPrint `Previous uninstaller exited with code $R0; preparing a HanaIDE-owned overlay.`
  ${EndIf}
  !insertmacro hanakoPrepareOwnedOverlay
  ClearErrors
  !insertmacro hanakoInstallTimingMark "customUnInstallCheck" "end"
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro hanakoInstallTimingMark "customUnInstallCheckCurrentUser" "start"
  ${If} ${Errors}
    DetailPrint `Previous current-user uninstaller could not be launched; continuing with HanaIDE-owned overlay.`
  ${ElseIf} $R0 != 0
    DetailPrint `Previous current-user uninstaller exited with code $R0; continuing with HanaIDE-owned overlay.`
  ${EndIf}
  !insertmacro hanakoPrepareOwnedOverlay
  ClearErrors
  !insertmacro hanakoInstallTimingMark "customUnInstallCheckCurrentUser" "end"
!macroend

!macro customRemoveFiles
  !insertmacro hanakoInstallTimingMark "customRemoveFiles" "start"
  !insertmacro hanakoStopInstallDirProcesses
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro hanakoRemoveOwnedInstallTrees
  RMDir "$INSTDIR"
  !insertmacro hanakoInstallTimingMark "customRemoveFiles" "end"
!macroend

!macro customUnInit
  !insertmacro hanakoInstallTimingMark "customUnInit" "start"
  !insertmacro hanakoStopInstallDirProcesses
  Sleep 2000
  !insertmacro hanakoInstallTimingMark "customUnInit" "end"
!macroend
