import { describe, expect, it } from 'vitest';
import { serializeEditor } from '../../utils/editor-serializer';

describe('serializeEditor', () => {
  it('extracts file badges as file refs without leaking their visual label into prompt text', () => {
    const result = serializeEditor({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'fileBadge',
          attrs: {
            fileId: 'sf_voice',
            path: '/tmp/voice.wav',
            name: '录音 1.wav',
            mimeType: 'audio/wav',
          },
        }],
      }],
    });

    expect(result.text).toBe('');
    expect(result.fileRefs).toEqual([{
      fileId: 'sf_voice',
      path: '/tmp/voice.wav',
      name: '录音 1.wav',
      isDirectory: false,
      mimeType: 'audio/wav',
    }]);
  });
});
