/**
 * @vitest-environment jsdom
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMarkdownDecorations,
  collectLivePreviewRanges,
  markdownBlockDecoField,
  markdownDecoPlugin,
  markdownImageContextFacet,
} from '../../editor/md-decorations';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('collectLivePreviewRanges', () => {
  it('collects Obsidian highlights and math ranges on inactive lines', () => {
    const ranges = collectLivePreviewRanges([
      'GDP ==平减指数== and $x+1$',
      '$$',
      'y^2',
      '$$',
      '<span style="background:#fff88f">高亮</span>',
    ].join('\n'), new Set());

    expect(ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'mark', text: '平减指数' }),
      expect.objectContaining({ kind: 'inlineMath', source: 'x+1' }),
      expect.objectContaining({ kind: 'blockMath', source: 'y^2' }),
      expect.objectContaining({ kind: 'mark', text: '高亮', color: '#fff88f' }),
    ]));
  });

  it('skips live preview ranges on active lines so the source remains editable', () => {
    const ranges = collectLivePreviewRanges('GDP ==平减指数== and $x+1$', new Set([1]));

    expect(ranges).toEqual([]);
  });

  it('does not collect math or highlight ranges inside code blocks', () => {
    const ranges = collectLivePreviewRanges([
      '```js',
      'const price = "$x+1$"; // ==keep raw==',
      '```',
    ].join('\n'), new Set());

    expect(ranges).toEqual([]);
  });

  it('does not collect math or highlight ranges inside inline code', () => {
    const ranges = collectLivePreviewRanges('Use `$x+1$` and `==raw==` outside ==mark==', new Set());

    expect(ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'mark', text: 'mark' }),
    ]));
    expect(ranges).toHaveLength(3);
  });

  it('does not provide block math decorations through the view plugin decoration set', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: 'intro\n$$\ny^2\n$$' }),
    });

    const blockSpecs: unknown[] = [];
    buildMarkdownDecorations(view).between(0, view.state.doc.length, (_from, _to, deco) => {
      if ((deco.spec as { block?: boolean }).block) blockSpecs.push(deco.spec);
    });

    view.destroy();
    expect(blockSpecs).toEqual([]);
  });

  it('provides block math decorations through the direct state field', () => {
    const state = EditorState.create({
      doc: 'intro\n$$\ny^2\n$$',
      extensions: [markdownBlockDecoField],
    });
    const specs: unknown[] = [];

    state.field(markdownBlockDecoField).between(0, state.doc.length, (_from, _to, deco) => {
      if ((deco.spec as { block?: boolean }).block) specs.push(deco.spec);
    });

    expect(specs).toHaveLength(1);
  });

  it('reveals block math source when the rendered block is clicked', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'intro\n$$\ny^2\n$$',
        extensions: [markdownBlockDecoField],
      }),
    });

    const widget = parent.querySelector('.cm-math-block-widget');
    expect(widget).toBeInstanceOf(HTMLElement);

    widget?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(view.state.selection.main.head).toBe(6);
    const blockSpecs: unknown[] = [];
    view.state.field(markdownBlockDecoField).between(0, view.state.doc.length, (_from, _to, deco) => {
      if ((deco.spec as { block?: boolean }).block) blockSpecs.push(deco.spec);
    });
    expect(blockSpecs).toEqual([]);

    view.destroy();
  });

  it('renders standard markdown images relative to the markdown file in live preview', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const seenPaths: string[] = [];
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'intro\n![Cover](./assets/cover.png)',
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownImageContextFacet.of({
            filePath: '/vault/notes/chapter.md',
            getFileUrl: (filePath) => {
              seenPaths.push(filePath);
              return `file://${filePath}`;
            },
          }),
          markdownDecoPlugin,
        ],
      }),
    });

    const img = parent.querySelector('.cm-image-widget img');

    expect(seenPaths).toEqual(['/vault/notes/assets/cover.png']);
    expect(img?.getAttribute('src')).toBe('file:///vault/notes/assets/cover.png');
    expect(img?.getAttribute('alt')).toBe('Cover');

    view.destroy();
  });

  it('keeps standard markdown image previews visible below the source on active lines', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const doc = 'intro\n![Cover](./assets/cover.png)';
    const imageLine = doc.indexOf('![Cover]');
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: imageLine + 2 },
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownImageContextFacet.of({
            filePath: '/vault/notes/chapter.md',
            getFileUrl: (filePath) => `file://${filePath}`,
          }),
          markdownDecoPlugin,
          markdownBlockDecoField,
        ],
      }),
    });

    const img = parent.querySelector('.cm-image-widget img');
    const blockSpecs: unknown[] = [];
    view.state.field(markdownBlockDecoField).between(0, view.state.doc.length, (from, to, deco) => {
      if (from === view.state.doc.line(2).to && to === view.state.doc.line(2).to) {
        blockSpecs.push(deco.spec);
      }
    });

    expect(parent.textContent).toContain('![Cover](./assets/cover.png)');
    expect(img?.getAttribute('src')).toBe('file:///vault/notes/assets/cover.png');
    expect(blockSpecs).toEqual(expect.arrayContaining([
      expect.objectContaining({ block: true }),
    ]));

    view.destroy();
  });

  it('renders Obsidian image embeds in live preview', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'intro\n![[attachments/diagram.png|120]]',
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownImageContextFacet.of({
            filePath: '/vault/notes/chapter.md',
            getFileUrl: (filePath) => `file://${filePath}`,
          }),
          markdownDecoPlugin,
        ],
      }),
    });

    const img = parent.querySelector('.cm-image-widget img');

    expect(img?.getAttribute('src')).toBe('file:///vault/notes/attachments/diagram.png');
    expect(img?.getAttribute('alt')).toBe('diagram.png');

    view.destroy();
  });

  it('keeps Obsidian image previews visible below the source on active lines', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const doc = 'intro\n![[attachments/diagram.png|120]]';
    const imageLine = doc.indexOf('![[attachments');
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: imageLine + 3 },
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownImageContextFacet.of({
            filePath: '/vault/notes/chapter.md',
            getFileUrl: (filePath) => `file://${filePath}`,
          }),
          markdownDecoPlugin,
          markdownBlockDecoField,
        ],
      }),
    });

    const img = parent.querySelector('.cm-image-widget img');
    const blockSpecs: unknown[] = [];
    view.state.field(markdownBlockDecoField).between(0, view.state.doc.length, (from, to, deco) => {
      if (from === view.state.doc.line(2).to && to === view.state.doc.line(2).to) {
        blockSpecs.push(deco.spec);
      }
    });

    expect(parent.textContent).toContain('![[attachments/diagram.png|120]]');
    expect(img?.getAttribute('src')).toBe('file:///vault/notes/attachments/diagram.png');
    expect(blockSpecs).toEqual(expect.arrayContaining([
      expect.objectContaining({ block: true }),
    ]));

    view.destroy();
  });

  it('shows a copy button on inactive fenced code blocks in the markdown editor', async () => {
    window.t = ((key: string) => {
      if (key === 'attach.copy') return '复制';
      if (key === 'attach.copied') return '已复制';
      return key;
    }) as typeof window.t;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: [
          'intro',
          '```ts',
          'const x = 1;',
          '```',
        ].join('\n'),
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownDecoPlugin,
        ],
      }),
    });

    const button = parent.querySelector<HTMLButtonElement>('.cm-codeblock-copy-btn');

    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button?.querySelector('svg.cm-codeblock-copy-icon')).toBeInstanceOf(SVGSVGElement);
    expect(button?.querySelector('.cm-codeblock-copy-label')?.textContent).toBe('复制');
    expect(button?.getAttribute('aria-label')).toBe('复制');
    button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('const x = 1;');
    expect(button?.dataset.copied).toBe('true');
    expect(button?.querySelector('.cm-codeblock-copy-label')?.textContent).toBe('已复制');
    expect(button?.getAttribute('aria-label')).toBe('已复制');

    view.destroy();
  });
});
