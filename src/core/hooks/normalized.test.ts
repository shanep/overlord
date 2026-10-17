import { describe, expect, it } from 'vitest';

import { editedFiles, withContextNote, withNotice } from './normalized.js';

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

describe('editedFiles', () => {
  const tools = {
    Edit: ['file_path', 'notebook_path'],
    apply_patch: (input: unknown): readonly string[] =>
      typeof input === 'string' ? input.split(' ') : [],
  };

  it('reads the first path field the tool has', () => {
    expect(
      editedFiles(tools, { name: 'Edit', input: { file_path: 'a.ts' }, useId: null }),
    ).toStrictEqual(['a.ts']);
    expect(
      editedFiles(tools, { name: 'Edit', input: { notebook_path: 'n.ipynb' }, useId: null }),
    ).toStrictEqual(['n.ipynb']);
  });

  it('reads every path a tool with a path reader writes, leaving out empty ones', () => {
    expect(
      editedFiles(tools, { name: 'apply_patch', input: 'a.ts  b.ts', useId: null }),
    ).toStrictEqual(['a.ts', 'b.ts']);
    expect(editedFiles(tools, { name: 'apply_patch', input: {}, useId: null })).toStrictEqual([]);
  });

  it('is empty for other tools and empty paths', () => {
    expect(
      editedFiles(tools, { name: 'Read', input: { file_path: 'a' }, useId: null }),
    ).toStrictEqual([]);
    expect(
      editedFiles(tools, {
        name: 'Edit',
        input: { file_path: '', notebook_path: 'n' },
        useId: null,
      }),
    ).toStrictEqual([]);
    expect(editedFiles(tools, { name: 'toString', input: {}, useId: null })).toStrictEqual([]);
  });
});
