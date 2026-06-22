import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-mobile-static-"));
}

describe("mobile static route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("serves the mobile renderer entry from /mobile without allowing traversal", async () => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "lib"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "themes"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "locales"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "mobile.html"), "<!doctype html><title>Mobile</title>", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "assets", "mobile.js"), "console.log('mobile')", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "lib", "i18n.js"), "window.t = () => ''", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "themes", "warm-paper.css"), ":root{}", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "locales", "zh.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "icon.png"), "png", "utf-8");
    const { createMobileStaticRoute } = await import("../server/routes/mobile-static.ts");
    const app = new Hono();
    app.route("", createMobileStaticRoute({ distDir: tmpDir }));

    const entry = await app.request("/mobile/");
    expect(entry.status).toBe(200);
    expect(entry.headers.get("content-type")).toContain("text/html");
    expect(await entry.text()).toContain("<title>Mobile</title>");

    const asset = await app.request("/mobile/assets/mobile.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");

    const icon = await app.request("/mobile/icon.png");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/png");

    expect((await app.request("/mobile/lib/i18n.js")).status).toBe(200);
    expect((await app.request("/mobile/themes/warm-paper.css")).status).toBe(200);
    expect((await app.request("/mobile/locales/zh.json")).status).toBe(200);

    const traversal = await app.request("/mobile/assets/../mobile.html");
    expect(traversal.status).toBe(404);
  });

  it("serves the same PWA shell from /desktop for browser access on another computer", async () => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "mobile.html"), "<!doctype html><title>Mobile</title>", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "assets", "mobile.js"), "console.log('mobile')", "utf-8");
    const { createMobileStaticRoute } = await import("../server/routes/mobile-static.ts");
    const app = new Hono();
    app.route("", createMobileStaticRoute({ distDir: tmpDir }));

    const entry = await app.request("/desktop/");
    expect(entry.status).toBe(200);
    expect(entry.headers.get("cache-control")).toBe("no-cache");
    expect(await entry.text()).toContain("<title>Mobile</title>");

    const indexAlias = await app.request("/desktop/index.html");
    expect(indexAlias.status).toBe(200);
    expect(await indexAlias.text()).toContain("<title>Mobile</title>");

    const asset = await app.request("/desktop/assets/mobile.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");

    const traversal = await app.request("/desktop/assets/../mobile.html");
    expect(traversal.status).toBe(404);
  });
});
