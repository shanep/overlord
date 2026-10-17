import { describe, expect, it } from 'vitest';

import { editedFile, withContextNote, withNotice } from './normalized.js';

describe('withContextNote', () => {
  it('leaves the answer alone without text', () => {
    expect(withContextNote(null, null)).toBeNull();
    const block = { block: 'no' };
    expect(withContextNote(block, null)).toBe(block);
  });

  it('makes an answer, or adds to the context already there', () => {
    expect(withContextNote(null, 'note')).toStrictEqual({ context: 'note' });
    expect(withContextNote({ context: '' }, 'note')).toStrictEqual({ context: 'note' });
    expect(withContextNote({ block: 'no', context: 'peers' }, 'check')).toStrictEqual({
      block: 'no',
      context: 'peers\n\ncheck',
    });
  });
});

describe('withNotice', () => {
  it('adds to the notice, or leaves the answer alone without text', () => {
    expect(withNotice(null, null)).toBeNull();
    expect(withNotice(null, 'seen')).toStrictEqual({ notice: 'seen' });
    expect(withNotice({ notice: 'first' }, 'second')).toStrictEqual({ notice: 'first\n\nsecond' });
  });
});

describe('editedFile', () => {
  const tools = { Edit: ['file_path', 'notebook_path'], apply_patch: [] };

  it('reads the first path field the tool has', () => {
    expect(editedFile(tools, { name: 'Edit', input: { file_path: 'a.ts' }, useId: null })).toBe(
      'a.ts',
    );
    expect(
      editedFile(tools, { name: 'Edit', input: { notebook_path: 'n.ipynb' }, useId: null }),
    ).toBe('n.ipynb');
  });

  it('is null for other tools, empty paths and tools with no path field', () => {
    expect(editedFile(tools, { name: 'Read', input: { file_path: 'a' }, useId: null })).toBeNull();
    expect(
      editedFile(tools, {
        name: 'Edit',
        input: { file_path: '', notebook_path: 'n' },
        useId: null,
      }),
    ).toBeNull();
    expect(
      editedFile(tools, { name: 'apply_patch', input: { command: 'patch' }, useId: null }),
    ).toBeNull();
    expect(editedFile(tools, { name: 'toString', input: {}, useId: null })).toBeNull();
  });
});
