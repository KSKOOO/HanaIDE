import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Hub } from "../hub/index.ts";

function readFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...readFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

describe("media generation agent surface", () => {
  it("does not let the Hub shadow native media:generate-image with the old compatibility bridge", () => {
    const engine = {
      setHubCallbacks: () => {},
      setEventBus: () => {},
    };
    const hub = new Hub({ engine } as any);

    expect(hub.eventBus.hasHandler("media:generate-image")).toBe(false);
  });

  it("does not ship old image-gen tools or old agent-visible media skill text", () => {
    expect(fs.existsSync(path.resolve("plugins/image-gen/tools"))).toBe(false);
    expect(fs.existsSync(path.resolve("plugins/image-gen/skills"))).toBe(false);

    const visibleFiles = [
      ...readFiles(path.resolve("plugins/media")),
      ...readFiles(path.resolve("skills2set")),
      path.resolve("plugins/beautify/tools/create-cover.ts"),
      path.resolve("desktop/src/locales/en.json"),
      path.resolve("desktop/src/locales/zh.json"),
      path.resolve("server/routes/desk.ts"),
    ];
    const visibleText = visibleFiles
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");

    expect(visibleText).not.toMatch(/image-gen_generate|image-gen_describe|image-gen-guide|describe-media-options|from image-gen|old image-gen/);
  });
});
