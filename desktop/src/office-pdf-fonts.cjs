/**
 * office PDF 渲染的 Hana 字体注入素材。
 *
 * PDF helper 的 Chromium 窗口加载的是裸 HTML，app 打包字体不在系统字体表里，
 * 不注入则 printToPDF 嵌入的是回退字体（宋体 / Times）。本模块从字体 CSS
 * 真值源提取白名单字体族的 @font-face，把相对 url 重写为绝对 file:// URL，
 * 供 helper 以 insertCSS 注入；Chromium 按 unicode-range 惰性加载，printToPDF
 * 只嵌实际用到的字形子集。
 *
 * 无 electron 依赖，可直接被 vitest 加载。
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const FONTS_CSS_FILENAME = "new-warm-paper-fonts.css";

// 生成 HTML 的衬线 / 等宽字体栈实际引用的三族；UI 无衬线走 system-ui，无需注入。
const HANA_PDF_FONT_FAMILIES = ["EB Garamond", "Noto Serif SC", "JetBrains Mono"];

/**
 * 字体 CSS 的候选目录，按优先级排列。两种布局都与本文件的相对位置稳定：
 * - 开发：desktop/src/themes/（源文件，永远最新）
 * - 打包：asar 内 desktop/dist-renderer/themes/（copyLegacyFiles 复制的产物，
 *   主题切换机制同样依赖这条非 hash 路径，受契约保护）
 * 源目录不进打包（builder files 的 glob 不含 css/woff2），产物目录是生产唯一来源。
 */
function defaultThemesDirCandidates() {
  return [
    path.join(__dirname, "themes"),
    path.join(__dirname, "..", "dist-renderer", "themes"),
  ];
}

function locateThemesDir(candidates = defaultThemesDirCandidates()) {
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, FONTS_CSS_FILENAME))) return dir;
  }
  throw new Error(
    `Hana font css (${FONTS_CSS_FILENAME}) not found; looked in: ${candidates.join(", ")}. ` +
    "Run build:renderer or check the packaged resources.",
  );
}

function extractFontFaceBlocks(css) {
  return css.match(/@font-face\s*\{[^}]*\}/g) || [];
}

function familyOf(block) {
  const match = block.match(/font-family:\s*(['"]?)([^;'"]+)\1\s*;/);
  return match ? match[2].trim() : null;
}

function rewriteFontUrls(block, fontsDirUrl) {
  return block.replace(
    /url\(\s*(['"]?)\.\/fonts\/([^)'"]+)\1\s*\)/g,
    (_match, _quote, file) => `url('${fontsDirUrl}/${file}')`,
  );
}

/**
 * 构建可注入的 @font-face CSS。白名单任一族缺失即抛错：宁可 PDF 转换失败，
 * 也不静默产出回退字体的 PDF。
 */
function buildFontInjectionCss({ themesDir = locateThemesDir(), families = HANA_PDF_FONT_FAMILIES } = {}) {
  const cssPath = path.join(themesDir, FONTS_CSS_FILENAME);
  const css = fs.readFileSync(cssPath, "utf-8");
  const fontsDirUrl = pathToFileURL(path.join(themesDir, "fonts")).href;
  const wanted = new Set(families);
  const blocks = extractFontFaceBlocks(css)
    .filter((block) => wanted.has(familyOf(block)))
    .map((block) => rewriteFontUrls(block, fontsDirUrl));
  const covered = new Set(blocks.map(familyOf));
  const missing = families.filter((family) => !covered.has(family));
  if (missing.length > 0) {
    throw new Error(`Hana font css at ${cssPath} is missing families: ${missing.join(", ")}`);
  }
  return blocks.join("\n");
}

module.exports = {
  FONTS_CSS_FILENAME,
  HANA_PDF_FONT_FAMILIES,
  buildFontInjectionCss,
  locateThemesDir,
};
