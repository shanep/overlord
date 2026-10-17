import { describe, expect, it } from 'vitest';

import { applyPatchPaths, patchPaths } from './apply-patch.js';

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/app.ts',
  '*** Move to: src/main.ts',
  '@@',
  '-old',
  '+new',
  '*** Add File: notes.txt',
  '+hello',
  '*** Delete File: old.txt',
  '*** Update File: src/app.ts',
  '*** End Patch',
].join('\n');

describe('patchPaths', () => {
  it('names every file the headers touch, once each, in order', () => {
    expect(patchPaths(PATCH)).toStrictEqual(['src/app.ts', 'src/main.ts', 'notes.txt', 'old.txt']);
  });

  it('reads Windows line endings and skips headers with no path', () => {
    expect(patchPaths('*** Add File: a.txt\r\n*** Delete File:  \r\n')).toStrictEqual(['a.txt']);
    expect(patchPaths('just text')).toStrictEqual([]);
  });

  it('does not take a body line that only mentions a header', () => {
    expect(patchPaths('+*** Add File: fake.txt')).toStrictEqual([]);
  });
});

describe('applyPatchPaths', () => {
  it('reads the patch from command, patch or input, as a string or an argv', () => {
    expect(applyPatchPaths({ command: PATCH })).toHaveLength(4);
    expect(applyPatchPaths({ command: ['apply_patch', PATCH] })).toHaveLength(4);
    expect(applyPatchPaths({ patch: '*** Add File: a.txt' })).toStrictEqual(['a.txt']);
    expect(applyPatchPaths({ input: '*** Add File: a.txt' })).toStrictEqual(['a.txt']);
    expect(applyPatchPaths('*** Delete File: b.txt')).toStrictEqual(['b.txt']);
  });

  it('is empty for input with no patch', () => {
    expect(applyPatchPaths(null)).toStrictEqual([]);
    expect(applyPatchPaths(7)).toStrictEqual([]);
    expect(applyPatchPaths({ file_path: 'a.ts' })).toStrictEqual([]);
    expect(applyPatchPaths({ command: 5 })).toStrictEqual([]);
  });
});
