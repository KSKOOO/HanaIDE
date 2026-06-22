import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../settings/Settings.module.css', import.meta.url), 'utf8');
const modalCss = readFileSync(new URL('../../components/SettingsModalShell.module.css', import.meta.url), 'utf8');

function cssRule(source: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('memory viewer layout contract', () => {
  it('keeps long memory content inside a scrollable body', () => {
    expect(cssRule(css, '.memory-viewer-backdrop')).toMatch(/padding:\s*var\(--space-md\);/);
    expect(cssRule(css, '.memory-viewer')).toMatch(/max-height:\s*100%;/);
    expect(cssRule(css, '.memory-viewer')).toMatch(/overflow:\s*hidden;/);

    expect(cssRule(css, '.memory-viewer-body')).toMatch(/flex:\s*1 1 auto;/);
    expect(cssRule(css, '.memory-viewer-body')).toMatch(/min-height:\s*0;/);
    expect(cssRule(css, '.memory-viewer-body')).toMatch(/overflow-y:\s*auto;/);
  });

  it('uses the taller, wider default settings modal size', () => {
    expect(cssRule(modalCss, '.card')).toMatch(/width:\s*min\(884px,\s*calc\(100vw - 2 \* var\(--space-lg\)\)\);/);
    expect(cssRule(modalCss, '.card')).toMatch(/height:\s*min\(840px,\s*calc\(100vh - var\(--space-lg\) - var\(--space-lg\)\)\);/);
  });
});
