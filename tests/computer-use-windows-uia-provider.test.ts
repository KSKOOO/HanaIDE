import fs from "fs";
import { describe, expect, it, vi } from "vitest";
import { createWindowsUiaProvider } from "../core/computer-use/providers/windows-uia-provider.ts";
import { WINDOWS_UIA_HELPER_SCRIPT } from "../core/computer-use/providers/windows-uia-script.ts";
import { COMPUTER_USE_ERRORS } from "../core/computer-use/errors.ts";

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function writeHelperResult(args, payload) {
  const resultPath = argValue(args, "-ResultPath");
  if (!resultPath) return false;
  fs.writeFileSync(resultPath, JSON.stringify(payload), "utf8");
  return true;
}

function writeTextHelperResult(args, text) {
  const resultPath = argValue(args, "-ResultPath");
  if (!resultPath) return null;
  fs.writeFileSync(resultPath, text, "utf8");
  return resultPath;
}

function readHelperRequest(args) {
  return JSON.parse(fs.readFileSync(argValue(args, "-RequestPath"), "utf8"));
}

function helperResult(data, args = []) {
  if (writeHelperResult(args, { ok: true, data })) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  return { stdout: JSON.stringify({ ok: true, data }), stderr: "", exitCode: 0 };
}

function makeRunner(handler) {
  const calls: any[] = [];
  return {
    calls,
    runner: {
      run: vi.fn(async (command, args, options) => {
        const call: any = { command, args, options };
        calls.push(call);
        const response = await handler(command, args, options);
        const requestPath = argValue(args, "-RequestPath");
        if (requestPath && fs.existsSync(requestPath)) {
          call.request = readHelperRequest(args);
        }
        return response;
      }),
    },
  };
}

describe("Windows UIA provider", () => {
  it("does not assign PowerShell automatic variables in the UIA helper", () => {
    const automaticVariables = new Set([
      "$$",
      "$?",
      "$^",
      "$_",
      "args",
      "consolefilename",
      "enabledexperimentalfeatures",
      "error",
      "event",
      "eventargs",
      "eventsubscriber",
      "executioncontext",
      "false",
      "foreach",
      "home",
      "host",
      "input",
      "iscoreclr",
      "islinux",
      "ismacos",
      "iswindows",
      "lastexitcode",
      "matches",
      "myinvocation",
      "nestedpromptlevel",
      "null",
      "pid",
      "profile",
      "psboundparameters",
      "pscmdlet",
      "pscommandpath",
      "psculture",
      "psdebugcontext",
      "psedition",
      "pshome",
      "psitem",
      "psscriptroot",
      "pssenderinfo",
      "psuiculture",
      "psversiontable",
      "pwd",
      "sender",
      "shellid",
      "stacktrace",
      "switch",
      "this",
      "true",
    ]);
    const assignmentPattern = /(?:^|[^\w])(?:\[[^\]]+\]\s*)?\$([A-Za-z_][\w]*)\s*(?:=|\+=|-=|\*=|\/=|%=|\+\+|--)/g;
    const violations = [];

    for (const [index, rawLine] of WINDOWS_UIA_HELPER_SCRIPT.split(/\r?\n/).entries()) {
      const line = rawLine.replace(/#.*/, "");
      let match = assignmentPattern.exec(line);
      while (match) {
        if (automaticVariables.has(match[1].toLowerCase())) {
          violations.push(`${index + 1}: ${rawLine.trim()}`);
        }
        match = assignmentPattern.exec(line);
      }
    }

    expect(violations).toEqual([]);
  });

  it("writes UIA helper results through a temporary file before publishing the result path", () => {
    expect(WINDOWS_UIA_HELPER_SCRIPT).toContain("[System.IO.File]::WriteAllText($tempResultPath, $json, $script:WindowsUiaUtf8NoBom)");
    expect(WINDOWS_UIA_HELPER_SCRIPT).toContain("[System.IO.File]::Move($tempResultPath, $script:WindowsUiaResultPath)");
    expect(WINDOWS_UIA_HELPER_SCRIPT).not.toContain("[System.IO.File]::WriteAllText($script:WindowsUiaResultPath, $json");
  });

  it("serializes UIA bounds through a JSON-safe number helper", () => {
    expect(WINDOWS_UIA_HELPER_SCRIPT).toContain("function Safe-Number($value)");
    expect(WINDOWS_UIA_HELPER_SCRIPT).toContain("if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { return $null }");
    expect(WINDOWS_UIA_HELPER_SCRIPT).toContain("x = Safe-Number $r.Left");
    expect(WINDOWS_UIA_HELPER_SCRIPT).toContain("y = Safe-Number $r.Top");
    expect(WINDOWS_UIA_HELPER_SCRIPT).toContain("width = Safe-Number $r.Width");
    expect(WINDOWS_UIA_HELPER_SCRIPT).toContain("height = Safe-Number $r.Height");
    expect(WINDOWS_UIA_HELPER_SCRIPT).not.toContain("x = [double]$r.Left");
  });

  it("rejects unstable snapshot matching when bounds cannot be used safely", () => {
    expect(WINDOWS_UIA_HELPER_SCRIPT).toContain("function Bounds-AreUsable($bounds)");
    expect(WINDOWS_UIA_HELPER_SCRIPT).toContain('reason = "bounds-unavailable"');

    const boundsUnavailableIndex = WINDOWS_UIA_HELPER_SCRIPT.indexOf('reason = "bounds-unavailable"');
    const centerMathIndex = WINDOWS_UIA_HELPER_SCRIPT.indexOf("$expectedCenterX = [double]$snapshot.bounds.x");
    expect(boundsUnavailableIndex).toBeGreaterThan(0);
    expect(centerMathIndex).toBeGreaterThan(boundsUnavailableIndex);
  });

  it("reports unavailable on non-Windows platforms", async () => {
    const provider = createWindowsUiaProvider({ platform: "darwin" });

    await expect(provider.getStatus()).resolves.toMatchObject({
      available: false,
      reason: "unsupported-platform",
    });
    await expect(provider.listApps()).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE,
    });
  });

  it("invokes PowerShell helper file with request/result JSON files", async () => {
    const { runner, calls } = makeRunner((_command, args) => helperResult({ apps: [] }, args));
    const provider = createWindowsUiaProvider({
      platform: "win32",
      command: "powershell.exe",
      helperScript: `${"#".repeat(40000)}\nWrite-Output '{}'`,
      runner,
    } as any);

    await provider.listApps();

    expect(calls[0].command).toBe("powershell.exe");
    expect(calls[0].args).toContain("-File");
    expect(calls[0].args).toContain("-RequestPath");
    expect(calls[0].args).toContain("-ResultPath");
    expect(calls[0].args).not.toContain("-EncodedCommand");
    expect(calls[0].args.join("")).not.toContain("#".repeat(1000));
    expect(calls[0].args[calls[0].args.indexOf("-File") + 1]).toMatch(/windows-uia-helper-[a-f0-9]+\.ps1$/);
    expect(calls[0].request).toEqual({ command: "list_apps" });
    expect(calls[0].options.stdin).toBeUndefined();
  });

  it("reads helper results from the result file when stdout contains PowerShell noise", async () => {
    const { runner } = makeRunner((_command, args) => {
      writeHelperResult(args, {
        ok: true,
        data: {
          apps: [{
            appId: "pid:12",
            name: "Notepad",
            processId: 12,
            windows: [],
          }],
        },
      });
      return { stdout: "Windows PowerShell\r\nCopyright banner\r\n", stderr: "debug warning\r\n", exitCode: 0 };
    });
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner } as any);

    await expect(provider.listApps()).resolves.toMatchObject([
      { appId: "pid:12", name: "Notepad", pid: 12 },
    ]);
  });

  it("reports bounded stdout stderr result head tail and file metadata when helper result JSON is invalid", async () => {
    const middle = "middle-content-that-must-not-leak";
    const invalidResult = `{ ${"a".repeat(3000)}${middle}${"z".repeat(3000)}`;
    let helperResultPath = null;
    const { runner } = makeRunner((_command, args) => {
      helperResultPath = writeTextHelperResult(args, invalidResult);
      return { stdout: "banner before result\n".repeat(20), stderr: "warning stream\n", exitCode: 0 };
    });
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner } as any);

    let error = null;
    try {
      await provider.listApps();
    } catch (err) {
      error = err;
    }

    expect(error).toMatchObject({
      code: COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
      message: expect.stringContaining("Windows UIA helper returned invalid JSON."),
      details: expect.objectContaining({
        stdoutPreview: expect.stringContaining("banner before result"),
        stderrPreview: expect.stringContaining("warning stream"),
        resultPath: helperResultPath,
        resultSize: Buffer.byteLength(invalidResult, "utf8"),
        resultHeadPreview: expect.stringContaining("{ aaa"),
        resultTailPreview: expect.stringContaining("zzz"),
      }),
    });
    expect(error).toMatchObject({
      details: expect.not.objectContaining({
        resultHeadPreview: expect.stringContaining(middle),
        resultTailPreview: expect.stringContaining(middle),
      }),
    });
  });

  it("reports result path and missing size when the helper does not write a result file", async () => {
    let helperResultPath = null;
    const { runner } = makeRunner((_command, args) => {
      helperResultPath = argValue(args, "-ResultPath");
      return { stdout: "banner without result\n", stderr: "warning without result\n", exitCode: 0 };
    });
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner } as any);

    await expect(provider.listApps()).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
      message: expect.stringContaining("Windows UIA helper did not write result JSON."),
      details: expect.objectContaining({
        stdoutPreview: expect.stringContaining("banner without result"),
        stderrPreview: expect.stringContaining("warning without result"),
        resultPath: helperResultPath,
        resultSize: null,
        readCode: "ENOENT",
      }),
    });
  });

  it("refuses oversized helper result files before parsing payloads into memory", async () => {
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      const runner = {
        run: vi.fn(async (_command, args) => {
          const resultPath = argValue(args, "-ResultPath");
          fs.writeFileSync(resultPath, '{"ok":true,"data":{"apps":[]}}', "utf8");
          fs.truncateSync(resultPath, 129);
          return { stdout: "banner\n", stderr: "warning\n", exitCode: 0 };
        }),
      };
      const provider = createWindowsUiaProvider({
        platform: "win32",
        command: "powershell.exe",
        runner,
        maxResultBytes: 128,
      } as any);

      await expect(provider.listApps()).rejects.toMatchObject({
        code: COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
        message: expect.stringContaining("Windows UIA helper result JSON exceeded the payload limit."),
        details: expect.objectContaining({
          resultSize: 129,
          maxResultBytes: 128,
          resultHeadPreview: expect.any(String),
          resultTailPreview: expect.any(String),
        }),
      });
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("preserves structured helper error code message and details", async () => {
    const { runner } = makeRunner((_command, args) => {
      writeHelperResult(args, {
        ok: false,
        errorCode: "ACTION_REQUIRES_FOREGROUND",
        message: "Element needs foreground input.",
        details: { elementId: "uia:7", reason: "missing-pattern" },
      });
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner } as any);

    await expect(provider.getAppState({}, { leaseId: "lease-1", providerState: { processId: 12 } }))
      .rejects.toMatchObject({
        code: COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND,
        message: expect.stringContaining("Element needs foreground input."),
        details: { elementId: "uia:7", reason: "missing-pattern" },
      });
  });

  it("maps helper launch ENAMETOOLONG into a typed provider error", async () => {
    const launchError = new Error("spawn ENAMETOOLONG");
    (launchError as any).code = "ENAMETOOLONG";
    const { runner } = makeRunner(() => {
      throw launchError;
    });
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner } as any);

    await expect(provider.listApps()).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
      message: expect.stringContaining("Windows UIA helper failed to launch"),
      details: expect.objectContaining({ launchCode: "ENAMETOOLONG" }),
    });
  });

  it("keeps powershell-not-found status reason after launch error mapping", async () => {
    const launchError = new Error("spawn ENOENT");
    (launchError as any).code = "ENOENT";
    const { runner } = makeRunner(() => {
      throw launchError;
    });
    const provider = createWindowsUiaProvider({ platform: "win32", command: "missing-powershell.exe", runner } as any);

    await expect(provider.getStatus()).resolves.toMatchObject({
      available: false,
      reason: "powershell-not-found",
    });
  });

  it("normalizes list_apps and lease provider state", async () => {
    const { runner } = makeRunner((_command, args) => helperResult({
      apps: [{
        appId: "pid:12",
        name: "Notepad",
        processId: 12,
        windows: [{ windowId: "123", title: "Untitled - Notepad" }],
      }],
    }, args));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner } as any);

    const apps = await provider.listApps();
    const lease = await provider.createLease({}, { appId: "pid:12", windowId: "123" });

    expect(apps[0]).toMatchObject({
      appId: "pid:12",
      name: "Notepad",
      pid: 12,
      windows: [{ windowId: "123", title: "Untitled - Notepad" }],
    });
    expect(lease).toMatchObject({
      appId: "pid:12",
      windowId: "123",
      providerState: { appId: "pid:12", processId: 12, windowId: 123 },
    });
  });

  it("declares background-only UIA capabilities and omits foreground raw input actions from leases", async () => {
    const { runner } = makeRunner((_command, args) => helperResult({ ok: true }, args));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner } as any);

    const lease = await provider.createLease({}, { appId: "pid:12", windowId: "123" });

    expect(provider.capabilities).toMatchObject({
      backgroundControl: "partial",
      pointClick: "unsupported",
      drag: "unsupported",
      keyboardInput: "unsupported",
      requiresForegroundForInput: false,
    });
    expect(lease.allowedActions).toEqual([
      "click_element",
      "type_text",
      "scroll",
      "stop",
    ]);
  });

  it("normalizes helper snapshots into Hana snapshots", async () => {
    const { runner } = makeRunner((_command, args) => helperResult({
      appId: "pid:12",
      windowId: "123",
      screenshot: "png-base64",
      display: { x: 10, y: 20, width: 300, height: 200 },
      elements: [{ elementId: "uia:1", role: "ControlType.Button", label: "OK", patterns: ["InvokePattern"] }],
      providerState: { processId: 12, windowId: 123 },
    }, args));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner } as any);

    const snapshot = await provider.getAppState({}, {
      leaseId: "lease-1",
      appId: "pid:12",
      windowId: "123",
      providerState: { processId: 12, windowId: 123 },
    });

    expect(snapshot).toMatchObject({
      mode: "vision-native",
      appId: "pid:12",
      windowId: "123",
      screenshot: { type: "image", mimeType: "image/png", data: "png-base64" },
      elements: [{ elementId: "uia:1", role: "ControlType.Button", label: "OK" }],
    });
  });

  it("maps only snapshot-bound semantic UIA actions to the helper", async () => {
    const { runner, calls } = makeRunner((_command, args) => helperResult({ ok: true }, args));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner } as any);
    const lease = { leaseId: "lease-1", providerState: { processId: 12, windowId: 123 } };
    const snapshotElement = {
      elementId: "uia:1",
      role: "ControlType.Button",
      label: "OK",
      automationId: "ok",
      bounds: { x: 10, y: 20, width: 80, height: 30 },
    };

    await provider.performAction({}, lease, { type: "click_element", elementId: "uia:1", snapshotElement });
    await provider.performAction({}, lease, { type: "type_text", elementId: "uia:1", text: "hello", snapshotElement });
    await provider.performAction({}, lease, { type: "scroll", elementId: "uia:1", direction: "down", snapshotElement });

    expect(calls[0].request).toMatchObject({
      command: "perform_action",
      action: { type: "click_element", elementId: "uia:1", snapshotElement },
    });
    expect(calls[1].request).toMatchObject({
      command: "perform_action",
      action: { type: "type_text", elementId: "uia:1", text: "hello", snapshotElement },
    });
    expect(calls[2].request).toMatchObject({
      command: "perform_action",
      action: { type: "scroll", elementId: "uia:1", direction: "down", snapshotElement },
    });
  });

  it("rejects foreground-only actions before invoking the helper", async () => {
    const { runner, calls } = makeRunner((_command, args) => helperResult({ ok: true }, args));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner } as any);
    const lease = { leaseId: "lease-1", providerState: { processId: 12, windowId: 123 } };

    await expect(provider.performAction({}, lease, { type: "click_point", x: 1, y: 2 }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND });
    await expect(provider.performAction({}, lease, { type: "double_click", x: 1, y: 2 }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND });
    await expect(provider.performAction({}, lease, { type: "drag", fromX: 1, fromY: 2, toX: 3, toY: 4 }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND });
    await expect(provider.performAction({}, lease, { type: "press_key", key: "Return" }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND });
    await expect(provider.performAction({}, lease, { type: "type_text", text: "foreground text" }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND });
    await expect(provider.performAction({}, lease, { type: "scroll", direction: "down" }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND });

    expect(calls).toHaveLength(0);
  });

  it("rejects element-indexed actions unless the host provides snapshot-bound metadata", async () => {
    const { runner } = makeRunner((_command, args) => helperResult({ ok: true }, args));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner } as any);
    const lease = { leaseId: "lease-1", providerState: { processId: 12, windowId: 123 } };

    await expect(provider.performAction({}, lease, { type: "click_element", elementId: "uia:1" }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.STALE_SNAPSHOT });
    await expect(provider.performAction({}, lease, { type: "scroll", elementId: "uia:1", direction: "down" }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.STALE_SNAPSHOT });
  });

  it("rejects malformed foreground input before invoking the helper", async () => {
    const { runner } = makeRunner((_command, args) => helperResult({ ok: true }, args));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner } as any);
    const lease = { leaseId: "lease-1", providerState: { processId: 12, windowId: 123 } };

    await expect(provider.performAction({}, lease, { type: "click_point", x: 1 }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_BLOCKED_BY_POLICY });
    await expect(provider.performAction({}, lease, { type: "drag", fromX: 1, fromY: 2, toX: 3 }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_BLOCKED_BY_POLICY });
    await expect(provider.performAction({}, lease, { type: "press_key" }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_BLOCKED_BY_POLICY });
  });

  it("converts helper errors into typed Hana errors", async () => {
    const { runner } = makeRunner((_command, args) => {
      if (writeHelperResult(args, { ok: false, errorCode: "TARGET_NOT_FOUND", message: "Window not found." })) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return {
        stdout: JSON.stringify({ ok: false, errorCode: "TARGET_NOT_FOUND", message: "Window not found." }),
        stderr: "",
        exitCode: 0,
      };
    });
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner } as any);

    await expect(provider.getAppState({}, { leaseId: "lease-1", providerState: { processId: 12 } }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.TARGET_NOT_FOUND });
  });
});
