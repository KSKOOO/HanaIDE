import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

describe("scripts/launch.js cli", () => {
  it("starts the source CLI from an arbitrary current working directory", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hana-launch-cwd-"));
    try {
      const result = spawnSync(process.execPath, [
        path.join(process.cwd(), "scripts", "launch.js"),
        "cli",
        "help",
      ], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          HANA_HOME: path.join(cwd, ".hana-home"),
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("Cannot find module");
      expect(result.stdout).toContain("Usage:");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
