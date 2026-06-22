import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const root = process.cwd();

describe("auto-update lifecycle contract", () => {
  it("does not wire the desktop auto-updater into the app lifecycle", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).not.toContain('require("./auto-updater.cjs")');
    expect(mainSource).not.toContain("initAutoUpdater(");
    expect(mainSource).not.toContain("checkForUpdatesAuto(");
    expect(mainSource).not.toContain("setUpdateChannel(");
    expect(mainSource).not.toContain("checkForUpdates().catch");
    expect(mainSource).not.toContain('installDownloadedUpdate("app-quit")');
    expect(mainSource).not.toContain("getUpdateState().status === \"downloaded\"");
  });
});
