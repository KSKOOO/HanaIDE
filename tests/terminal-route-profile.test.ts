import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { __testing } from "../server/routes/terminal.ts";

describe("terminal route profile command resolution", () => {
  it("resolves HanaIDE CLI without relying on a global hana executable", () => {
    const productDir = path.join(process.cwd(), "lib");

    const command = __testing.resolveTerminalProfileStartupCommand({
      startupCommand: "",
      profile: "hana-cli",
      engine: { productDir },
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
    });

    const entry = path.join(process.cwd(), "cli", "entry.ts");
    expect(fs.existsSync(entry)).toBe(true);
    expect(command).toContain(entry);
    expect(command).not.toContain("scripts");
    expect(command).not.toContain("launch.js");
    expect(command).not.toBe("hana");
  });

  it("keeps the default shell profile as a free terminal", () => {
    expect(__testing.resolveTerminalProfileCommand({
      command: "",
    })).toBe("");
    expect(__testing.resolveTerminalProfileCommand({
      command: "",
    })).toBe("");
  });

  it("prefers the bundled CLI entry in packaged server roots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cli-root-"));
    try {
      const libDir = path.join(root, "lib");
      const bundleDir = path.join(root, "bundle");
      fs.mkdirSync(libDir, { recursive: true });
      fs.mkdirSync(bundleDir, { recursive: true });
      const bundledCli = path.join(bundleDir, "cli.js");
      fs.writeFileSync(bundledCli, "console.log('cli');\n");

      const command = __testing.resolveTerminalProfileStartupCommand({
        startupCommand: "",
        profile: "hana-cli",
        engine: { productDir: libDir },
        platform: "win32",
        execPath: "C:\\HanaIDE\\resources\\server\\hana-server.exe",
      });

      expect(command).toContain("hana-server.exe");
      expect(command).toContain(bundledCli);
      expect(command).not.toContain("scripts");
      expect(command).not.toContain("launch.js");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
