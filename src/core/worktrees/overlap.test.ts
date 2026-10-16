import { describe, expect, it } from 'vitest';

import { withOverlaps } from './overlap.js';

describe('withOverlaps', () => {
  it('pairs worktrees of one repository that change the same files', () => {
    const rows = withOverlaps([
      { id: 'a', label: 'A', repoRoot: '/repo', files: ['src/x.ts', 'src/y.ts'] },
      { id: 'b', label: 'B', repoRoot: '/repo', files: ['src/y.ts', 'src/z.ts'] },
      { id: 'c', label: 'C', repoRoot: '/repo', files: ['README.md'] },
      { id: 'd', label: 'D', repoRoot: '/other', files: ['src/y.ts'] },
    ]);
    expect(rows.map((row) => [row.id, row.overlaps])).toStrictEqual([
      ['a', [{ id: 'b', label: 'B', files: ['src/y.ts'] }]],
      ['b', [{ id: 'a', label: 'A', files: ['src/y.ts'] }]],
      ['c', []],
      ['d', []],
    ]);
  });
});
