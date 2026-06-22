import {
  baseNameForShellPath,
  envValue,
  resolveWin32CmdExecutable,
  resolveWin32PowerShellExecutable,
} from "./shell-utils.ts";

function basenameForPath(filePath) {
  return baseNameForShellPath(filePath, { stripExe: true });
}

function normalizeProfileName(profile) {
  const value = String(profile || "default").trim().toLowerCase();
  return value || "default";
}

function posixProfile({ id, executable, commandArgs = ["-lc"], interactiveArgs = ["-i"], env }) {
  return {
    id,
    family: "posix",
    executable,
    env,
    argsForCommand(command) {
      return [...commandArgs, String(command ?? "")];
    },
    argsForInteractive() {
      return [...interactiveArgs];
    },
  };
}

const POWERSHELL_BASE_ARGS = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"];
const POWERSHELL_UTF8_BOOTSTRAP = [
  "$utf8 = New-Object System.Text.UTF8Encoding $false",
  "[Console]::InputEncoding = $utf8",
  "[Console]::OutputEncoding = $utf8",
  "$OutputEncoding = $utf8",
  "chcp.com 65001 > $null",
].join("; ");

function powershellProfile({ executable, env }) {
  return {
    id: "windows-powershell",
    family: "powershell",
    executable,
    env,
    argsForCommand(command) {
      const body = String(command ?? "");
      return [...POWERSHELL_BASE_ARGS, "-Command", body ? `${POWERSHELL_UTF8_BOOTSTRAP}; ${body}` : POWERSHELL_UTF8_BOOTSTRAP];
    },
    argsForInteractive() {
      return [...POWERSHELL_BASE_ARGS, "-NoExit", "-Command", POWERSHELL_UTF8_BOOTSTRAP];
    },
  };
}

function cmdProfile({ executable, env }) {
  return {
    id: "windows-cmd",
    family: "cmd",
    executable,
    env,
    argsForCommand(command) {
      return ["/d", "/s", "/c", String(command ?? "")];
    },
    argsForInteractive() {
      return [];
    },
  };
}

function resolvePosixDefault({ platform, env }) {
  const executable = envValue(env, "SHELL") || "/bin/bash";
  return posixProfile({
    id: platform === "darwin" ? "macos-default" : "linux-default",
    executable,
    env,
  });
}

function resolvePowerShellDefault({ env }) {
  return powershellProfile({
    executable: resolveWin32PowerShellExecutable("powershell.exe", env),
    env,
  });
}

function resolveCmdDefault({ env }) {
  return cmdProfile({
    executable: resolveWin32CmdExecutable(env),
    env,
  });
}

function resolveGitBashProfile({
  env,
  resolveWin32ShellRuntime,
  getWin32ShellEnvForRuntime,
}) {
  if (typeof resolveWin32ShellRuntime !== "function") {
    throw new Error("git-bash shell profile requires resolveWin32ShellRuntime");
  }
  const shellInfo = resolveWin32ShellRuntime({ preferBundled: true, env });
  const profileEnv = typeof getWin32ShellEnvForRuntime === "function"
    ? getWin32ShellEnvForRuntime(env, shellInfo)
    : env;
  return posixProfile({
    id: "windows-git-bash",
    executable: shellInfo.shell,
    commandArgs: shellInfo.args || ["-lc"],
    interactiveArgs: ["-i"],
    env: profileEnv,
  });
}

export function resolveShellProfile({
  platform = process.platform,
  profile = "default",
  env = process.env,
  resolveWin32ShellRuntime,
  getWin32ShellEnvForRuntime,
}: {
  platform?: NodeJS.Platform;
  profile?: string;
  env?: NodeJS.ProcessEnv;
  resolveWin32ShellRuntime?: (...args: any[]) => any;
  getWin32ShellEnvForRuntime?: (...args: any[]) => any;
} = {}) {
  const profileName = normalizeProfileName(profile);

  if (platform === "win32") {
    if (profileName === "cmd") return resolveCmdDefault({ env });
    if (profileName === "git-bash" || profileName === "bash") {
      return resolveGitBashProfile({
        env,
        resolveWin32ShellRuntime,
        getWin32ShellEnvForRuntime,
      });
    }
    if (profileName === "powershell" || profileName === "pwsh" || profileName === "default") {
      return resolvePowerShellDefault({ env });
    }
    throw new Error(`unsupported Windows shell profile: ${profile}`);
  }

  if (profileName !== "default" && profileName !== "posix") {
    throw new Error(`unsupported shell profile for ${platform}: ${profile}`);
  }
  return resolvePosixDefault({ platform, env });
}

export function profileLabel(profile) {
  if (!profile) return "";
  if (profile.family === "powershell") {
    return basenameForPath(profile.executable).toLowerCase() === "pwsh" ? "pwsh" : "powershell";
  }
  return basenameForPath(profile.executable) || profile.family || "";
}

export const __testing = {
  basenameForPath,
  envValue,
};
