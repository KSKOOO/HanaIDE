import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const root = process.cwd();

describe("auto-updater disabled contract", () => {
  it("does not ship an updater module or dependency", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

    expect(fs.existsSync(path.join(root, "desktop", "auto-updater.cjs"))).toBe(false);
    expect(packageJson.dependencies || {}).not.toHaveProperty("electron-updater");
  });

  it("does not expose update checks through the desktop bridge", () => {
    const preloadSource = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf-8");
    const typesSource = fs.readFileSync(path.join(root, "desktop", "src", "react", "types.ts"), "utf-8");
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(preloadSource).not.toContain("checkUpdate");
    expect(preloadSource).not.toContain("check-update");
    expect(typesSource).not.toContain("checkUpdate");
    expect(mainSource).not.toContain("check-update");
  });
});
