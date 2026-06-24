// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { CodingModePage } from '../../components/coding/CodingModePage';
import { archiveSession, createNewSession, switchSession } from '../../stores/session-actions';
import { createProjectFromTemplate } from '../../stores/project-templates';

vi.mock('../../components/PreviewEditor', () => ({
  PreviewEditor: ({ content, mode, language }: { content?: string; mode?: string; language?: string | null }) => (
    <div
      data-testid="coding-preview-editor"
      data-content={content || ''}
      data-mode={mode || ''}
      data-language={language || ''}
    />
  ),
}));

vi.mock('../../components/chat/ChatArea', () => ({
  ChatArea: ({ ignoreWelcome }: { ignoreWelcome?: boolean }) => (
    <section data-testid="coding-chat-area" data-ignore-welcome={String(!!ignoreWelcome)} />
  ),
}));

vi.mock('../../components/InputArea', () => ({
  InputArea: ({ surface, variant }: { surface?: string; variant?: string }) => (
    <section data-testid="coding-input-area" data-surface={surface || 'desktop'} data-variant={variant || 'default'} />
  ),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../stores/session-actions', () => ({
  archiveSession: vi.fn(async () => {}),
  createNewSession: vi.fn(async () => {}),
  switchSession: vi.fn(async () => {}),
}));

vi.mock('../../stores/project-templates', () => ({
  PROJECT_TEMPLATES: [
    {
      id: 'basic-web',
      titleKey: 'coding.projectTemplate.templates.basicWeb.title',
      descriptionKey: 'coding.projectTemplate.templates.basicWeb.description',
      previewFile: 'index.html',
      files: [
        { name: 'index.html', content: '<!doctype html>\n<title>Demo</title>' },
        { name: 'styles.css', content: ':root { color-scheme: light; }' },
      ],
    },
    {
      id: 'desktop-app',
      titleKey: 'coding.projectTemplate.templates.desktopApp.title',
      descriptionKey: 'coding.projectTemplate.templates.desktopApp.description',
      previewFile: 'main.js',
      files: [{ name: 'main.js', content: 'console.log("desktop");' }],
    },
    {
      id: 'ai-app',
      titleKey: 'coding.projectTemplate.templates.aiApp.title',
      descriptionKey: 'coding.projectTemplate.templates.aiApp.description',
      previewFile: 'index.js',
      files: [{ name: 'index.js', content: 'console.log("ai");' }],
    },
  ],
  createProjectFromTemplate: vi.fn(async () => true),
  getProjectTemplate: (templateId: string) => [
    {
      id: 'basic-web',
      titleKey: 'coding.projectTemplate.templates.basicWeb.title',
      descriptionKey: 'coding.projectTemplate.templates.basicWeb.description',
      summaryKey: 'coding.projectTemplate.templates.basicWeb.summary',
      previewFile: 'index.html',
      files: [
        { name: 'index.html', content: '<!doctype html>\n<title>Demo</title>' },
        { name: 'styles.css', content: ':root { color-scheme: light; }' },
      ],
    },
    {
      id: 'desktop-app',
      titleKey: 'coding.projectTemplate.templates.desktopApp.title',
      descriptionKey: 'coding.projectTemplate.templates.desktopApp.description',
      summaryKey: 'coding.projectTemplate.templates.desktopApp.summary',
      previewFile: 'main.js',
      files: [{ name: 'main.js', content: 'console.log("desktop");' }],
    },
    {
      id: 'ai-app',
      titleKey: 'coding.projectTemplate.templates.aiApp.title',
      descriptionKey: 'coding.projectTemplate.templates.aiApp.description',
      summaryKey: 'coding.projectTemplate.templates.aiApp.summary',
      previewFile: 'index.js',
      files: [{ name: 'index.js', content: 'console.log("ai");' }],
    },
  ].find(template => template.id === templateId) || null,
}));

const hanaFetchMock = vi.mocked(hanaFetch);
const archiveSessionMock = vi.mocked(archiveSession);
const createNewSessionMock = vi.mocked(createNewSession);
const switchSessionMock = vi.mocked(switchSession);
const createProjectFromTemplateMock = vi.mocked(createProjectFromTemplate);

describe('CodingModePage', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    archiveSessionMock.mockClear();
    createNewSessionMock.mockClear();
    switchSessionMock.mockClear();
    createProjectFromTemplateMock.mockClear();
    createProjectFromTemplateMock.mockResolvedValue(true);
    hanaFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        extensions: [
          {
            id: 'hana-test.command-tools',
            displayName: 'Command Tools',
            publisher: 'hana-test',
            version: '0.1.0',
            enabled: true,
            runtime: { hostKind: 'node-workspace', supported: true, activated: false },
            contributions: {
              commands: [{ command: 'hana.echoWorkspace', title: 'Echo Workspace' }],
              viewsContainers: {
                activitybar: [{ id: 'hana-command-tools', title: 'Command Tools' }],
              },
              views: {
                'hana-command-tools': [{ id: 'hana.commandToolsView', name: 'Command Tools View' }],
              },
            },
          },
        ],
        runtimeCommands: [],
      }),
    } as Response);
    useStore.setState({
      currentSessionPath: 'D:/hana/sessions/main.jsonl',
      currentSessionId: 'sess_main',
      pendingNewSession: false,
      sessions: [
        {
          path: 'D:/hana/sessions/main.jsonl',
          sessionId: 'sess_main',
          title: 'Current coding task',
          firstMessage: 'Current coding task',
          modified: '2026-06-21T10:00:00.000Z',
          messageCount: 2,
          agentId: 'hana',
          agentName: 'HanaIDE',
          cwd: 'D:/hana/workspace',
          pinnedAt: null,
        },
        {
          path: 'D:/hana/sessions/older.jsonl',
          sessionId: 'sess_older',
          title: 'Older task',
          firstMessage: 'Older task',
          modified: '2026-06-20T10:00:00.000Z',
          messageCount: 1,
          agentId: 'hana',
          agentName: 'HanaIDE',
          cwd: 'D:/hana/workspace',
          pinnedAt: null,
        },
      ],
      quotedSelections: [],
      quotedSelection: null,
      quoteCandidate: null,
      selectedFolder: 'D:/hana/workspace',
      deskBasePath: 'D:/hana/workspace',
      deskWorkspaceMountId: null,
      deskWorkspaceLabel: null,
      deskWorkspaceNativeRoot: null,
      deskFiles: [
        { name: 'src', isDir: true },
        { name: 'README.md', isDir: false, size: 12, mtime: '2026-06-21T00:00:00.000Z' },
        { name: 'package.json', isDir: false, size: 42, mtime: '2026-06-21T00:00:00.000Z' },
      ],
      deskTreeFilesByPath: {
        '': [
          { name: 'src', isDir: true },
          { name: 'README.md', isDir: false, size: 12, mtime: '2026-06-21T00:00:00.000Z' },
          { name: 'package.json', isDir: false, size: 42, mtime: '2026-06-21T00:00:00.000Z' },
        ],
      },
      deskExpandedPaths: [],
      deskSelectedPath: '',
      settingsModal: { open: false, activeTab: 'agent' },
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders native coding shell regions without VSCode workbench controls', () => {
    render(<CodingModePage />);

    expect(screen.getByRole('region', { name: 'coding.activityRail' })).toBeInTheDocument();
    expect(screen.getByRole('tree', { name: 'coding.labels.explorer' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'coding.labels.editor' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'coding.labels.panel' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'coding.labels.assistantPanel' })).toBeInTheDocument();
    expect(screen.queryByText('coding.labels.chatPanel')).not.toBeInTheDocument();
    expect(screen.getByTestId('coding-chat-area')).toHaveAttribute('data-ignore-welcome', 'true');
    expect(screen.getByTestId('coding-input-area')).toHaveAttribute('data-surface', 'desktop');
    expect(screen.getByTestId('coding-input-area')).toHaveAttribute('data-variant', 'compact');
    expect(screen.queryByLabelText('coding.chat.context')).not.toBeInTheDocument();
    expect(screen.queryByText(/VSCode workbench/i)).not.toBeInTheDocument();
  });

  it('uses CodeMirror editor integration for the active coding document', () => {
    render(<CodingModePage />);

    expect(screen.getByTestId('coding-preview-editor')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('opens multiple files as editor tabs and closes the active tab', async () => {
    window.platform = {
      readFileSnapshot: vi.fn(async (path: string) => ({
        content: `content:${path}`,
        version: { mtimeMs: 1, size: 1 },
      })),
    } as unknown as typeof window.platform;

    render(<CodingModePage />);

    fireEvent.click(screen.getByRole('treeitem', { name: /README\.md/ }));
    expect(await screen.findByRole('tab', { name: /README\.md/ })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('treeitem', { name: /package\.json/ }));
    expect(await screen.findByRole('tab', { name: /package\.json/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /README\.md/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /package\.json/ }));

    await waitFor(() => expect(screen.queryByRole('tab', { name: /package\.json/ })).not.toBeInTheDocument());
    expect(screen.getByRole('tab', { name: /README\.md/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens Windows shell scripts as editable coding documents', async () => {
    window.platform = {
      readFileSnapshot: vi.fn(async (path: string) => ({
        content: path.endsWith('deploy.ps1') ? 'Write-Host "deploy"' : '@echo off\r\necho build',
        version: { mtimeMs: 1, size: 1 },
      })),
    } as unknown as typeof window.platform;
    useStore.setState({
      deskFiles: [
        { name: 'build.bat', isDir: false, size: 24, mtime: '2026-06-21T00:00:00.000Z' },
        { name: 'deploy.ps1', isDir: false, size: 20, mtime: '2026-06-21T00:00:00.000Z' },
      ],
      deskTreeFilesByPath: {
        '': [
          { name: 'build.bat', isDir: false, size: 24, mtime: '2026-06-21T00:00:00.000Z' },
          { name: 'deploy.ps1', isDir: false, size: 20, mtime: '2026-06-21T00:00:00.000Z' },
        ],
      },
    } as never);

    render(<CodingModePage />);

    fireEvent.click(screen.getByRole('treeitem', { name: /build\.bat/ }));
    expect(await screen.findByRole('tab', { name: /build\.bat/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('coding-preview-editor')).toHaveAttribute('data-content', '@echo off\r\necho build');
    expect(screen.getByTestId('coding-preview-editor')).toHaveAttribute('data-mode', 'code');
    expect(screen.getByTestId('coding-preview-editor')).toHaveAttribute('data-language', 'bat');

    fireEvent.click(screen.getByRole('treeitem', { name: /deploy\.ps1/ }));
    expect(await screen.findByRole('tab', { name: /deploy\.ps1/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('coding-preview-editor')).toHaveAttribute('data-content', 'Write-Host "deploy"');
    expect(screen.getByTestId('coding-preview-editor')).toHaveAttribute('data-mode', 'code');
    expect(screen.getByTestId('coding-preview-editor')).toHaveAttribute('data-language', 'ps1');
  });

  it('opens a folder from the coding explorer toolbar and resets editor tabs', async () => {
    const selectFolder = vi.fn(async () => 'D:/hana/next-workspace');
    window.platform = {
      selectFolder,
      readFileSnapshot: vi.fn(async (path: string) => ({
        content: `content:${path}`,
        version: { mtimeMs: 1, size: 1 },
      })),
    } as unknown as typeof window.platform;

    render(<CodingModePage />);

    fireEvent.click(screen.getByRole('treeitem', { name: /README\.md/ }));
    expect(await screen.findByRole('tab', { name: /README\.md/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'coding.explorer.openFolder' }));

    await waitFor(() => expect(selectFolder).toHaveBeenCalled());
    await waitFor(() => expect(useStore.getState().deskBasePath).toBe('D:/hana/next-workspace'));
    expect(screen.queryByRole('tab', { name: /README\.md/ })).not.toBeInTheDocument();
  });

  it('switches activity rail panels instead of leaving inactive icon buttons', () => {
    render(<CodingModePage />);

    fireEvent.click(screen.getByRole('button', { name: 'coding.activity.search' }));
    expect(screen.getByRole('searchbox', { name: 'coding.search.label' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'coding.activity.run' }));
    expect(screen.getByRole('button', { name: 'coding.run.gitStatus' })).toBeInTheDocument();
  });

  it('opens the settings modal from the activity rail gear without replacing the coding sidebar', () => {
    render(<CodingModePage />);

    fireEvent.click(screen.getByRole('button', { name: 'coding.activity.settings' }));

    expect(useStore.getState().settingsModal).toEqual({ open: true, activeTab: 'agent' });
    expect(screen.getByRole('tree', { name: 'coding.labels.explorer' })).toBeInTheDocument();
    expect(screen.queryByText('coding.settings.workspace')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'coding.activity.settings' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('cleans terminal ANSI control sequences before rendering output', async () => {
    hanaFetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === '/api/terminal/session') {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.action === 'start') {
          return {
            ok: true,
            json: async () => ({
              terminalId: 'term_1',
              seq: 1,
              status: 'running',
              output: '\u001b[?25h\u001b[31mPS\u001b[0m C:\\Users\\ghost\\workspace\r\n',
            }),
          } as Response;
        }
      }
      return {
        ok: true,
        json: async () => ({ extensions: [], runtimeCommands: [] }),
      } as Response;
    });

    render(<CodingModePage />);

    fireEvent.click(screen.getByRole('button', { name: 'coding.terminal.start' }));

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith('/api/terminal/session', expect.anything()));
    const startCall = [...hanaFetchMock.mock.calls].reverse().find(([url, init]) => {
      if (String(url) !== '/api/terminal/session') return false;
      const body = JSON.parse(String(init?.body || '{}'));
      return body.action === 'start';
    });
    expect(JSON.parse(String(startCall?.[1]?.body || '{}'))).toMatchObject({
      profile: 'shell',
      command: '',
      label: 'coding.terminal.profileShell',
    });
    await waitFor(() => {
      expect(screen.getByText(/PS C:\\Users\\ghost\\workspace/)).toBeInTheDocument();
    });
    expect(document.querySelector('[data-hana-terminal-view]')).toBeInTheDocument();
    expect(document.querySelector('pre')).toBeNull();
    expect(document.body.textContent).not.toContain('\u001b');
    expect(document.body.textContent).not.toContain('[?25h');
    expect(document.body.textContent).not.toContain('[31m');
  });

  it('starts and writes to a free workspace terminal without requiring a chat session', async () => {
    hanaFetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === '/api/terminal/session') {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.action === 'start') {
          return {
            ok: true,
            json: async () => ({
              terminalId: 'term_free',
              sessionPath: body.sessionPath,
              seq: 0,
              status: 'running',
              output: 'PS D:\\hana\\workspace>\n',
            }),
          } as Response;
        }
        if (body.action === 'write') {
          return {
            ok: true,
            json: async () => ({
              terminalId: body.terminalId,
              sessionPath: body.sessionPath,
              seq: 1,
              status: 'running',
              output: 'hello\n',
            }),
          } as Response;
        }
      }
      return {
        ok: true,
        json: async () => ({ extensions: [], runtimeCommands: [] }),
      } as Response;
    });
    useStore.setState({
      currentSessionPath: null,
      currentSessionId: null,
      sessions: [],
    } as never);

    render(<CodingModePage />);

    fireEvent.click(screen.getByRole('button', { name: 'coding.terminal.start' }));

    const input = await screen.findByPlaceholderText('coding.terminal.placeholder');
    expect(input).toBeEnabled();
    const startCall = [...hanaFetchMock.mock.calls].reverse().find(([url, init]) => {
      if (String(url) !== '/api/terminal/session') return false;
      return JSON.parse(String(init?.body || '{}')).action === 'start';
    });
    const startBody = JSON.parse(String(startCall?.[1]?.body || '{}'));
    expect(startBody).toMatchObject({
      action: 'start',
      cwd: 'D:/hana/workspace',
      command: '',
      profile: 'shell',
    });
    expect(startBody.sessionPath).toMatch(/^hanaide:\/\/terminal\//);

    fireEvent.change(input, { target: { value: 'echo hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith('/api/terminal/session', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"action":"write"'),
    })));
    const writeCall = [...hanaFetchMock.mock.calls].reverse().find(([url, init]) => {
      if (String(url) !== '/api/terminal/session') return false;
      return JSON.parse(String(init?.body || '{}')).action === 'write';
    });
    expect(JSON.parse(String(writeCall?.[1]?.body || '{}'))).toMatchObject({
      sessionPath: startBody.sessionPath,
      terminalId: 'term_free',
      chars: 'echo hello\n',
    });
  });

  it('starts terminal sessions with the active SSH workspace mount instead of a local cwd', async () => {
    hanaFetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === '/api/terminal/session') {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.action === 'start') {
          return {
            ok: true,
            json: async () => ({
              terminalId: 'term_ssh',
              seq: 0,
              status: 'running',
              output: 'remote ready\n',
            }),
          } as Response;
        }
      }
      return {
        ok: true,
        json: async () => ({ extensions: [], runtimeCommands: [] }),
      } as Response;
    });
    useStore.setState({
      deskWorkspaceMountId: 'ssh_project',
      deskWorkspaceLabel: 'Remote Project',
      deskWorkspaceNativeRoot: null,
      deskBasePath: '',
    } as never);

    render(<CodingModePage />);

    fireEvent.click(screen.getByRole('button', { name: 'coding.terminal.start' }));

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith('/api/terminal/session', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"workspaceMountId":"ssh_project"'),
    })));
  });

  it('adds selected editor text to assistant quotes from the coding panel', async () => {
    window.platform = {
      readFileSnapshot: vi.fn(async (path: string) => ({
        content: `content:${path}`,
        version: { mtimeMs: 1, size: 1 },
      })),
    } as unknown as typeof window.platform;
    const selectedText = 'B.1.3 环境参数对齐偏差校正方法';
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => selectedText,
      rangeCount: 0,
    } as unknown as Selection);

    render(<CodingModePage />);

    fireEvent.click(screen.getByRole('treeitem', { name: /README\.md/ }));
    expect(await screen.findByRole('tab', { name: /README\.md/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'coding.chat.quoteSelection' }));

    expect(useStore.getState().quotedSelections[0]).toMatchObject({
      text: selectedText,
      sourceTitle: 'README.md',
      sourceKind: 'preview',
      sourceFilePath: 'D:/hana/workspace/README.md',
      selectionAnchorKind: 'native',
      charCount: selectedText.length,
    });
  });

  it('renders coding assistant session history with new, switch, and delete actions', () => {
    render(<CodingModePage />);

    expect(screen.getByRole('region', { name: 'coding.chat.history' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'coding.chat.newSession' }));
    expect(createNewSessionMock).toHaveBeenCalledWith({ cwd: 'D:/hana/workspace' });

    fireEvent.click(screen.getByRole('button', { name: 'Older task' }));
    expect(switchSessionMock).toHaveBeenCalledWith('D:/hana/sessions/older.jsonl');

    fireEvent.click(screen.getByRole('button', { name: 'coding.chat.deleteSession Older task' }));
    expect(archiveSessionMock).toHaveBeenCalledWith('D:/hana/sessions/older.jsonl');
  });

  it('places coding assistant session history in the top task strip', () => {
    render(<CodingModePage />);

    expect(screen.getByRole('region', { name: 'coding.chat.history' })).toHaveAttribute('data-coding-session-history', 'top');
  });

  it('expands folders in the coding file tree and opens nested files', async () => {
    window.platform = {
      readFileSnapshot: vi.fn(async (path: string) => ({
        content: `content:${path}`,
        version: { mtimeMs: 1, size: 1 },
      })),
    } as unknown as typeof window.platform;
    useStore.setState({
      deskFiles: [
        { name: 'src', isDir: true },
      ],
      deskTreeFilesByPath: {
        '': [
          { name: 'src', isDir: true },
        ],
        src: [
          { name: 'index.ts', isDir: false, size: 18, mtime: '2026-06-21T00:00:00.000Z' },
        ],
      },
      deskExpandedPaths: [],
    } as never);

    render(<CodingModePage />);

    expect(screen.queryByRole('treeitem', { name: /index\.ts/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('treeitem', { name: /src/ }));

    expect(await screen.findByRole('treeitem', { name: /index\.ts/ })).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(screen.getByRole('treeitem', { name: /index\.ts/ }));

    expect(await screen.findByRole('tab', { name: /index\.ts/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens an in-app project template dialog with description and preview instead of browser prompt', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockImplementation(() => {
      throw new Error('prompt should not be called');
    });

    render(<CodingModePage />);

    window.dispatchEvent(new CustomEvent('hana:coding-command', {
      detail: { action: 'project.createTemplate', command: 'basic-web' },
    }));

    expect(await screen.findByRole('dialog', { name: 'coding.projectTemplate.title' })).toBeInTheDocument();
    expect(screen.getByText('coding.projectTemplate.templates.basicWeb.description')).toBeInTheDocument();
    expect(screen.getByText('coding.projectTemplate.preview')).toBeInTheDocument();
    expect(screen.getByText('coding.projectTemplate.visualPreview.basicWeb.title')).toBeInTheDocument();
    expect(screen.getByText('coding.projectTemplate.visualPreview.basicWeb.action')).toBeInTheDocument();
    expect(screen.getAllByText('index.html').length).toBeGreaterThan(0);
    expect(screen.queryByText(/<!doctype html>/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'coding.projectTemplate.templates.desktopApp.title' }));
    expect(screen.getByText('coding.projectTemplate.templates.desktopApp.description')).toBeInTheDocument();
    expect(screen.getByText('coding.projectTemplate.visualPreview.desktopApp.title')).toBeInTheDocument();
    expect(screen.getAllByText('main.js').length).toBeGreaterThan(0);
    expect(screen.queryByText(/BrowserWindow/)).not.toBeInTheDocument();

    const nameInput = screen.getByLabelText('coding.projectTemplate.namePrompt');
    expect(promptSpy).not.toHaveBeenCalled();
    expect(nameInput).toHaveValue('desktop-app');

    fireEvent.change(nameInput, { target: { value: 'demo-web' } });
    fireEvent.click(screen.getByRole('button', { name: 'coding.projectTemplate.create' }));

    await waitFor(() => expect(createProjectFromTemplateMock).toHaveBeenCalledWith('desktop-app', 'demo-web'));
  });

  it('starts interactive terminal sessions with the selected HanaIDE CLI profile without relying on global hana', async () => {
    hanaFetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === '/api/terminal/session') {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.action === 'start') {
          return {
            ok: true,
            json: async () => ({
              terminalId: 'term_cli',
              seq: 0,
              status: 'running',
              output: 'HanaIDE CLI ready\n',
            }),
          } as Response;
        }
      }
      return {
        ok: true,
        json: async () => ({ extensions: [], runtimeCommands: [] }),
      } as Response;
    });

    render(<CodingModePage />);

    fireEvent.change(screen.getByLabelText('coding.terminal.profile'), { target: { value: 'hana-cli' } });
    fireEvent.click(screen.getByRole('button', { name: 'coding.terminal.start' }));

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith('/api/terminal/session', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"profile":"hana-cli"'),
    })));
    expect(hanaFetchMock).toHaveBeenCalledWith('/api/terminal/session', expect.objectContaining({
      body: expect.not.stringContaining('"command":"hana"'),
    }));
  });

  it('starts non-default terminal profiles through the same integrated terminal UI', async () => {
    hanaFetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === '/api/terminal/session') {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.action === 'start') {
          return {
            ok: true,
            json: async () => ({
              terminalId: 'term_cmd',
              sessionPath: body.sessionPath,
              seq: 0,
              status: 'running',
              output: 'Microsoft Windows [Version]\n',
            }),
          } as Response;
        }
      }
      return {
        ok: true,
        json: async () => ({ extensions: [], runtimeCommands: [] }),
      } as Response;
    });

    render(<CodingModePage />);

    fireEvent.change(screen.getByLabelText('coding.terminal.profile'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByRole('button', { name: 'coding.terminal.start' }));

    const input = await screen.findByPlaceholderText('coding.terminal.placeholder');
    expect(input).toBeEnabled();
    const startCall = [...hanaFetchMock.mock.calls].reverse().find(([url, init]) => {
      if (String(url) !== '/api/terminal/session') return false;
      return JSON.parse(String(init?.body || '{}')).action === 'start';
    });
    const startBody = JSON.parse(String(startCall?.[1]?.body || '{}'));
    expect(startBody).toMatchObject({
      action: 'start',
      command: '',
      profile: 'cmd',
    });
    expect(String(startCall?.[1]?.body || '')).not.toContain('wt.exe');
  });

  it('shows start again after closing so switching terminal profiles can launch a new terminal', async () => {
    let startCount = 0;
    hanaFetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === '/api/terminal/session') {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.action === 'start') {
          startCount += 1;
          return {
            ok: true,
            json: async () => ({
              terminalId: `term_${startCount}`,
              sessionPath: body.sessionPath,
              seq: 0,
              status: 'running',
              output: startCount === 1 ? 'PS D:\\hana\\workspace>\n' : 'Microsoft Windows [Version]\n',
            }),
          } as Response;
        }
        if (body.action === 'close') {
          return {
            ok: true,
            json: async () => ({
              terminalId: body.terminalId,
              sessionPath: body.sessionPath,
              seq: 0,
              status: 'killed',
              output: '',
            }),
          } as Response;
        }
      }
      return {
        ok: true,
        json: async () => ({ extensions: [], runtimeCommands: [] }),
      } as Response;
    });

    render(<CodingModePage />);

    fireEvent.click(screen.getByRole('button', { name: 'coding.terminal.start' }));
    await screen.findByPlaceholderText('coding.terminal.placeholder');
    fireEvent.click(screen.getByRole('button', { name: 'coding.terminal.close' }));

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith('/api/terminal/session', expect.objectContaining({
      body: expect.stringContaining('"action":"close"'),
    })));

    const startAgainButton = await screen.findByRole('button', { name: 'coding.terminal.start' });
    const profileSelect = screen.getByLabelText('coding.terminal.profile');
    fireEvent.change(profileSelect, { target: { value: 'cmd' } });
    await waitFor(() => expect(profileSelect).toHaveValue('cmd'));
    fireEvent.click(startAgainButton);

    await waitFor(() => expect(startCount).toBe(2));
    const startCalls = hanaFetchMock.mock.calls.filter(([url, init]) => {
      if (String(url) !== '/api/terminal/session') return false;
      return JSON.parse(String(init?.body || '{}')).action === 'start';
    });
    const secondStartBody = JSON.parse(String(startCalls.at(-1)?.[1]?.body || '{}'));
    expect(secondStartBody).toMatchObject({
      command: '',
      profile: 'cmd',
    });
  });

  it('opens a file context menu and can add the file to the assistant input', async () => {
    render(<CodingModePage />);

    fireEvent.contextMenu(screen.getByRole('treeitem', { name: /README\.md/ }), {
      clientX: 24,
      clientY: 48,
    });

    expect(await screen.findByText('workspace.context.open')).toBeInTheDocument();
    expect(screen.getByText('workspace.context.copyPath')).toBeInTheDocument();
    fireEvent.click(screen.getByText('workspace.context.addToAssistant'));

    expect(useStore.getState().attachedFiles[0]).toMatchObject({
      path: 'D:/hana/workspace/README.md',
      name: 'README.md',
      isDirectory: false,
    });
  });

  it('loads installed VSCode-compatible extensions into the extensions panel', async () => {
    render(<CodingModePage />);

    fireEvent.click(screen.getByRole('button', { name: 'coding.activity.extensions' }));

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith('/api/vscode-extensions'));
    expect(await screen.findByText('Command Tools')).toBeInTheDocument();
    expect(screen.getByText('hana-test.command-tools')).toBeInTheDocument();
    const commandButton = screen.getByRole('button', { name: 'Echo Workspace' });
    expect(commandButton).toBeEnabled();
    fireEvent.click(commandButton);

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith('/api/vscode-extensions/runtime/start', expect.anything()));
    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith(
      '/api/vscode-extensions/runtime/commands/hana.echoWorkspace',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(screen.getByRole('button', { name: 'coding.extensions.installVsix' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'coding.extensions.startRuntime' })).toBeInTheDocument();
  });

  it('uninstalls installed VSCode-compatible extensions from the extensions panel', async () => {
    render(<CodingModePage />);

    fireEvent.click(screen.getByRole('button', { name: 'coding.activity.extensions' }));

    expect(await screen.findByText('Command Tools')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'coding.extensions.uninstall' }));

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith(
      '/api/vscode-extensions/hana-test.command-tools',
      expect.objectContaining({ method: 'DELETE' }),
    ));
    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith('/api/vscode-extensions'));
  });

  it('surfaces installed extension activity views in the coding activity rail', async () => {
    hanaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/vscode-extensions/runtime/start') {
        return {
          ok: true,
          json: async () => ({ activated: ['hana-test.command-tools'], failed: [], commands: [] }),
        } as Response;
      }
      if (url === '/api/vscode-extensions/runtime/views/hana.commandToolsView') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            type: 'webview',
            viewId: 'hana.commandToolsView',
            title: 'Command Tools View',
            html: '<main><h1>Extension host sidebar</h1></main>',
          }),
        } as Response;
      }
      if (url === '/api/vscode-extensions/runtime/views/hana.commandToolsView/messages') {
        return {
          ok: true,
          json: async () => ({ ok: true, viewId: 'hana.commandToolsView' }),
        } as Response;
      }
      if (url === '/api/vscode-extensions/runtime/commands/hana.echoWorkspace') {
        return {
          ok: true,
          json: async () => ({ ok: true, command: 'hana.echoWorkspace', result: 'D:/hana/workspace' }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          extensions: [
            {
              id: 'hana-test.command-tools',
              displayName: 'Command Tools',
              publisher: 'hana-test',
              version: '0.1.0',
              enabled: true,
              runtime: { hostKind: 'node-workspace', supported: true, activated: false },
              contributions: {
                commands: [{ command: 'hana.echoWorkspace', title: 'Echo Workspace' }],
                viewsContainers: {
                  activitybar: [{ id: 'hana-command-tools', title: 'Command Tools' }],
                },
                views: {
                  'hana-command-tools': [{ id: 'hana.commandToolsView', name: 'Command Tools View' }],
                },
              },
            },
          ],
          runtimeCommands: [],
        }),
      } as Response;
    });
    render(<CodingModePage />);

    fireEvent.click(screen.getByRole('button', { name: 'coding.activity.extensions' }));

    expect(await screen.findByText('Command Tools')).toBeInTheDocument();
    const contributedActivity = await screen.findByRole('button', { name: 'Command Tools' });
    expect(contributedActivity).toBeInTheDocument();

    fireEvent.click(contributedActivity);

    expect(screen.getByText('Command Tools View')).toBeInTheDocument();
    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith(
      '/api/vscode-extensions/runtime/views/hana.commandToolsView',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(await screen.findByTitle('Command Tools View')).toHaveAttribute('srcDoc', expect.stringContaining('Extension host sidebar'));
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        source: 'hanaide-webview',
        viewId: 'hana.commandToolsView',
        message: { kind: 'ready' },
      },
    }));
    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith(
      '/api/vscode-extensions/runtime/views/hana.commandToolsView/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: { kind: 'ready' } }),
      }),
    ));
    const commandButton = screen.getByRole('button', { name: 'Echo Workspace' });
    expect(commandButton).toBeEnabled();
    fireEvent.click(commandButton);

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith(
      '/api/vscode-extensions/runtime/commands/hana.echoWorkspace',
      expect.objectContaining({ method: 'POST' }),
    ));
  });
});
