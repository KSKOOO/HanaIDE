import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectBundledPluginPackageDependencies,
  collectBundledPluginRuntimeDependencies,
  copyBundledPluginRuntimeDependencies,
} from "../scripts/build-server-plugin-runtime-deps.mjs";

describe("bundled plugin runtime dependencies", () => {
  let tempDir;
  let rootDir;
  let outDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-runtime-deps-"));
    rootDir = path.join(tempDir, "root");
    outDir = path.join(tempDir, "dist-server", "mac-arm64");

    fs.mkdirSync(path.join(rootDir, "plugins", "mcp", "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "mcp", "index.js"),
      'import { loadRuntime } from "./lib/mcp-runtime.js";\nexport default loadRuntime;\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "plugins", "mcp", "lib", "mcp-runtime.js"),
      'import { createSettingsUpdate } from "../../../lib/tools/settings-update-result.ts";\nexport function loadRuntime() { return createSettingsUpdate; }\n',
      "utf-8",
    );

    fs.mkdirSync(path.join(rootDir, "plugins", "image-gen", "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "image-gen", "lib", "local-cli-wrapper.js"),
      'import { buildCliArgs } from "../../../core/media-runtime-contract.ts";\nexport { buildCliArgs };\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "plugins", "image-gen", "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "image-gen", "tests", "fixture.test.js"),
      'import "../../../server/test-only.js";\n',
      "utf-8",
    );

    fs.mkdirSync(path.join(rootDir, "lib", "tools"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "lib", "tools", "settings-update-result.ts"),
      'import { redactLogText } from "../../shared/log-redactor.ts";\nexport function createSettingsUpdate(value?) { return redactLogText(value || "ok"); }\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "shared"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "shared", "log-redactor.ts"),
      "export function redactLogText(value) { return value; }\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "core"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "core", "media-runtime-contract.ts"),
      "export function buildCliArgs() { return []; }\n",
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("copies host modules imported by bundled plugin source into the packaged server root", async () => {
    const deps = await collectBundledPluginRuntimeDependencies({ rootDir });

    expect(deps).toEqual([
      path.join("core", "media-runtime-contract.ts"),
      path.join("lib", "tools", "settings-update-result.ts"),
      path.join("shared", "log-redactor.ts"),
    ]);

    const copied = await copyBundledPluginRuntimeDependencies({ rootDir, outDir });

    expect(copied).toEqual(deps);
    expect(fs.readFileSync(path.join(outDir, "lib", "tools", "settings-update-result.ts"), "utf-8"))
      .toContain("createSettingsUpdate");
    expect(fs.readFileSync(path.join(outDir, "core", "media-runtime-contract.ts"), "utf-8"))
      .toContain("buildCliArgs");
    expect(fs.readFileSync(path.join(outDir, "shared", "log-redactor.ts"), "utf-8"))
      .toContain("redactLogText");
    expect(fs.existsSync(path.join(outDir, "plugins", "mcp", "index.js"))).toBe(false);
  });

  it("includes host modules used by the bundled media generation plugin", async () => {
    const deps = await collectBundledPluginRuntimeDependencies({ rootDir: path.resolve(".") });

    expect(deps).toEqual(expect.arrayContaining([
      path.join("core", "media", "media-parameters.ts"),
      path.join("lib", "i18n.ts"),
    ]));
  });

  it("collects npm packages imported by bundled plugin source for packaged server installs", async () => {
    fs.mkdirSync(path.join(rootDir, "plugins", "beautify", "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "beautify", "index.js"),
      'import "./lib/markdown-cover-service.js";\nexport default class Beautify {}\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "plugins", "beautify", "lib", "markdown-cover-service.js"),
      'import YAML from "js-yaml";\nexport function parse(value) { return YAML.load(value); }\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "node_modules", "js-yaml"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "node_modules", "js-yaml", "package.json"),
      JSON.stringify({ name: "js-yaml", version: "4.1.0", main: "index.js" }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "node_modules", "js-yaml", "index.js"),
      "export default { load() { return {}; } };\n",
      "utf-8",
    );

    await expect(collectBundledPluginPackageDependencies({ rootDir }))
      .resolves.toContain("js-yaml");
  });

  it("collects the Office PDF reader package import for packaged server installs", async () => {
    fs.mkdirSync(path.join(rootDir, "plugins", "office", "lib"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "plugins", "office", "tools"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "office", "tools", "read-document.ts"),
      'import { readPdfDocument } from "../lib/read-pdf.ts";\nexport const read = readPdfDocument;\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "plugins", "office", "lib", "read-pdf.ts"),
      'export async function readPdfDocument() { const { getDocumentProxy } = await import("unpdf"); return getDocumentProxy; }\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "node_modules", "unpdf"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "node_modules", "unpdf", "package.json"),
      JSON.stringify({ name: "unpdf", version: "1.6.2", type: "module", exports: "./index.mjs" }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "node_modules", "unpdf", "index.mjs"),
      "export function getDocumentProxy() {}\n",
      "utf-8",
    );

    await expect(collectBundledPluginPackageDependencies({ rootDir }))
      .resolves.toContain("unpdf");
  });

  it("collects npm packages imported by host modules reached from bundled plugins", async () => {
    fs.mkdirSync(path.join(rootDir, "lib", "i18n"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "mcp", "index.js"),
      'import { t } from "../../lib/i18n/index.ts";\nexport default t;\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "lib", "i18n", "index.ts"),
      'import YAML from "js-yaml";\nexport function t(value?) { return YAML.dump({ value }); }\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "node_modules", "js-yaml"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "node_modules", "js-yaml", "package.json"),
      JSON.stringify({ name: "js-yaml", version: "4.1.0", main: "index.js" }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, "node_modules", "js-yaml", "index.js"),
      "export default { dump() { return ''; } };\n",
      "utf-8",
    );

    await expect(collectBundledPluginPackageDependencies({ rootDir }))
      .resolves.toContain("js-yaml");
  });

  it("rejects plugin imports into host paths that are not explicit runtime surfaces", async () => {
    fs.mkdirSync(path.join(rootDir, "plugins", "bad"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "plugins", "bad", "index.js"),
      'import "../../server/private.ts";\n',
      "utf-8",
    );
    fs.mkdirSync(path.join(rootDir, "server"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "server", "private.ts"), "export {};\n", "utf-8");

    await expect(collectBundledPluginRuntimeDependencies({ rootDir }))
      .rejects.toThrow(/server[/\\]private\.ts/);
  });
});
