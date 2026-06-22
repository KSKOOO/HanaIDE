import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HANA_PDF_FONT_FAMILIES,
  buildFontInjectionCss,
  locateThemesDir,
} from "../desktop/src/office-pdf-fonts.cjs";

const FONTS_CSS = "new-warm-paper-fonts.css";

const SAMPLE_CSS = `/* latin */
@font-face {
  font-family: 'EB Garamond';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('./fonts/ebgaramond-aaa.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+2000-206F;
}
@font-face {
  font-family: 'Noto Serif SC';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('./fonts/notoserifsc-bbb.woff2') format('woff2');
  unicode-range: U+4E00-9FFF;
}
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('./fonts/jetbrainsmono-ccc.woff2') format('woff2');
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 300;
  font-display: swap;
  src: url('./fonts/inter-ddd.woff2') format('woff2');
}
`;

describe("office pdf font injection css", () => {
  let tempDir: string;
  let themesDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-pdf-fonts-"));
    themesDir = path.join(tempDir, "themes");
    fs.mkdirSync(themesDir, { recursive: true });
    fs.writeFileSync(path.join(themesDir, FONTS_CSS), SAMPLE_CSS, "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps only the whitelisted Hana families and drops the rest", () => {
    const css = buildFontInjectionCss({ themesDir });
    expect(css).toContain("'EB Garamond'");
    expect(css).toContain("'Noto Serif SC'");
    expect(css).toContain("'JetBrains Mono'");
    expect(css).not.toContain("Inter");
  });

  it("rewrites relative font urls to absolute file:// urls under themes/fonts", () => {
    const css = buildFontInjectionCss({ themesDir });
    const fontsDirUrl = pathToFileURL(path.join(themesDir, "fonts")).href;
    expect(css).toContain(`url('${fontsDirUrl}/ebgaramond-aaa.woff2')`);
    expect(css).toContain(`url('${fontsDirUrl}/notoserifsc-bbb.woff2')`);
    expect(css).not.toContain("url('./fonts/");
  });

  it("preserves unicode-range and other descriptors verbatim", () => {
    const css = buildFontInjectionCss({ themesDir });
    expect(css).toContain("unicode-range: U+0000-00FF, U+2000-206F;");
    expect(css).toContain("unicode-range: U+4E00-9FFF;");
    expect(css).toContain("font-display: swap;");
  });

  it("fails loudly when a required family is missing from the css", () => {
    const withoutSerif = SAMPLE_CSS.replace(/'Noto Serif SC'/g, "'Some Other Font'");
    fs.writeFileSync(path.join(themesDir, FONTS_CSS), withoutSerif, "utf-8");
    expect(() => buildFontInjectionCss({ themesDir })).toThrow(/Noto Serif SC/);
  });

  it("exposes the family whitelist as the single source for callers and tests", () => {
    expect(HANA_PDF_FONT_FAMILIES).toEqual(["EB Garamond", "Noto Serif SC", "JetBrains Mono"]);
  });

  describe("locateThemesDir", () => {
    it("returns the first candidate containing the fonts css", () => {
      const empty = path.join(tempDir, "empty");
      fs.mkdirSync(empty, { recursive: true });
      expect(locateThemesDir([empty, themesDir])).toBe(themesDir);
      expect(locateThemesDir([themesDir, empty])).toBe(themesDir);
    });

    it("fails loudly when no candidate has the fonts css", () => {
      const empty = path.join(tempDir, "empty");
      fs.mkdirSync(empty, { recursive: true });
      expect(() => locateThemesDir([empty])).toThrow(/new-warm-paper-fonts\.css/);
    });
  });

  describe("real font source integrity", () => {
    it("extracts all three Hana families from the real themes css", () => {
      const realThemesDir = path.join(__dirname, "..", "desktop", "src", "themes");
      const css = buildFontInjectionCss({ themesDir: realThemesDir });
      for (const family of HANA_PDF_FONT_FAMILIES) {
        expect(css).toContain(`'${family}'`);
      }
      expect(css).toContain("unicode-range:");
      expect(css).not.toContain("url('./fonts/");
      expect(css).not.toContain("Inter");
    });
  });

  describe("packaging contract", () => {
    it("ships office-pdf-fonts.cjs in the electron-builder files list", () => {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
      );
      expect(pkg.build.files).toContain("desktop/src/office-pdf-fonts.cjs");
      expect(pkg.build.files).toContain("desktop/src/office-pdf-helper.cjs");
    });
  });
});
