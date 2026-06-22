import { deskCreateFileInSubdir, deskMkdirInSubdir } from './desk-actions';

export type ProjectTemplateId = 'basic-web' | 'desktop-app' | 'ai-app';

interface ProjectTemplateFile {
  name: string;
  content: string;
}

export interface ProjectTemplate {
  id: ProjectTemplateId;
  titleKey: string;
  descriptionKey: string;
  summaryKey: string;
  previewFile: string;
  files: ProjectTemplateFile[];
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'basic-web',
    titleKey: 'coding.projectTemplate.templates.basicWeb.title',
    descriptionKey: 'coding.projectTemplate.templates.basicWeb.description',
    summaryKey: 'coding.projectTemplate.templates.basicWeb.summary',
    previewFile: 'index.html',
    files: [
      {
        name: 'index.html',
        content: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HanaIDE Web App</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="app">
    <h1>HanaIDE Web App</h1>
    <p>Start editing this project from HanaIDE.</p>
    <button id="runButton">Run</button>
  </main>
  <script src="./app.js"></script>
</body>
</html>
`,
      },
      {
        name: 'styles.css',
        content: `:root {
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #11243d;
  background: #fff7f2;
}

body {
  margin: 0;
}

.app {
  min-height: 100vh;
  display: grid;
  place-content: center;
  gap: 16px;
  padding: 32px;
}

button {
  height: 36px;
  border: 1px solid #f0b7a8;
  border-radius: 6px;
  background: #ffefe8;
  color: #11243d;
}
`,
      },
      {
        name: 'app.js',
        content: `document.getElementById('runButton')?.addEventListener('click', () => {
  console.log('HanaIDE web template is running.');
});
`,
      },
    ],
  },
  {
    id: 'desktop-app',
    titleKey: 'coding.projectTemplate.templates.desktopApp.title',
    descriptionKey: 'coding.projectTemplate.templates.desktopApp.description',
    summaryKey: 'coding.projectTemplate.templates.desktopApp.summary',
    previewFile: 'main.js',
    files: [
      {
        name: 'package.json',
        content: `{
  "name": "hanaide-desktop-app",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "electron ."
  },
  "devDependencies": {
    "electron": "^42.0.0"
  }
}
`,
      },
      {
        name: 'main.js',
        content: `import { app, BrowserWindow } from 'electron';

function createWindow() {
  const win = new BrowserWindow({ width: 1000, height: 720 });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
`,
      },
      {
        name: 'index.html',
        content: `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>HanaIDE Desktop App</title>
<body>
  <h1>HanaIDE Desktop App</h1>
</body>
</html>
`,
      },
    ],
  },
  {
    id: 'ai-app',
    titleKey: 'coding.projectTemplate.templates.aiApp.title',
    descriptionKey: 'coding.projectTemplate.templates.aiApp.description',
    summaryKey: 'coding.projectTemplate.templates.aiApp.summary',
    previewFile: 'index.js',
    files: [
      {
        name: 'package.json',
        content: `{
  "name": "hanaide-ai-app",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "node index.js"
  }
}
`,
      },
      {
        name: '.env.example',
        content: `OPENAI_API_KEY=
MODEL=gpt-5
`,
      },
      {
        name: 'index.js',
        content: `const model = process.env.MODEL || 'gpt-5';

console.log(\`HanaIDE AI app ready. Model: \${model}\`);
`,
      },
      {
        name: 'README.md',
        content: `# HanaIDE AI App

Use this template for agent tools, coding assistants, and local automation.
`,
      },
    ],
  },
];

export function getProjectTemplate(templateId: ProjectTemplateId): ProjectTemplate | null {
  return PROJECT_TEMPLATES.find(item => item.id === templateId) || null;
}

function isSafeProjectName(value: string): boolean {
  const name = value.trim();
  return !!name
    && !name.includes('/')
    && !name.includes('\\')
    && name !== '.'
    && name !== '..'
    && !name.startsWith('.');
}

export async function createProjectFromTemplate(templateId: ProjectTemplateId, projectName: string): Promise<boolean> {
  const template = PROJECT_TEMPLATES.find(item => item.id === templateId);
  const name = projectName.trim();
  if (!template || !isSafeProjectName(name)) return false;
  if (!await deskMkdirInSubdir('', name)) return false;
  for (const file of template.files) {
    if (!await deskCreateFileInSubdir(name, file.name, file.content)) return false;
  }
  return true;
}
