import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { guessMime } from "../http/file-content.ts";

export function createMobileStaticRoute({ distDir }: { distDir?: string } = {}) {
  if (!distDir) throw new Error("distDir required");
  const route = new Hono();

  registerWebClientRoute(route, "/mobile", distDir, "mobile.html");
  registerWebClientRoute(route, "/desktop", distDir, "mobile.html");
  registerWebClientRoute(route, "/app", distDir, "index.html");

  return route;
}

function registerWebClientRoute(route, basePath, distDir, entryFile) {
  route.get(basePath, (c) => serveWebClientFile(c, distDir, "", entryFile));
  route.get(`${basePath}/`, (c) => serveWebClientFile(c, distDir, "", entryFile));
  route.get(`${basePath}/*`, (c) => {
    const pattern = new RegExp(`^${basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/?`);
    return serveWebClientFile(c, distDir, c.req.path.replace(pattern, ""), entryFile);
  });
}

function serveWebClientFile(c, distDir, requestPath, entryFile) {
  const relative = !requestPath || requestPath === "index.html"
    ? entryFile
    : safeRelativePath(requestPath);
  if (!relative) return c.body(null, 404);
  const filePath = path.join(distDir, relative);
  const safePath = resolveExistingInside(distDir, filePath);
  if (!safePath) return c.body(null, 404);
  const stat = fs.statSync(safePath);
  if (!stat.isFile()) return c.body(null, 404);
  c.header("Content-Type", guessMime(safePath));
  c.header("Cache-Control", relative === entryFile
    ? "no-cache"
    : "public, max-age=31536000, immutable");
  return c.body(fs.readFileSync(safePath));
}

function safeRelativePath(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(value || ""));
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\\") || decoded.startsWith("/") || decoded.includes("\0")) return null;
  const parts = decoded.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (
    parts[0] !== "assets"
    && parts[0] !== "icons"
    && parts[0] !== "lib"
    && parts[0] !== "modules"
    && parts[0] !== "themes"
    && parts[0] !== "locales"
    && decoded !== "manifest.webmanifest"
    && decoded !== "sw.js"
    && decoded !== "icon.png"
  ) {
    return null;
  }
  return parts.join(path.sep);
}

function resolveExistingInside(root, target) {
  let rootReal;
  let targetReal;
  try {
    rootReal = fs.realpathSync(root);
    targetReal = fs.realpathSync(target);
  } catch {
    return null;
  }
  return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep)
    ? targetReal
    : null;
}
