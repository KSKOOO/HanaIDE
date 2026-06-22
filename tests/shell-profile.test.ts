import { describe, expect, it } from "vitest";
import { profileLabel, resolveShellProfile } from "../lib/shell/shell-profile.ts";

const POWERSHELL_UTF8_BOOTSTRAP_FRAGMENT = "[Console]::OutputEncoding = $utf8";

describe("resolveShellProfile", () => {
  it("uses the user shell on macOS", () => {
    const profile = resolveShellProfile({ platform: "darwin", env: { SHELL: "/bin/zsh" } });
    expect(profile.id).toBe("macos-default");
    expect(profile.family).toBe("posix");
    expect(profile.executable).toBe("/bin/zsh");
    expect(profile.argsForCommand("echo hi")).toEqual(["-lc", "echo hi"]);
    expect(profile.argsForInteractive()).toEqual(["-i"]);
    expect(profileLabel(profile)).toBe("zsh");
  });

  it("falls back to bash on Linux", () => {
    const profile = resolveShellProfile({ platform: "linux", env: {} });
    expect(profile.id).toBe("linux-default");
    expect(profile.family).toBe("posix");
    expect(profile.executable).toBe("/bin/bash");
    expect(profile.argsForCommand("pwd")).toEqual(["-lc", "pwd"]);
    expect(profileLabel(profile)).toBe("bash");
  });

  it("uses PowerShell on Windows native sessions", () => {
    const profile = resolveShellProfile({ platform: "win32", env: { SystemRoot: "C:\\Windows" } });
    expect(profile.id).toBe("windows-powershell");
    expect(profile.family).toBe("powershell");
    expect(profile.executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    const commandArgs = profile.argsForCommand("Write-Output 1");
    expect(commandArgs).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      expect.stringContaining(POWERSHELL_UTF8_BOOTSTRAP_FRAGMENT),
    ]);
    expect(commandArgs.at(-1)).toContain("Write-Output 1");
    expect(profile.argsForInteractive()).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-NoExit",
      "-Command",
      expect.stringContaining(POWERSHELL_UTF8_BOOTSTRAP_FRAGMENT),
    ]);
    expect(profileLabel(profile)).toBe("powershell");
  });

  it("uses an explicit Windows PowerShell executable when configured", () => {
    const profile = resolveShellProfile({
      platform: "win32",
      env: { HANA_POWERSHELL: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
    });
    expect(profile.executable).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(profileLabel(profile)).toBe("pwsh");
  });

  it("keeps explicit cmd as a cmd profile", () => {
    const profile = resolveShellProfile({
      platform: "win32",
      profile: "cmd",
      env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
    });
    expect(profile.id).toBe("windows-cmd");
    expect(profile.family).toBe("cmd");
    expect(profile.executable).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(profile.argsForCommand("dir")).toEqual(["/d", "/s", "/c", "dir"]);
    expect(profile.argsForInteractive()).toEqual([]);
    expect(profileLabel(profile)).toBe("cmd");
  });

  it("uses an injected Git Bash runtime for the git-bash profile", () => {
    const profile = resolveShellProfile({
      platform: "win32",
      profile: "git-bash",
      env: { PATH: "C:\\Hanako\\bin" },
      resolveWin32ShellRuntime: ({ preferBundled, env }) => ({
        shell: "C:\\Hanako\\resources\\git\\bin\\bash.exe",
        args: ["-lc"],
        label: `bundled:${preferBundled}:${env.PATH}`,
      }),
      getWin32ShellEnvForRuntime: (env, shellInfo) => ({ ...env, HANA_SHELL_LABEL: shellInfo.label }),
    });
    expect(profile.id).toBe("windows-git-bash");
    expect(profile.family).toBe("posix");
    expect(profile.executable).toBe("C:\\Hanako\\resources\\git\\bin\\bash.exe");
    expect(profile.argsForCommand("pwd")).toEqual(["-lc", "pwd"]);
    expect(profile.env.HANA_SHELL_LABEL).toBe("bundled:true:C:\\Hanako\\bin");
  });
});
