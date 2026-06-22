import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readProjectFile(pathFromRoot: string) {
  return readFileSync(join(process.cwd(), pathFromRoot), 'utf8');
}

describe('settings search sidebar layout', () => {
  it('uses a 180px settings navigation rail', () => {
    const css = readProjectFile('desktop/src/react/settings/Settings.module.css');

    expect(css).toContain('--settings-nav-width: 180px;');
  });

  it('keeps the modal shell wide enough after expanding the navigation rail', () => {
    const css = readProjectFile('desktop/src/react/components/SettingsModalShell.module.css');

    expect(css).toContain('width: min(884px, calc(100vw - 2 * var(--space-lg)));');
  });
});
