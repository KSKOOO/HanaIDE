import { beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  namespace NodeJS {
    interface Process {
      resourcesPath?: string;
    }
  }
}

const spawnAndStream = vi.fn<(...args: any[]) => Promise<{ exitCode: number }>>(async () => ({ exitCode: 0 }));
const classifyWin32Command = vi.fn();
const prepareSandboxRuntime = vi.fn<(...args: any[]) => any>((runtimeInfo) => runtimeInfo);
const existsSync = vi.fn<(...args: any[]) => boolean>(() => false);
const mkdirSync = vi.fn();
const statSync = vi.fn<(...args: any[]) => any>(() => ({ isDirectory: () => true }));
const spawnSync = vi.fn<(...args: any[]) => { status: number; stdout: string; stderr: string }>(() => ({ status: 1, stdout: "", stderr: "" }));
const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
const systemCmdExe = `${systemRoot}\\System32\\cmd.exe`;

vi.mock("../lib/sandbox/exec-helper.js", () => ({
  spawnAndStream,
}));

vi.mock("../lib/sandbox/win32-command-router.js", () => ({
  classifyWin32Command,
}));

vi.mock("../lib/sandbox/win32-runtime-cache.js", () => ({
  prepareSandboxRuntime,
}));

vi.mock("fs", () => ({
  existsSync,
  mkdirSync,
  statSync,
}));

vi.mock("child_process", () => ({
  spawnSync,
}));

async function loadExecFactory() {
  const mod = await import("../lib/sandbox/win32-exec.ts");
  return mod.createWin32Exec;
}

describe("createWin32Exec", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    prepareSandboxRuntime.mockImplementation((runtimeInfo) => runtimeInfo);
    existsSync.mockReturnValue(false);
    mkdirSync.mockImplementation(() => undefined);
    statSync.mockImplementation(() => ({ isDirectory: () => true }));
    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
  });

  it("routes Windows native commands through cmd.exe", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-system-executable" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("ipconfig /all", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      systemCmdExe,
      ["/d", "/s", "/c", "chcp 65001 >NUL & ipconfig /all"],
      expect.objectContaining({
        cwd: "C:\\work",
        env: expect.objectContaining({
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
        }),
      })
    );
  });

  it("rejects before spawning when the working directory is missing", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-system-executable" });
    statSync.mockImplementation((p: any) => {
      if (p === "C:\\gone") {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return { isDirectory: () => true };
    });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await expect(
      exec("ipconfig /all", "C:\\gone", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      }),
    ).rejects.toMatchObject({ code: "HANA_EXEC_CWD_MISSING", cwd: "C:\\gone" });
    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("preserves explicit Python encoding settings while adding other UTF-8 defaults", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("type sample.txt", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: {
        PATH: "C:\\Windows\\System32",
        PYTHONUTF8: "0",
      },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      systemCmdExe,
      ["/d", "/s", "/c", "chcp 65001 >NUL & type sample.txt"],
      expect.objectContaining({
        env: expect.objectContaining({
          PYTHONUTF8: "0",
          PYTHONIOENCODING: "utf-8",
        }),
      })
    );
  });

  it("routes sandboxed Windows native commands through cmd with UTF-8 defaults", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-native-utility" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await exec('findstr /N "Hello" sample.txt', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--",
      systemCmdExe,
      "/d",
      "/s",
      "/c",
      'chcp 65001 >NUL & findstr /N "Hello" sample.txt',
    ]));
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      helperArgs,
      expect.objectContaining({
        cwd: "C:\\work",
        env: expect.objectContaining({
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
        }),
      })
    );
  });

  it("routes explicit PowerShell commands directly without cmd wrapping", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell", reason: "explicit-powershell-shell" });
    const powerShellExe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec('powershell -Command "Write-Output \\"name\\""', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      powerShellExe,
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        'Write-Output "name"',
      ],
      expect.objectContaining({
        cwd: "C:\\work",
        env: expect.objectContaining({
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
        }),
      })
    );
  });

  it("routes PowerShell script files through -File with argv", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell-file", reason: "powershell-script-file" });
    const powerShellExe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec('"C:\\work\\run tests.ps1" -Name Hana', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      powerShellExe,
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\work\\run tests.ps1",
        "-Name",
        "Hana",
      ],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes default Windows shell commands through PowerShell without falling back to bash", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell-command", reason: "default-powershell" });
    const powerShellExe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("$PSVersionTable.PSVersion", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      powerShellExe,
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$PSVersionTable.PSVersion",
      ],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes batch scripts through cmd call without bash", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd-script", reason: "cmd-script-file" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("C:\\work\\run-tests.bat --fast", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      systemCmdExe,
      ["/d", "/s", "/c", "chcp 65001 >NUL & call C:\\work\\run-tests.bat --fast"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes sandboxed relative batch scripts through cmd call", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd-script", reason: "cmd-script-file" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await exec(".tmp\\sandbox-smoke\\test-bat.bat", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32", COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--",
        "C:\\Windows\\System32\\cmd.exe",
        "/d",
        "/s",
        "/c",
        "chcp 65001 >NUL & call .tmp\\sandbox-smoke\\test-bat.bat",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("redirects sandbox runtime temp and cache env into the writable Hana scratch area", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell-command", reason: "default-powershell" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
          optionalWritePaths: ["C:\\Users\\Hana\\.hanako\\.ephemeral"],
        },
      },
    });

    await exec("(Invoke-WebRequest -UseBasicParsing https://example.com).StatusCode", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: {
        PATH: "C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
        USERPROFILE: "C:\\Users\\Hana",
        TEMP: "C:\\Users\\Hana\\AppData\\Local\\Temp",
        TMP: "C:\\Users\\Hana\\AppData\\Local\\Temp",
        LOCALAPPDATA: "C:\\Users\\Hana\\AppData\\Local",
        APPDATA: "C:\\Users\\Hana\\AppData\\Roaming",
      },
    });

    const envRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-env";
    const tempDir = `${envRoot}\\Temp`;
    const localAppDataDir = `${envRoot}\\LocalAppData`;
    const appDataDir = `${envRoot}\\AppData\\Roaming`;
    const npmCacheDir = `${envRoot}\\npm-cache`;
    const pipCacheDir = `${envRoot}\\pip-cache`;
    const spawnOptions = spawnAndStream.mock.calls[0][2];

    for (const dir of [tempDir, localAppDataDir, appDataDir, npmCacheDir, pipCacheDir]) {
      expect(mkdirSync).toHaveBeenCalledWith(dir, { recursive: true });
    }
    expect(spawnOptions.env).toEqual(expect.objectContaining({
      USERPROFILE: "C:\\Users\\Hana",
      TEMP: tempDir,
      TMP: tempDir,
      LOCALAPPDATA: localAppDataDir,
      APPDATA: appDataDir,
      npm_config_cache: npmCacheDir,
      PIP_CACHE_DIR: pipCacheDir,
    }));
  });

  it("routes simple Git commands through bundled git.exe without bash", async () => {
    classifyWin32Command.mockReturnValue({ runner: "git", reason: "git-command" });
    const gitExe = "C:\\Hanako\\resources\\git\\cmd\\git.exe";
    existsSync.mockImplementation((p) => p === gitExe);

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    try {
      await exec('git -C "C:\\Users\\Me\\repo" status --short "src file.txt"', "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      gitExe,
      ["-C", "C:\\Users\\Me\\repo", "status", "--short", "src file.txt"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes sandboxed simple Git commands through bundled git.exe via the helper", async () => {
    classifyWin32Command.mockReturnValue({ runner: "git", reason: "git-command" });
    const gitExe = "C:\\Hanako\\resources\\git\\cmd\\git.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === gitExe || p === helper);

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("git status --short", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--writable-root",
      "C:\\work",
      "--",
      gitExe,
      "status",
      "--short",
    ]));
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      helperArgs,
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("rewrites sandboxed Git commands to the user-writable runtime cache", async () => {
    classifyWin32Command.mockReturnValue({ runner: "git", reason: "git-command" });
    const gitExe = "C:\\Hanako\\resources\\git\\cmd\\git.exe";
    const cachedRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-runtime\\git-cache";
    const cachedGit = `${cachedRoot}\\cmd\\git.exe`;
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === gitExe || p === helper);
    prepareSandboxRuntime.mockImplementation((runtimeInfo, options) => {
      expect(options).toEqual(expect.objectContaining({
        kind: "git",
        hanakoHome: "C:\\Users\\Hana\\.hanako",
      }));
      return {
        ...runtimeInfo,
        bundledRoot: cachedRoot,
        git: cachedGit,
      };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("git status --short", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--writable-root",
      "C:\\work",
      "--",
      cachedGit,
      "status",
      "--short",
    ]));
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain(cachedRoot);
    expect(helperArgs).not.toContain("C:\\Hanako\\resources\\git");
    expect(helperArgs).not.toContain(gitExe);
  });

  it("grants sandboxed Python commands read-write access to the Python runtime", async () => {
    classifyWin32Command.mockReturnValue({ runner: "python", reason: "python-command" });
    const pythonExe = "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311\\python.exe";
    const pythonRoot = "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === pythonExe || p === pythonRoot || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "python") {
        return { status: 0, stdout: `${pythonExe}\r\n`, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await exec("python tools\\make_doc.py", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311;C:\\Windows\\System32" },
    });

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--writable-root",
        "C:\\work",
        "--",
        pythonExe,
        "tools\\make_doc.py",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain("--grant-write-optional");
    expect(helperArgs).not.toContain(pythonRoot);
  });

  it("passes Python inline code as argv instead of routing it through bash", async () => {
    classifyWin32Command.mockReturnValue({ runner: "python", reason: "python-command" });
    const pythonExe = "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311\\python.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === pythonExe || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "python") {
        return { status: 0, stdout: `${pythonExe}\r\n`, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await exec('python -c "import sys; print(sys.version)"', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311;C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--",
        pythonExe,
        "-c",
        "import sys; print(sys.version)",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes sandboxed simple Node commands through the current Node runtime via the helper", async () => {
    classifyWin32Command.mockReturnValue({ runner: "node", reason: "node-command" });
    const nodeExe = "C:\\Hanako\\resources\\server\\hana-server.exe";
    const nodeRoot = "C:\\Hanako\\resources\\server";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === nodeExe || p === nodeRoot || p === helper);

    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: nodeExe,
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("node server.js --port 3000", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--writable-root",
        "C:\\work",
        "--",
        nodeExe,
        "server.js",
        "--port",
        "3000",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain(nodeRoot);
  });

  it("prefers PATH Node over the packaged Hana server runtime for user node commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "node", reason: "node-command" });
    const hanaNodeExe = "C:\\Hanako\\resources\\server\\hana-server.exe";
    const pathNodeExe = "C:\\Program Files\\nodejs\\node.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === hanaNodeExe || p === pathNodeExe || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "node") {
        return { status: 0, stdout: `${pathNodeExe}\r\n`, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: hanaNodeExe,
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("node --version", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Program Files\\nodejs;C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--",
        pathNodeExe,
        "--version",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
    expect(spawnAndStream.mock.calls[0][1]).not.toContain(hanaNodeExe);
  });

  it("rewrites sandboxed Node commands to the user-writable runtime cache", async () => {
    classifyWin32Command.mockReturnValue({ runner: "node", reason: "node-command" });
    const nodeExe = "C:\\Hanako\\resources\\server\\hana-server.exe";
    const cachedRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-runtime\\node-cache";
    const cachedNode = `${cachedRoot}\\hana-server.exe`;
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === nodeExe || p === helper);
    prepareSandboxRuntime.mockImplementation((runtimeInfo, options) => {
      expect(options).toEqual(expect.objectContaining({
        kind: "node",
        hanakoHome: "C:\\Users\\Hana\\.hanako",
      }));
      return {
        ...runtimeInfo,
        executable: cachedNode,
      };
    });

    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: nodeExe,
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("node server.js --port 3000", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--writable-root",
      "C:\\work",
      "--",
      cachedNode,
      "server.js",
      "--port",
      "3000",
    ]));
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain(cachedRoot);
    expect(helperArgs).not.toContain("C:\\Hanako\\resources\\server");
    expect(helperArgs).not.toContain(nodeExe);
  });

  it("rejects explicit Python executables outside the workspace when they are not on PATH", async () => {
    classifyWin32Command.mockReturnValue({ runner: "python", reason: "python-command" });
    const privatePython = "D:\\Secrets\\python.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === privatePython || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "python.exe") {
        return { status: 1, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await expect(exec('"D:\\Secrets\\python.exe" tools\\make_doc.py', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    })).rejects.toThrow("outside the workspace");

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("keeps bash-routed commands on the bash fallback path", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    existsSync.mockImplementation((p) => p === "C:\\mock\\bash.exe");
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "bash.exe") {
        return { status: 0, stdout: "C:\\mock\\bash.exe\r\n", stderr: "" };
      }
      if (cmd === "C:\\mock\\bash.exe" && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("ls && pwd", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      "C:\\mock\\bash.exe",
      ["-c", "ls && pwd"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("prefers bundled POSIX runtime over system Git Bash when sandbox is disabled", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const systemBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === systemBash);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      if (cmd === systemBash && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: {
          PATH: "C:\\Windows\\System32",
          ProgramFiles: "C:\\Program Files",
        },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      bundledShell,
      ["-lc", "ls && pwd"],
      expect.objectContaining({
        cwd: "C:\\work",
        env: expect.objectContaining({
          PATH: expect.stringMatching(/^C:\\Hanako\\resources\\git\\bin;C:\\Hanako\\resources\\git\\usr\\bin;C:\\Hanako\\resources\\git\\mingw64\\bin;C:\\Hanako\\resources\\git\\cmd;/),
        }),
      })
    );
  });

  it("rejects CMD nul redirection before executing bash-routed commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    existsSync.mockImplementation((p) => p === "C:\\mock\\bash.exe");
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "bash.exe") {
        return { status: 0, stdout: "C:\\mock\\bash.exe\r\n", stderr: "" };
      }
      if (cmd === "C:\\mock\\bash.exe" && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await expect(exec("ipconfig /all > nul 2>&1", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    })).rejects.toThrow("/dev/null");

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("routes sandbox-enabled bash commands through the restricted-token helper with write roots", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: ["C:\\outside\\reference.md"],
          optionalReadPaths: ["C:\\Users\\Hana\\.hanako\\agents\\hanako\\config.yaml"],
          writePaths: ["C:\\work"],
          optionalWritePaths: ["C:\\Users\\Hana\\.hanako\\agents\\hanako\\memory"],
        },
      },
    });

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--cwd",
        "C:\\work",
        "--writable-root",
        "C:\\work",
        "--writable-root-optional",
        "C:\\Users\\Hana\\.hanako\\agents\\hanako\\memory",
        "--",
        bundledShell,
        "-lc",
        "ls && pwd",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain("C:\\outside\\reference.md");
    expect(helperArgs).not.toContain("C:\\Users\\Hana\\.hanako\\agents\\hanako\\config.yaml");
    expect(helperArgs).not.toContain("C:\\Hanako\\resources\\git");
  });

  it("holds a cleanup lease while sandboxed commands use writable roots", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-native-utility" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    const cleanupQueue = {
      beginRootUse: vi.fn(() => ({ id: "lease-1" })),
      endRootUse: vi.fn(),
      enqueueRoots: vi.fn(),
    };
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        legacyCleanupQueue: cleanupQueue,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
          optionalWritePaths: ["C:\\Users\\Hana\\.hanako\\.ephemeral"],
        },
      },
    });

    await exec("echo hello", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(cleanupQueue.beginRootUse).toHaveBeenCalledWith([
      "C:\\work",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
    ]);
    expect(cleanupQueue.endRootUse).toHaveBeenCalledWith({ id: "lease-1" });
    expect(cleanupQueue.enqueueRoots).toHaveBeenCalledWith([
      "C:\\work",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
    ]);
    expect(cleanupQueue.beginRootUse.mock.invocationCallOrder[0])
      .toBeLessThan(spawnAndStream.mock.invocationCallOrder[0]);
    expect(cleanupQueue.endRootUse.mock.invocationCallOrder[0])
      .toBeGreaterThan(spawnAndStream.mock.invocationCallOrder[0]);
    expect(cleanupQueue.endRootUse.mock.invocationCallOrder[0])
      .toBeLessThan(cleanupQueue.enqueueRoots.mock.invocationCallOrder[0]);
  });

  it("rewrites sandboxed Bash commands to the user-writable runtime cache", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const cachedRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-runtime\\bash-cache";
    const cachedShell = `${cachedRoot}\\bin\\bash.exe`;
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    prepareSandboxRuntime.mockImplementation((runtimeInfo, options) => {
      expect(options).toEqual(expect.objectContaining({
        kind: "bash",
        hanakoHome: "C:\\Users\\Hana\\.hanako",
      }));
      return {
        ...runtimeInfo,
        bundledRoot: cachedRoot,
        shell: cachedShell,
      };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--writable-root",
      "C:\\work",
      "--",
      cachedShell,
      "-lc",
      "ls && pwd",
    ]));
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain(cachedRoot);
    expect(helperArgs).not.toContain("C:\\Hanako\\resources\\git");
    expect(helperArgs).not.toContain(bundledShell);
  });

  it("emits explicit bash sandbox diagnostics for STATUS_DLL_INIT_FAILED without rerouting default shells", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const cachedRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-runtime\\bash-cache";
    const cachedShell = `${cachedRoot}\\bin\\bash.exe`;
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    spawnAndStream.mockResolvedValueOnce({ exitCode: 3221225794 });
    prepareSandboxRuntime.mockImplementation((runtimeInfo) => ({
      ...runtimeInfo,
      bundledRoot: cachedRoot,
      shell: cachedShell,
    }));

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const chunks = [];
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      const result = await exec("ls && pwd", "C:\\work", {
        onData: (data) => chunks.push(String(data)),
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
      expect(result.exitCode).toBe(3221225794);
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const diagnostic = chunks.join("");
    expect(diagnostic).toContain("STATUS_DLL_INIT_FAILED");
    expect(diagnostic).toContain("<HANA_HOME>\\.ephemeral\\win32-sandbox-runtime\\bash-cache\\bin\\bash.exe");
    expect(diagnostic).toContain("HANA_HOME: <HANA_HOME>");
    expect(diagnostic).not.toContain("C:\\Users\\Hana");
    expect(diagnostic).not.toContain(cachedShell);
    expect(diagnostic).toContain("Default PowerShell/cmd/terminal execution is not changed");
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
  });

  it("emits STATUS_DLL_INIT_FAILED diagnostics for direct cmd without rerouting", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    spawnAndStream.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts.onData(Buffer.from("partial"));
      return { exitCode: 3221225794 };
    });
    const chunks = [];
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    const result = await exec("echo test", "C:\\work", {
      onData: (data) => chunks.push(String(data)),
      signal: undefined,
      timeout: 5,
      env: {
        PATH: "C:\\Windows\\System32;C:\\Hanako\\resources\\git\\bin",
        COMSPEC: systemCmdExe,
        SystemRoot: "C:\\Windows",
        USERPROFILE: "C:\\Users\\Hana",
      },
    });

    expect(result.exitCode).toBe(3221225794);
    const diagnostic = chunks.join("");
    expect(diagnostic).toContain("partial");
    expect(diagnostic).toContain("[win32-exec] cmd runner failed before command output");
    expect(diagnostic).toContain("Exit code: 3221225794 (0xC0000142)");
    expect(diagnostic).toContain("Route: runner=cmd reason=cmd-builtin mode=direct-cmd sandbox=false");
    expect(diagnostic).toContain(`Executable: ${systemCmdExe}`);
    expect(diagnostic).toContain("Output bytes before failure: 7");
    expect(diagnostic).toContain("PATH System32 index: 0");
    expect(diagnostic).toContain("PATH PortableGit index: 1");
    expect(diagnostic).toContain("No fallback was attempted");
    expect(diagnostic).not.toContain("C:\\Users\\Hana");
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
  });

  it("emits STATUS_DLL_INIT_FAILED diagnostics for sandboxed cmd helper failures", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    spawnAndStream.mockResolvedValueOnce({ exitCode: 3221225794 });
    const chunks = [];
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    const result = await exec("echo test", "C:\\work", {
      onData: (data) => chunks.push(String(data)),
      signal: undefined,
      timeout: 5,
      env: {
        PATH: "C:\\Windows\\System32",
        COMSPEC: systemCmdExe,
        SystemRoot: "C:\\Windows",
        HANA_HOME: "C:\\Users\\Hana\\.hanako",
      },
    });

    expect(result.exitCode).toBe(3221225794);
    const diagnostic = chunks.join("");
    expect(diagnostic).toContain("Route: runner=cmd reason=cmd-builtin mode=sandbox-helper sandbox=true");
    expect(diagnostic).toContain(`Helper: ${helper}`);
    expect(diagnostic).toContain("HANA_HOME: <HANA_HOME>");
    expect(diagnostic).not.toContain("C:\\Users\\Hana");
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
  });

  it("emits helper launch diagnostics for sandbox CreateProcessAsUserW failures", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    spawnAndStream.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts.onData(Buffer.from([
        "hana-win-sandbox: CreateProcessAsUserW failed: Access is denied.",
        "hana-win-sandbox: launch-failure error=\"5\" errorHex=\"0x00000005\"",
        "hana-win-sandbox: launch-failure-context executable=\"C:\\Windows\\System32\\cmd.exe\" cwd=\"C:\\work\\project\" commandLine=\"cmd.exe /c dir\"",
      ].join("\n")));
      return { exitCode: 1 };
    });
    const chunks = [];
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work\\project"],
        },
      },
    });

    const result = await exec("dir", "C:\\work\\project", {
      onData: (data) => chunks.push(String(data)),
      signal: undefined,
      timeout: 5,
      env: {
        PATH: "C:\\Windows\\System32",
        COMSPEC: systemCmdExe,
        SystemRoot: "C:\\Windows",
        HANA_HOME: "C:\\Users\\Hana\\.hanako",
        USERPROFILE: "C:\\Users\\Hana",
      },
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = chunks.join("");
    expect(diagnostic).toContain("CreateProcessAsUserW failed");
    expect(diagnostic).toContain("[win32-exec] sandbox helper launch failed before command execution");
    expect(diagnostic).toContain("Route: runner=cmd reason=cmd-builtin mode=sandbox-helper sandbox=true");
    expect(diagnostic).toContain("Native helper reported CreateProcessAsUserW failure");
    expect(diagnostic).toContain("Helper: C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe");
    expect(diagnostic).not.toContain("C:\\Users\\Hana");
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
  });

  it("emits STATUS_DLL_INIT_FAILED diagnostics for sandboxed PowerShell helper failures", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell-command", reason: "default-powershell" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    spawnAndStream.mockResolvedValueOnce({ exitCode: 3221225794 });
    const chunks = [];
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    const result = await exec("Get-Location", "C:\\work", {
      onData: (data) => chunks.push(String(data)),
      signal: undefined,
      timeout: 5,
      env: {
        PATH: "C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
      },
    });

    expect(result.exitCode).toBe(3221225794);
    const diagnostic = chunks.join("");
    expect(diagnostic).toContain("Route: runner=powershell-command reason=default-powershell mode=sandbox-helper sandbox=true");
    expect(diagnostic).toContain("Executable: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(diagnostic).toContain(`Helper: ${helper}`);
    expect(diagnostic).toContain("No fallback was attempted");
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
  });

  it("does not pass network capability flags for restricted-token sandboxed commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
        getSandboxNetworkEnabled: () => true,
      },
    });

    try {
      await exec("curl https://example.com", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--",
      bundledShell,
      "-lc",
      "curl https://example.com",
    ]));
    expect(helperArgs).not.toContain("--network");
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      helperArgs,
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("keeps network unrestricted by default without helper network flags", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("curl https://example.com", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).not.toContain("--network");
  });

  it("rejects sandboxed commands when Windows sandbox networking is explicitly disabled", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
        getSandboxNetworkEnabled: () => false,
      },
    });

    try {
      await expect(exec("curl https://example.com", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      })).rejects.toThrow("does not support network-off mode");
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("rejects sandboxed commands when Windows sandbox networking mode is none", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
        getSandboxNetworkMode: () => "none",
        getSandboxNetworkEnabled: () => true,
      },
    });

    try {
      await expect(exec("curl https://example.com", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      })).rejects.toThrow("does not support network-off mode");
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("does not call obsolete external read path projection for restricted-token grants", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    const getExternalReadPaths = vi.fn(() => ["C:\\outside\\secret.txt"]);
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        policy: {
          mode: "workspace-write",
          workspace: "C:\\work",
          workspaceRoots: ["C:\\work"],
          writablePaths: ["C:\\Users\\Hana\\.hanako\\.ephemeral"],
        },
        getExternalReadPaths,
      },
    });

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(getExternalReadPaths).not.toHaveBeenCalled();
    expect(helperArgs).not.toContain("C:\\outside\\secret.txt");
    expect(helperArgs).not.toContain("--grant-read");
  });

  it("does not fall back to system Git Bash for sandboxed POSIX commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const systemBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === systemBash || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === systemBash && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await expect(exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: {
          PATH: "C:\\Windows\\System32",
          ProgramFiles: "C:\\Program Files",
        },
      })).rejects.toThrow("Sandboxed POSIX commands require bundled");
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).not.toHaveBeenCalled();
  });
});

describe("isShellSpawnError", () => {
  const shellPath = "C:\\Git\\bin\\bash.exe";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    existsSync.mockReturnValue(false);
    mkdirSync.mockImplementation(() => undefined);
    statSync.mockImplementation(() => ({ isDirectory: () => true }));
    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
  });

  async function loadTesting() {
    const mod = await import("../lib/sandbox/win32-exec.ts");
    return mod.__testing as any;
  }

  it("treats ENOENT pointing at the shell as a shell failure when cwd exists", async () => {
    existsSync.mockImplementation((p: any) => p === "C:\\work");
    const { isShellSpawnError } = await loadTesting();
    const err = Object.assign(new Error("spawn bash.exe ENOENT"), { code: "ENOENT", path: shellPath });
    expect(isShellSpawnError(err, shellPath, "C:\\work")).toBe(true);
  });

  it("does NOT treat ENOENT as a shell failure when the cwd is missing", async () => {
    existsSync.mockReturnValue(false);
    const { isShellSpawnError } = await loadTesting();
    const err = Object.assign(new Error("spawn bash.exe ENOENT"), { code: "ENOENT", path: shellPath });
    expect(isShellSpawnError(err, shellPath, "C:\\gone")).toBe(false);
  });

  it("rejects ENOENT whose err.path points elsewhere", async () => {
    existsSync.mockReturnValue(true);
    const { isShellSpawnError } = await loadTesting();
    const err = Object.assign(new Error("spawn other.exe ENOENT"), { code: "ENOENT", path: "C:\\other.exe" });
    expect(isShellSpawnError(err, shellPath, "C:\\work")).toBe(false);
  });

  it("treats EACCES as a shell failure regardless of cwd", async () => {
    existsSync.mockReturnValue(false);
    const { isShellSpawnError } = await loadTesting();
    const err = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    expect(isShellSpawnError(err, shellPath, "C:\\gone")).toBe(true);
  });
});
