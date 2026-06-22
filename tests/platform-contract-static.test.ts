import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = process.cwd();

function objectLiteralKeys(source: string, marker: string) {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const objectStart = source.indexOf("{", start);
  expect(objectStart).toBeGreaterThan(start);
  let depth = 0;
  let objectEnd = -1;
  for (let i = objectStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) {
      objectEnd = i;
      break;
    }
  }
  expect(objectEnd).toBeGreaterThan(objectStart);
  const body = source.slice(objectStart + 1, objectEnd);
  return [...body.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*:/gm)].map((match) => match[1]);
}

describe("desktop platform IPC contract", () => {
  it("keeps shared channel constants as the source for preload and main registrations", () => {
    const contract = require("../desktop/src/shared/platform-contract.cjs");
    const preloadSource = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf-8");
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const contractTypesSource = fs.readFileSync(path.join(root, "desktop", "src", "shared", "platform-contract-types.ts"), "utf-8");
    const platformTypesSource = fs.readFileSync(path.join(root, "desktop", "src", "react", "types.ts"), "utf-8");
    const mobileFallbackSource = fs.readFileSync(path.join(root, "desktop", "src", "react", "mobile", "mobile-platform.ts"), "utf-8");
    const webFallbackSource = fs.readFileSync(path.join(root, "desktop", "src", "modules", "platform.js"), "utf-8");

    expect(contract.HANA_IPC_CHANNELS.getServerPort).toBe("get-server-port");
    expect(contract.HANA_IPC_CHANNELS.openSettings).toBe("open-settings");
    expect(contract.HANA_IPC_EVENTS.settingsChanged).toBe("settings-changed");
    expect(contract.HANA_PLATFORM_INVOKE_METHODS.get("getServerPort")).toBe("get-server-port");
    expect(contract.HANA_PLATFORM_INVOKE_METHODS.get("screenshotRender")).toBe("screenshot-render");
    expect(contract.HANA_PLATFORM_EVENT_METHODS.get("onSettingsChanged")).toBe("settings-changed");

    expect(preloadSource).toContain("HANA_IPC_CHANNELS");
    expect(preloadSource).toContain("HANA_IPC_EVENTS");
    expect(preloadSource).toContain("invokeChannel(\"getServerPort\"");
    expect(preloadSource).toContain("eventChannel(\"onSettingsChanged\"");
    expect(mainSource).toContain("HANA_IPC_CHANNELS");
    expect(mainSource).toContain("wrapIpcHandler(HANA_IPC_CHANNELS.getServerPort");
    expect(mainSource).toContain("wrapIpcBestEffortHandler(HANA_IPC_CHANNELS.openSettings");

    const contractTypeNames = new Set([...contractTypesSource.matchAll(/\|\s+"([^"]+)"/g)].map((match) => match[1]));
    expect([...contract.HANA_PLATFORM_METHOD_NAMES].sort()).toEqual([...contractTypeNames].sort());
    expect(platformTypesSource).toContain("extends HanaPlatformMethodContract");
    expect(platformTypesSource).toContain("screenshotRender?");
    expect(mobileFallbackSource).toContain("HanaPlatformMobileFallbackMethodName");
    expect(webFallbackSource).toContain("HanaPlatformWebFallbackMethodName");
    expect(objectLiteralKeys(webFallbackSource, "const webPlatform =").sort()).toEqual(
      [...contract.HANA_PLATFORM_WEB_FALLBACK_METHODS].sort(),
    );
    expect(objectLiteralKeys(mobileFallbackSource, "const api:").sort()).toEqual(
      [...contract.HANA_PLATFORM_MOBILE_FALLBACK_METHODS].sort(),
    );

    const namesFromPreload = (pattern: RegExp) => [...preloadSource.matchAll(pattern)].map((match) => match[1]);
    expect(namesFromPreload(/invokeChannel\("([^"]+)"\)/g).filter((name) => !contract.HANA_PLATFORM_INVOKE_METHODS.has(name))).toEqual([]);
    expect(namesFromPreload(/sendChannel\("([^"]+)"\)/g).filter((name) => !contract.HANA_PLATFORM_SEND_METHODS.has(name))).toEqual([]);
    expect(namesFromPreload(/eventChannel\("([^"]+)"\)/g).filter((name) => !contract.HANA_PLATFORM_EVENT_METHODS.has(name))).toEqual([]);
  });
});
