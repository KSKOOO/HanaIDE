import { describe, it, expect } from 'vitest';
import {
  BLOCK_EXTRACTORS,
  extractBlocks,
  resolveMediaGenerationBlocks,
} from '../server/block-extractors.ts';

// ─── stage_files ─────────────────────────────────────────────────────────────

describe('stage_files', () => {
  const extractor = BLOCK_EXTRACTORS.stage_files;

  it('multi-file: returns one block per file', () => {
    const details = {
      files: [
        { filePath: '/a/foo.txt', label: 'foo', ext: 'txt' },
        { filePath: '/a/bar.js', label: 'bar', ext: 'js' },
      ],
    };
    const result = extractor(details);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'file', filePath: '/a/foo.txt', label: 'foo', ext: 'txt' });
    expect(result[1]).toEqual({ type: 'file', filePath: '/a/bar.js', label: 'bar', ext: 'js' });
  });

  it('single-file fallback: uses filePath/label/ext when files is empty', () => {
    const details = { filePath: '/a/readme.md', label: 'readme', ext: 'md' };
    const result = extractor(details);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'file', filePath: '/a/readme.md', label: 'readme', ext: 'md' });
  });

  it('defaults ext to empty string when missing', () => {
    const details = { filePath: '/a/file', label: 'file' };
    const result = extractor(details);
    expect(result[0].ext).toBe('');
  });

  it('preserves session file ids for consumers that need ownership', () => {
    const details = {
      files: [
        { fileId: 'sf_123', filePath: '/a/foo.txt', label: 'foo', ext: 'txt' },
      ],
    };
    const result = extractor(details);
    expect(result[0]).toEqual({
      type: 'file',
      fileId: 'sf_123',
      filePath: '/a/foo.txt',
      label: 'foo',
      ext: 'txt',
    });
  });

  it('restores one file block per delivered SessionFile', () => {
    const details = {
      files: [
        {
          fileId: 'sf_cover',
          filePath: '/cache/cover.png',
          label: 'cover.png',
          ext: 'png',
          mime: 'image/png',
          kind: 'image',
          storageKind: 'external',
          status: 'available',
        },
        {
          fileId: 'sf_alt',
          filePath: '/cache/alt.png',
          label: 'alt.png',
          ext: 'png',
          mime: 'image/png',
          kind: 'image',
          storageKind: 'external',
          status: 'available',
        },
      ],
    };
    const result = extractor(details);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: 'file',
      fileId: 'sf_cover',
      filePath: '/cache/cover.png',
      label: 'cover.png',
      status: 'available',
    });
    expect(result[1]).toMatchObject({
      type: 'file',
      fileId: 'sf_alt',
      filePath: '/cache/alt.png',
      label: 'alt.png',
      status: 'available',
    });
  });

  it('preserves session file lifecycle metadata', () => {
    const details = {
      files: [
        {
          fileId: 'sf_old',
          filePath: '/a/old.png',
          label: 'old.png',
          ext: 'png',
          mime: 'image/png',
          kind: 'image',
          storageKind: 'managed_cache',
          status: 'expired',
          missingAt: 1234,
        },
      ],
    };
    const result = extractor(details);
    expect(result[0]).toEqual({
      type: 'file',
      fileId: 'sf_old',
      filePath: '/a/old.png',
      label: 'old.png',
      ext: 'png',
      mime: 'image/png',
      kind: 'image',
      storageKind: 'managed_cache',
      status: 'expired',
      missingAt: 1234,
    });
  });

  it('preserves session file resource envelopes for remote clients', () => {
    const resource = {
      schemaVersion: 1,
      resourceId: 'res_sf_remote',
      name: 'studios/studio_1/resources/res_sf_remote',
      studioId: 'studio_1',
      type: 'file',
      source: 'session_file',
      fileId: 'sf_remote',
      lifecycle: { status: 'available', missingAt: null },
      storage: { provider: 'session_file', localOnly: true },
      links: {
        self: '/api/resources/res_sf_remote',
        content: '/api/resources/res_sf_remote/content',
      },
    };
    const result = extractor({
      files: [{
        fileId: 'sf_remote',
        filePath: '/a/generated.png',
        label: 'generated.png',
        ext: 'png',
        resource,
      }],
    });

    expect(result[0]).toMatchObject({
      type: 'file',
      fileId: 'sf_remote',
      resource,
    });
  });

  it('empty details: returns empty array', () => {
    const result = extractor({});
    expect(result).toEqual([]);
  });
});

// ─── present_files alias ─────────────────────────────────────────────────────

describe('present_files', () => {
  it('is the same function reference as stage_files', () => {
    expect((BLOCK_EXTRACTORS as any).present_files).toBe(BLOCK_EXTRACTORS.stage_files);
  });

  it('produces identical output to stage_files', () => {
    const details = { filePath: '/a/x.py', label: 'x', ext: 'py' };
    expect((BLOCK_EXTRACTORS as any).present_files(details)).toEqual(BLOCK_EXTRACTORS.stage_files(details));
  });
});

// ─── image-gen media generation ─────────────────────────────────────────────

describe('media generation blocks', () => {
  it('extracts one pending media_generation block per submitted image task', () => {
    const blocks = (extractBlocks as any)('media_generate-image', {
      mediaGeneration: {
        kind: 'image',
        batchId: 'batch-1',
        prompt: 'A small moonlit room',
        tasks: [
          { taskId: 'task-a' },
          { taskId: 'task-b' },
        ],
      },
    });

    expect(blocks).toEqual([
      {
        type: 'media_generation',
        taskId: 'task-a',
        kind: 'image',
        batchId: 'batch-1',
        prompt: 'A small moonlit room',
        status: 'pending',
      },
      {
        type: 'media_generation',
        taskId: 'task-b',
        kind: 'image',
        batchId: 'batch-1',
        prompt: 'A small moonlit room',
        status: 'pending',
      },
    ]);
  });

  it('keeps historical image-gen tool names readable for old sessions', () => {
    const blocks = (extractBlocks as any)('image-gen_generate-image', {
      mediaGeneration: {
        kind: 'image',
        batchId: 'legacy-batch',
        prompt: 'A legacy generated image',
        tasks: [{ taskId: 'legacy-task' }],
      },
    });

    expect(blocks[0]).toMatchObject({
      type: 'media_generation',
      taskId: 'legacy-task',
      kind: 'image',
      batchId: 'legacy-batch',
      status: 'pending',
    });
  });

  it('replaces historical pending media_generation blocks with completed session file blocks', () => {
    const blocks = [{
      type: 'media_generation',
      afterIndex: 4,
      taskId: 'task-a',
      kind: 'image',
      status: 'pending',
    }];
    const results = new Map([[
      'task-a',
      {
        status: 'success',
        result: {
          sessionFiles: [{
            fileId: 'sf_img',
            filePath: '/tmp/generated.png',
            label: 'generated.png',
            ext: 'png',
            mime: 'image/png',
            kind: 'image',
          }],
        },
      },
    ]]);

    expect(resolveMediaGenerationBlocks(blocks, results)).toEqual([{
      type: 'file',
      afterIndex: 4,
      replacesTaskId: 'task-a',
      fileId: 'sf_img',
      filePath: '/tmp/generated.png',
      label: 'generated.png',
      ext: 'png',
      mime: 'image/png',
      kind: 'image',
    }]);
  });

  it('preserves repeated non-replacement file blocks for stage_files delivery history', () => {
    const blocks = [
      {
        type: 'file',
        afterIndex: 1,
        fileId: 'sf_doc',
        filePath: '/tmp/doc.html',
        label: 'doc.html',
        ext: 'html',
      },
      {
        type: 'file',
        afterIndex: 4,
        fileId: 'sf_doc',
        filePath: '/tmp/doc.html',
        label: 'doc.html',
        ext: 'html',
      },
    ];

    expect(resolveMediaGenerationBlocks(blocks)).toEqual(blocks);
  });

  it('does not deduplicate different media generation tasks by output file identity', () => {
    const blocks = [
      {
        type: 'media_generation',
        afterIndex: 1,
        taskId: 'task-a',
        kind: 'image',
        status: 'pending',
      },
      {
        type: 'media_generation',
        afterIndex: 4,
        taskId: 'task-b',
        kind: 'image',
        status: 'pending',
      },
    ];
    const results = new Map([
      ['task-a', {
        status: 'success',
        result: {
          sessionFiles: [{ fileId: 'sf_img', filePath: '/tmp/generated.png', label: 'generated.png', ext: 'png' }],
        },
      }],
      ['task-b', {
        status: 'success',
        result: {
          sessionFiles: [{ fileId: 'sf_img', filePath: '/tmp/generated.png', label: 'generated.png', ext: 'png' }],
        },
      }],
    ]);

    expect(resolveMediaGenerationBlocks(blocks, results)).toEqual([
      {
        type: 'file',
        afterIndex: 1,
        replacesTaskId: 'task-a',
        fileId: 'sf_img',
        filePath: '/tmp/generated.png',
        label: 'generated.png',
        ext: 'png',
      },
      {
        type: 'file',
        afterIndex: 4,
        replacesTaskId: 'task-b',
        fileId: 'sf_img',
        filePath: '/tmp/generated.png',
        label: 'generated.png',
        ext: 'png',
      },
    ]);
  });

  it('resolves each standalone media generation task result only once', () => {
    const standaloneResults = [
      {
        taskId: 'task-a',
        type: 'image-generation',
        status: 'success',
        afterIndex: 1,
        result: {
          sessionFiles: [{ fileId: 'sf_img', filePath: '/tmp/generated.png', label: 'generated.png', ext: 'png' }],
        },
      },
      {
        taskId: 'task-a',
        type: 'image-generation',
        status: 'success',
        afterIndex: 4,
        result: {
          sessionFiles: [{ fileId: 'sf_img', filePath: '/tmp/generated.png', label: 'generated.png', ext: 'png' }],
        },
      },
    ];

    expect(resolveMediaGenerationBlocks([], new Map(), standaloneResults)).toEqual([{
      type: 'file',
      afterIndex: 1,
      replacesTaskId: 'task-a',
      fileId: 'sf_img',
      filePath: '/tmp/generated.png',
      label: 'generated.png',
      ext: 'png',
    }]);
  });

  it('preserves resource links when replacing completed media generation files', () => {
    const resource = {
      schemaVersion: 1,
      resourceId: 'res_sf_img',
      name: 'studios/studio_1/resources/res_sf_img',
      studioId: 'studio_1',
      type: 'file',
      source: 'session_file',
      fileId: 'sf_img',
      lifecycle: { status: 'available', missingAt: null },
      storage: { provider: 'session_file', localOnly: true },
      links: {
        self: '/api/resources/res_sf_img',
        content: '/api/resources/res_sf_img/content',
      },
    };
    const blocks = [{
      type: 'media_generation',
      taskId: 'task-a',
      kind: 'image',
      status: 'pending',
    }];
    const results = new Map([[
      'task-a',
      {
        status: 'success',
        result: {
          sessionFiles: [{
            fileId: 'sf_img',
            filePath: '/tmp/generated.png',
            label: 'generated.png',
            ext: 'png',
            resource,
          }],
        },
      },
    ]]);

    expect(resolveMediaGenerationBlocks(blocks, results)[0]).toMatchObject({
      type: 'file',
      fileId: 'sf_img',
      resource,
    });
  });
});

// ─── create_artifact ─────────────────────────────────────────────────────────

describe('create_artifact', () => {
  const extractor = BLOCK_EXTRACTORS.create_artifact;

  it('normal: returns artifact block with all fields', () => {
    const details = {
      content: 'console.log("hi")',
      artifactId: 'art-1',
      type: 'code',
      title: 'Hello',
      language: 'javascript',
    };
    const result = extractor(details);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'artifact',
      artifactId: 'art-1',
      artifactType: 'code',
      title: 'Hello',
      content: 'console.log("hi")',
      language: 'javascript',
    });
  });

  it('no content: returns null (extractBlocks treats as empty)', () => {
    expect(extractor({})).toBeNull();
    expect(extractor({ artifactId: 'x' })).toBeNull();
  });

  it('preserves generated artifact session file metadata', () => {
    const details = {
      content: '# Plan',
      artifactId: 'art-1',
      type: 'markdown',
      title: 'Plan',
      language: null,
      artifactFile: {
        fileId: 'sf_art',
        filePath: '/cache/plan.md',
        label: 'Plan.md',
        ext: 'md',
        mime: 'text/markdown',
        kind: 'markdown',
        storageKind: 'managed_cache',
        status: 'expired',
        missingAt: 5678,
      },
    };
    const result = extractor(details);
    expect(result[0]).toEqual({
      type: 'artifact',
      artifactId: 'art-1',
      artifactType: 'markdown',
      title: 'Plan',
      content: '# Plan',
      language: null,
      fileId: 'sf_art',
      filePath: '/cache/plan.md',
      label: 'Plan.md',
      ext: 'md',
      mime: 'text/markdown',
      kind: 'markdown',
      storageKind: 'managed_cache',
      status: 'expired',
      missingAt: 5678,
    });
  });
});

// ─── browser ─────────────────────────────────────────────────────────────────

describe('browser', () => {
  const extractor = BLOCK_EXTRACTORS.browser;

  const makeToolResult = (data, mimeType) => ({
    content: [{ type: 'image', data, mimeType }],
  });

  it('screenshot with image data: returns screenshot block', () => {
    const toolResult = makeToolResult('base64data==', 'image/png');
    const result = extractor({ action: 'screenshot' }, toolResult);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'screenshot',
      base64: 'base64data==',
      mimeType: 'image/png',
    });
  });

  it('screenshot without mimeType: defaults to image/jpeg', () => {
    const toolResult = { content: [{ type: 'image', data: 'abc' }] };
    const result = extractor({ action: 'screenshot' }, toolResult);
    expect((result[0] as any).mimeType).toBe('image/jpeg');
  });

  it('non-screenshot action: returns null', () => {
    const toolResult = makeToolResult('base64data==', 'image/png');
    expect(extractor({ action: 'click' }, toolResult)).toBeNull();
    expect(extractor({}, toolResult)).toBeNull();
  });

  it('screenshot but no image block in content: returns null', () => {
    const toolResult = { content: [{ type: 'text', text: 'done' }] };
    expect(extractor({ action: 'screenshot' }, toolResult)).toBeNull();
  });

  it('screenshot but image block has no data: returns null', () => {
    const toolResult = { content: [{ type: 'image' }] };
    expect(extractor({ action: 'screenshot' }, toolResult)).toBeNull();
  });

  it('screenshot but toolResult is null: returns null', () => {
    expect(extractor({ action: 'screenshot' }, null)).toBeNull();
  });
});

// ─── computer session confirmation ─────────────────────────────────────────

describe('computer session confirmation extraction', () => {
  it('rebuilds completed Computer Use app approval confirmations', () => {
    const approval = {
      providerId: 'mock',
      appId: 'app.notes',
      appName: 'Mock Notes',
      scope: 'app',
    };

    const blocks = (extractBlocks as any)('computer', {
      action: 'start',
      confirmation: {
        kind: 'computer_app_approval',
        status: 'confirmed',
        approval,
      },
    });

    expect(blocks).toEqual([{
      type: 'session_confirmation',
      confirmId: '',
      kind: 'computer_app_approval',
      surface: 'input',
      status: 'confirmed',
      title: '允许 Hana 使用电脑',
      body: 'Hana 想控制这个应用来继续当前任务。',
      subject: { label: 'Mock Notes', detail: 'mock · app.notes' },
      severity: 'elevated',
      actions: { confirmLabel: '同意', rejectLabel: '拒绝' },
      payload: { approval },
    }]);
  });
});

// ─── install_skill ────────────────────────────────────────────────────────────

describe('install_skill', () => {
  const extractor = BLOCK_EXTRACTORS.install_skill;

  it('normal: returns skill block', () => {
    const details = { skillName: 'my-skill', skillFilePath: '/skills/my-skill.js' };
    const result = extractor(details);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'skill',
      skillName: 'my-skill',
      skillFilePath: '/skills/my-skill.js',
    });
  });

  it('preserves installed skill session file metadata', () => {
    const details = {
      skillName: 'my-skill',
      skillFilePath: '/skills/my-skill/SKILL.md',
      installedFile: {
        fileId: 'sf_skill',
        filePath: '/skills/my-skill/SKILL.md',
        sessionPath: '/sessions/install.jsonl',
        origin: 'install_skill_output',
      },
    };
    const result = extractor(details);
    expect(result[0]).toMatchObject({
      type: 'skill',
      skillName: 'my-skill',
      skillFilePath: '/skills/my-skill/SKILL.md',
      fileId: 'sf_skill',
      installedFile: {
        fileId: 'sf_skill',
        sessionPath: '/sessions/install.jsonl',
        origin: 'install_skill_output',
      },
    });
  });

  it('skillFilePath defaults to empty string when missing', () => {
    const result = extractor({ skillName: 'foo' });
    expect(result[0].skillFilePath).toBe('');
  });

  it('no skillName: returns null', () => {
    expect(extractor({})).toBeNull();
    expect(extractor({ skillFilePath: '/x' })).toBeNull();
  });
});

// ─── cron ─────────────────────────────────────────────────────────────────────

describe('cron', () => {
  const extractor = BLOCK_EXTRACTORS.cron;

  const jobData = { expression: '0 9 * * *', command: 'remind' };

  it('with jobData and confirmed true: status is approved', () => {
    const result = extractor({ jobData, confirmed: true });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('suggestion_card');
    expect(result[0].status).toBe('approved');
    expect(result[0].detail.jobData).toBe(jobData);
    expect(result[0].confirmId).toBeUndefined();
    expect(result[0].kind).toBe('automation_draft');
  });

  it('with jobData and confirmed undefined: status is approved', () => {
    const result = extractor({ jobData });
    expect(result[0].status).toBe('approved');
  });

  it('confirmed false: status is rejected', () => {
    const result = extractor({ jobData, confirmed: false });
    expect(result[0].status).toBe('rejected');
  });

  it('pending add preserves legacy confirmId for old cron confirmation cards', () => {
    const result = extractor({ action: 'pending_add', jobData, confirmId: 'confirm_async' });
    expect(result[0].status).toBe('pending');
    expect(result[0].confirmId).toBe('confirm_async');
  });

  it('no jobData: returns null', () => {
    expect(extractor({})).toBeNull();
    expect(extractor({ confirmed: true })).toBeNull();
  });
});

describe('automation', () => {
  const extractor = BLOCK_EXTRACTORS.automation;

  const jobData = { type: 'cron', schedule: '0 12 * * *', label: 'Tea', prompt: 'notify' };

  it('pending add with jobData returns an automation suggestion card', () => {
    const result = extractor({
      action: 'pending_add',
      jobData,
      suggestionId: 'automation_suggestion_1',
      suggestionShortCode: '3827',
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('suggestion_card');
    expect(result[0].kind).toBe('automation_draft');
    expect(result[0].operation).toBe('create');
    expect(result[0].status).toBe('pending');
    expect(result[0].suggestionId).toBe('automation_suggestion_1');
    expect(result[0].suggestionShortCode).toBe('3827');
    expect(result[0].confirmId).toBeUndefined();
    expect(result[0].detail.jobData).toBe(jobData);
    expect(result[0].actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'reject' }),
    ]));
  });

  it('pending update with jobData returns an update automation suggestion card', () => {
    const result = extractor({
      action: 'pending_update',
      operation: 'update',
      jobData: { ...jobData, id: 'job_1' },
      suggestionId: 'automation_suggestion_update',
      suggestionShortCode: '7008',
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('suggestion_card');
    expect(result[0].kind).toBe('automation_draft');
    expect(result[0].operation).toBe('update');
    expect(result[0].status).toBe('pending');
    expect(result[0].suggestionId).toBe('automation_suggestion_update');
    expect(result[0].suggestionShortCode).toBe('7008');
    expect(result[0].confirmId).toBeUndefined();
    expect(result[0].detail.operation).toBe('update');
  });

  it('confirmed add does not duplicate the live confirmation card', () => {
    expect(extractor({ action: 'added', confirmed: true, jobData })).toBeNull();
  });
});

// ─── update_settings ─────────────────────────────────────────────────────────

describe('update_settings', () => {
  const extractor = BLOCK_EXTRACTORS.update_settings;

  it('with settingsUpdate details: returns settings_update block', () => {
    const settingsUpdate = {
      status: 'applied',
      action: 'core.apply',
      key: 'locale',
      title: 'Locale updated',
      summary: 'Locale changed.',
      changes: [
        { key: 'locale', label: 'Locale', before: 'zh-CN', after: 'en' },
      ],
    };

    expect(extractor({ settingsUpdate })).toEqual([
      {
        type: 'settings_update',
        update: settingsUpdate,
      },
    ]);
  });

  it('with settingKey and all fields: returns settings_confirm block', () => {
    const details = {
      settingKey: 'theme',
      cardType: 'select',
      currentValue: 'light',
      proposedValue: 'dark',
      label: 'Theme',
    };
    const result = extractor(details);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'settings_confirm',
      confirmId: '',
      settingKey: 'theme',
      cardType: 'select',
      currentValue: 'light',
      proposedValue: 'dark',
      label: 'Theme',
      status: 'confirmed',
    });
  });

  it('defaults cardType to list, currentValue/proposedValue to empty string', () => {
    const result = extractor({ settingKey: 'lang' });
    expect((result[0] as any).cardType).toBe('list');
    expect((result[0] as any).currentValue).toBe('');
    expect((result[0] as any).proposedValue).toBe('');
  });

  it('label falls back to settingKey when label is not provided', () => {
    const result = extractor({ settingKey: 'lang' });
    expect((result[0] as any).label).toBe('lang');
  });

  it('confirmed false: status is rejected', () => {
    const result = extractor({ settingKey: 'theme', confirmed: false });
    expect((result[0] as any).status).toBe('rejected');
  });

  it('no settingKey: returns null', () => {
    expect(extractor({})).toBeNull();
    expect(extractor({ cardType: 'list' })).toBeNull();
  });
});

// ─── subagent ─────────────────────────────────────────────────────────────────

describe('subagent', () => {
  it("subagent: 正常", () => {
    const blocks = (extractBlocks as any)("subagent", {
      taskId: "t1",
      task: "任务：整理桌面\n\n请独立完成",
      taskTitle: "任务：整理桌面",
      agentId: "hana",
      agentName: "Hana",
      sessionPath: "/s/t.jsonl",
      streamStatus: "running",
    });
    expect(blocks[0]).toMatchObject({
      type: "subagent",
      taskId: "t1",
      taskTitle: "任务：整理桌面",
      requestedAgentId: "hana",
      requestedAgentName: "Hana",
      streamKey: "/s/t.jsonl",
      streamStatus: "running",
    });
    expect(blocks[0].label).toBeNull();
  });

  it("subagent: 新 details 保留 child sessionId，同时兼容 streamKey path", () => {
    const blocks = (extractBlocks as any)("subagent", {
      taskId: "t-session-id",
      task: "任务：整理桌面\n\n请独立完成",
      taskTitle: "任务：整理桌面",
      sessionId: "sess_child_block",
      sessionPath: "/s/moved-child.jsonl",
      streamStatus: "running",
    });

    expect(blocks[0]).toMatchObject({
      type: "subagent",
      taskId: "t-session-id",
      sessionId: "sess_child_block",
      streamKey: "/s/moved-child.jsonl",
    });
  });

  it("subagent: 展示 label 透传到块，旧 reuseInstance 可兼容映射", () => {
    const blocks = (extractBlocks as any)("subagent", {
      taskId: "t1", taskTitle: "x", sessionPath: "/s/t.jsonl",
      streamStatus: "running", label: "探索一",
    });
    expect(blocks[0]).toMatchObject({ type: "subagent", label: "探索一" });

    const legacy = (extractBlocks as any)("subagent", {
      taskId: "t2", taskTitle: "x", sessionPath: "/s/t.jsonl",
      streamStatus: "running", reuseInstance: "探索",
    });
    expect(legacy[0]).toMatchObject({ type: "subagent", label: "探索" });
    expect(legacy[0].reuseInstance).toBeUndefined();
  });

  it("subagent: 优先读取显式 executor metadata", () => {
    const blocks = (extractBlocks as any)("subagent", {
      taskId: "t1",
      task: "任务：do stuff\n\n详细要求",
      taskTitle: "任务：do stuff",
      agentId: "hana",
      agentName: "Hana",
      executorAgentId: "butter",
      executorAgentNameSnapshot: "butter",
      sessionPath: "/s/t.jsonl",
      streamStatus: "running",
    });
    expect(blocks[0]).toMatchObject({
      type: "subagent",
      taskId: "t1",
      taskTitle: "任务：do stuff",
      agentId: "butter",
      agentName: "butter",
      streamKey: "/s/t.jsonl",
      streamStatus: "running",
    });
  });

  it("subagent: done 状态", () => {
    const blocks = (extractBlocks as any)("subagent", {
      taskId: "t2",
      task: "任务：done task\n\n详细要求",
      taskTitle: "任务：done task",
      sessionPath: "/s/t2.jsonl",
      streamStatus: "done",
      summary: "结果摘要",
    });
    expect(blocks[0]).toMatchObject({ type: "subagent", taskTitle: "任务：done task", streamStatus: "done", summary: "结果摘要" });
  });

  it("subagent: 无 taskId 返回空", () => {
    expect((extractBlocks as any)("subagent", {})).toEqual([]);
  });

  it("subagent: 最小字段", () => {
    const blocks = (extractBlocks as any)("subagent", { taskId: "t3" });
    expect(blocks[0]).toMatchObject({ type: "subagent", taskId: "t3", task: "", taskTitle: "", agentId: null, streamKey: "", streamStatus: "running" });
  });
});

// ─── plugin card extraction ───────────────────────────────────────────────────

describe('workflow', () => {
  const extractor = BLOCK_EXTRACTORS.workflow;

  it('从 details 提取 workflow 概览 block（名/状态/时长，无 streamKey）', () => {
    const result = extractor({ taskId: 'workflow-1', workflow: '三行晨诗', streamStatus: 'running', startedAt: 1000 });
    expect(result).toEqual([{
      type: 'workflow', taskId: 'workflow-1', taskTitle: '三行晨诗',
      streamStatus: 'running', summary: null, startedAt: 1000, finishedAt: null,
    }]);
  });

  it('无 taskId 返回 null', () => {
    expect(extractor({ workflow: 'x' })).toBeNull();
  });

  it('streamStatus 缺省 running', () => {
    expect(extractor({ taskId: 'w1', workflow: 'x' })[0].streamStatus).toBe('running');
  });
});

describe('extractBlocks: plugin card extraction', () => {
  it('details.card with pluginId produces a plugin_card block', () => {
    const details = { card: { pluginId: 'fm', route: '/k', title: 'Chart' } };
    const blocks = (extractBlocks as any)('unknown_tool', details);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'plugin_card',
      card: { pluginId: 'fm', route: '/k', title: 'Chart', type: 'iframe' },
    });
  });

  it('preserves existing card type when specified', () => {
    const details = { card: { pluginId: 'fm', type: 'native', route: '/x' } };
    const blocks = (extractBlocks as any)('unknown_tool', details);
    expect(blocks[0].card.type).toBe('native');
  });

  it('strips legacy file payload fields from plugin cards', () => {
    const details = {
      card: {
        pluginId: 'fm',
        route: '/k',
        title: 'Chart',
        file: { filePath: '/tmp/raw.png', bytes: 'raw' },
        sessionFile: { fileId: 'sf_1' },
        sourceFile: { filePath: '/tmp/source.csv' },
        files: [{ filePath: '/tmp/a.png' }],
      },
    };
    const blocks = (extractBlocks as any)('unknown_tool', details);

    expect(blocks[0].card).toEqual({
      pluginId: 'fm',
      route: '/k',
      title: 'Chart',
      type: 'iframe',
    });
  });

  it('unknown tool with no card: returns empty array', () => {
    const blocks = (extractBlocks as any)('nonexistent_tool', {});
    expect(blocks).toEqual([]);
  });

  it('unknown tool with null details: returns empty array', () => {
    const blocks = (extractBlocks as any)('nonexistent_tool', null);
    expect(blocks).toEqual([]);
  });
});

// ─── coexistence: tool-specific block + plugin card ───────────────────────────

describe('extractBlocks: tool block + plugin card coexistence', () => {
  it('stage_files details with a card: returns file blocks AND plugin_card', () => {
    const details = {
      files: [{ filePath: '/a/doc.pdf', label: 'doc', ext: 'pdf' }],
      card: { pluginId: 'viewer', route: '/view', type: 'iframe' },
    };
    const blocks = (extractBlocks as any)('stage_files', details);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('file');
    expect(blocks[1].type).toBe('plugin_card');
  });

  it('install_skill details with a card: returns skill block AND plugin_card', () => {
    const details = {
      skillName: 'my-skill',
      card: { pluginId: 'skill-ui', route: '/s' },
    };
    const blocks = (extractBlocks as any)('install_skill', details);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('skill');
    expect(blocks[1].type).toBe('plugin_card');
  });
});
