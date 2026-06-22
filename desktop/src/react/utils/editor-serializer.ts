import type { JSONContent } from '@tiptap/core';

export interface EditorFileRef {
  fileId?: string;
  path: string;
  name: string;
  isDirectory?: boolean;
  mimeType?: string;
}

/**
 * Walk TipTap JSON document, extract input badges and plain text.
 */
export function serializeEditor(json: JSONContent): { text: string; skills: string[]; fileRefs: EditorFileRef[] } {
  const skills: string[] = [];
  const fileRefs: EditorFileRef[] = [];
  const textParts: string[] = [];

  function fileBadgeLabel(attrs: Record<string, unknown>): string {
    const name = typeof attrs.name === 'string' ? attrs.name : '';
    const filePath = typeof attrs.path === 'string' ? attrs.path : '';
    return name || filePath.split(/[\\/]/).pop() || filePath;
  }

  function paragraphHasText(content: JSONContent[] | undefined): boolean {
    return (content || []).some(child => child.type === 'text' && typeof child.text === 'string' && child.text.trim().length > 0);
  }

  function walk(node: JSONContent, options: { emitFileBadgeText?: boolean } = {}) {
    if (node.type === 'skillBadge' && node.attrs?.name) {
      skills.push(node.attrs.name as string);
      return;
    }
    if (node.type === 'fileBadge' && node.attrs) {
      const path = typeof node.attrs.path === 'string' ? node.attrs.path : '';
      const label = fileBadgeLabel(node.attrs);
      if (label || path) {
        fileRefs.push({
          ...(typeof node.attrs.fileId === 'string' && node.attrs.fileId ? { fileId: node.attrs.fileId } : {}),
          path,
          name: label,
          isDirectory: node.attrs.isDirectory === true,
          ...(typeof node.attrs.mimeType === 'string' && node.attrs.mimeType ? { mimeType: node.attrs.mimeType } : {}),
        });
        if (options.emitFileBadgeText) {
          textParts.push(`@${label}`);
        }
      }
      return;
    }
    if (node.type === 'text' && node.text) {
      textParts.push(node.text);
      return;
    }
    if (node.type === 'hardBreak') {
      textParts.push('\n');
      return;
    }
    if (node.type === 'paragraph') {
      const emitFileBadgeText = paragraphHasText(node.content);
      if (node.content) {
        for (const child of node.content) walk(child, { emitFileBadgeText });
      }
      if (textParts.length > 0) {
        textParts.push('\n');
      }
      return;
    }
    if (node.content) {
      for (const child of node.content) walk(child);
    }
  }

  walk(json);

  const text = textParts.join('').replace(/\n+$/, '').trim();

  return { text, skills, fileRefs };
}
