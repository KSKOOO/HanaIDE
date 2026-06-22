import { resolveShellProfile as resolveDefaultShellProfile } from "../shell/shell-profile.ts";
import {
  baseNameForShellPath,
  isWin32PathLike,
  quoteCmdArg,
  resolveWin32CmdExecutable,
  resolveWin32PowerShellExecutable,
  splitShellLikeArgs,
} from "../shell/shell-utils.ts";
import {
  getWin32ShellEnvForRuntime,
  resolveWin32ShellRuntime,
} from "../sandbox/win32-exec.ts";

function tokenBaseName(token) {
  return baseNameForShellPath(token).toLowerCase();
}

function isBatchToken(token) {
  return /\.(?:bat|cmd)$/i.test(tokenBaseName(token));
}

function isPowerShellToken(token) {
  return ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(tokenBaseName(token));
}

function isCmdToken(token) {
  return ["cmd", "cmd.exe"].includes(tokenBaseName(token));
}

const POWERSHELL_BASE_ARGS = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"];
const POWERSHELL_UTF8_BOOTSTRAP = [
  "$utf8 = New-Object System.Text.UTF8Encoding $false",
  "[Console]::InputEncoding = $utf8",
  "[Console]::OutputEncoding = $utf8",
  "$OutputEncoding = $utf8",
  "chcp.com 65001 > $null",
].join("; ");

function powershellExecutableForToken(token, env) {
  const raw = String(token || "");
  if (isWin32PathLike(raw) || raw.includes("\\") || raw.includes("/")) return raw;
  return resolveWin32PowerShellExecutable(raw || "powershell.exe", env);
}

function powershellArgsForExplicit(rest) {
  if (!rest.length) return [...POWERSHELL_BASE_ARGS, "-NoExit", "-Command", POWERSHELL_UTF8_BOOTSTRAP];
  const commandIndex = rest.findIndex(arg => /^-(?:command|c)$/i.test(String(arg || "")));
  if (commandIndex >= 0 && commandIndex < rest.length - 1) {
    return [
      ...POWERSHELL_BASE_ARGS,
      ...rest.slice(0, commandIndex + 1),
      `${POWERSHELL_UTF8_BOOTSTRAP}; ${rest[commandIndex + 1]}`,
      ...rest.slice(commandIndex + 2),
    ];
  }
  return [...POWERSHELL_BASE_ARGS, ...rest];
}

function resolvePowerShellTerminal(input, env) {
  const args = splitShellLikeArgs(input);
  const executable = powershellExecutableForToken(args[0], env);
  return {
    file: executable,
    args: powershellArgsForExplicit(args.slice(1)),
    env,
  };
}

function resolveBatchTerminal(input, env) {
  const args = splitShellLikeArgs(input);
  const command = [
    quoteCmdArg(args[0], { always: true }),
    ...args.slice(1).map((arg) => quoteCmdArg(arg)),
  ].join(" ");
  return {
    file: resolveWin32CmdExecutable(env),
    args: ["/d", "/s", "/c", `call ${command}`],
    env: undefined,
  };
}

function resolveExplicitCmdTerminal(input, env) {
  const args = splitShellLikeArgs(input).slice(1);
  return {
    file: resolveWin32CmdExecutable(env),
    args: args.length ? args : [],
    env: undefined,
  };
}

export function resolveTerminalShell(command = "", {
  platform = process.platform,
  env = process.env,
  profile = "default",
  resolveShellProfile = resolveDefaultShellProfile,
  resolveWin32ShellRuntime: resolveWin32Shell = resolveWin32ShellRuntime,
  getWin32ShellEnvForRuntime: getWin32ShellEnv = getWin32ShellEnvForRuntime,
} = {}) {
  const input = typeof command === "string" ? command : "";
  const tokens = splitShellLikeArgs(input);
  const firstToken = tokens[0] || "";

  if (platform === "win32") {
    if (firstToken && isPowerShellToken(firstToken)) return resolvePowerShellTerminal(input, env);
    if (firstToken && isBatchToken(firstToken)) return resolveBatchTerminal(input, env);
    if (firstToken && isCmdToken(firstToken)) return resolveExplicitCmdTerminal(input, env);
  }

  const shellProfile = resolveShellProfile({
    platform,
    profile,
    env,
    resolveWin32ShellRuntime: resolveWin32Shell,
    getWin32ShellEnvForRuntime: getWin32ShellEnv,
  });
  const args = input
    ? shellProfile.argsForCommand(input)
    : shellProfile.argsForInteractive();

  return {
    file: shellProfile.executable,
    args,
    env: shellProfile.env && shellProfile.env !== env ? shellProfile.env : (platform === "win32" && shellProfile.family === "powershell" ? env : undefined),
  };
}

export const __testing = {
  splitShellLikeArgs,
  tokenBaseName,
};
