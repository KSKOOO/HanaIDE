import { beforeEach, describe, expect, it, vi } from 'vitest';

const deskCreateFileInSubdir = vi.fn(async () => true);
const deskMkdirInSubdir = vi.fn(async () => true);

vi.mock('../../stores/desk-actions', () => ({
  deskCreateFileInSubdir,
  deskMkdirInSubdir,
}));

describe('createProjectFromTemplate', () => {
  beforeEach(() => {
    deskCreateFileInSubdir.mockClear();
    deskMkdirInSubdir.mockClear();
  });

  it('creates a basic web project from real workspace file actions', async () => {
    const { createProjectFromTemplate } = await import('../../stores/project-templates');

    await expect(createProjectFromTemplate('basic-web', 'demo-web')).resolves.toBe(true);

    expect(deskMkdirInSubdir).toHaveBeenCalledWith('', 'demo-web');
    expect(deskCreateFileInSubdir).toHaveBeenCalledWith('demo-web', 'index.html', expect.stringContaining('<!doctype html>'));
    expect(deskCreateFileInSubdir).toHaveBeenCalledWith('demo-web', 'styles.css', expect.stringContaining(':root'));
    expect(deskCreateFileInSubdir).toHaveBeenCalledWith('demo-web', 'app.js', expect.stringContaining('HanaIDE'));
  });

  it('rejects unsafe project names before touching the workspace', async () => {
    const { createProjectFromTemplate } = await import('../../stores/project-templates');

    await expect(createProjectFromTemplate('ai-app', '../bad')).resolves.toBe(false);

    expect(deskMkdirInSubdir).not.toHaveBeenCalled();
    expect(deskCreateFileInSubdir).not.toHaveBeenCalled();
  });
});
