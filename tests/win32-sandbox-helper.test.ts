import { describe, expect, it } from "vitest";
import {
  buildWin32SandboxTokenDiagnosticArgs,
  buildWin32SandboxHelperArgs,
} from "../lib/sandbox/win32-sandbox-helper.ts";

describe("buildWin32SandboxHelperArgs", () => {
  it("projects the helper contract as write roots instead of read ACL grants", () => {
    const args = buildWin32SandboxHelperArgs({
      cwd: "C:\\work",
      executable: "C:\\Hanako\\resources\\git\\bin\\bash.exe",
      args: ["-lc", "curl https://example.com"],
      grants: {
        readPaths: ["C:\\outside\\brief.md"],
        optionalReadPaths: ["C:\\Users\\Hana"],
        writePaths: ["C:\\work"],
        optionalWritePaths: ["C:\\Users\\Hana\\.hanako\\.ephemeral"],
        denyReadPaths: ["C:\\Users\\Hana\\.hanako\\auth.json"],
        denyWritePaths: ["C:\\work\\.git"],
      },
    });

    expect(args).toEqual([
      "--cwd",
      "C:\\work",
      "--writable-root",
      "C:\\work",
      "--writable-root-optional",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
      "--deny-write",
      "C:\\work\\.git",
      "--",
      "C:\\Hanako\\resources\\git\\bin\\bash.exe",
      "-lc",
      "curl https://example.com",
    ]);
    expect(args).not.toEqual(expect.arrayContaining([
      "--grant-read",
      "--grant-read-optional",
      "--grant-write",
      "--grant-write-optional",
      "--deny-read",
      "--diagnose-legacy-acl",
      "--cleanup-legacy-acl",
      "--cleanup-hana-write-acl",
      "--cleanup-legacy-profile",
      "--legacy-appcontainer-profile",
    ]));
  });

  it("builds token diagnostic args without changing the executable contract", () => {
    expect(buildWin32SandboxTokenDiagnosticArgs({
      cwd: "C:\\work",
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoLogo", "-Command", "Write-Output ok"],
      grants: {
        writePaths: ["C:\\work"],
        optionalWritePaths: ["C:\\Users\\Hana\\.hanako\\.ephemeral"],
        denyWritePaths: ["C:\\work\\protected-cache"],
      },
    })).toEqual([
      "--diagnose-token",
      "--cwd",
      "C:\\work",
      "--writable-root",
      "C:\\work",
      "--writable-root-optional",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
      "--deny-write",
      "C:\\work\\protected-cache",
      "--",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoLogo",
      "-Command",
      "Write-Output ok",
    ]);
  });
});
