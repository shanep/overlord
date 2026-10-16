import { describe, expect, it } from 'vitest';

import { listMarkdownFiles, listSubdirectories, touchedDirs } from './scan.js';
import { createMemoryFs } from './test-helpers/memory-fs.js';

const tree = createMemoryFs({
  files: {
    '/r/a/x.ts': '',
    '/r/a/b/c/d.ts': '',
    '/r/z/file': '',
    '/r/.git/HEAD': '',
    '/r/node_modules/p/CLAUDE.md': '',
    '/r/plain.txt': '',
  },
  dirs: ['/r/empty'],
});

describe('touchedDirs', () => {
  it('lists every dir strictly between the root and each touched file', () => {
    expect(
      touchedDirs('/r', ['/r/a/b/f.ts', '/r/top.ts', '/elsewhere/x.ts', '/r/a/g.ts']),
    ).toStrictEqual(['/r/a/b', '/r/a']);
    expect(touchedDirs('/r', [])).toStrictEqual([]);
  });

  it('resolves relative touched paths', () => {
    expect(touchedDirs('/r', ['/r/a/./b/../f.ts'])).toStrictEqual(['/r/a']);
  });
});

describe('listSubdirectories', () => {
  it('walks breadth first, skipping dot dirs and node_modules', async () => {
    expect(await listSubdirectories(tree, '/r', [], { maxDirs: 100, maxDepth: 10 })).toStrictEqual([
      '/r/a',
      '/r/a/b',
      '/r/a/b/c',
      '/r/empty',
      '/r/z',
    ]);
  });

  it('stops at the depth limit', async () => {
    expect(await listSubdirectories(tree, '/r', [], { maxDirs: 100, maxDepth: 1 })).toStrictEqual([
      '/r/a',
      '/r/empty',
      '/r/z',
    ]);
    expect(await listSubdirectories(tree, '/r', [], { maxDirs: 100, maxDepth: 2 })).toStrictEqual([
      '/r/a',
      '/r/a/b',
      '/r/empty',
      '/r/z',
    ]);
    expect(await listSubdirectories(tree, '/r', [], { maxDirs: 100, maxDepth: 0 })).toStrictEqual(
      [],
    );
  });

  it('stops at the dir limit', async () => {
    expect(await listSubdirectories(tree, '/r', [], { maxDirs: 2, maxDepth: 10 })).toStrictEqual([
      '/r/a',
      '/r/empty',
    ]);
    expect(await listSubdirectories(tree, '/r', [], { maxDirs: 0, maxDepth: 10 })).toStrictEqual(
      [],
    );
  });

  it('always adds the dirs of touched files, even skipped ones', async () => {
    const found = await listSubdirectories(tree, '/r', ['/r/node_modules/p/i.js'], {
      maxDirs: 0,
      maxDepth: 0,
    });
    expect(found).toStrictEqual(['/r/node_modules', '/r/node_modules/p']);
  });
});

describe('listMarkdownFiles', () => {
  it('lists .md files recursively in sorted order', async () => {
    const fs = createMemoryFs({
      files: { '/rules/b.md': '', '/rules/a.txt': '', '/rules/sub/a.md': '', '/rules/A.md': '' },
    });
    expect(await listMarkdownFiles(fs, '/rules')).toStrictEqual([
      '/rules/A.md',
      '/rules/b.md',
      '/rules/sub/a.md',
    ]);
  });

  it('follows symlinked dirs once and survives loops', async () => {
    const fs = createMemoryFs({
      files: { '/shared/s.md': '', '/rules/r.md': '' },
      links: { '/rules/shared': '/shared', '/shared/back': '/rules' },
    });
    expect(await listMarkdownFiles(fs, '/rules')).toStrictEqual([
      '/rules/r.md',
      '/rules/shared/s.md',
    ]);
  });

  it('returns nothing for a missing dir', async () => {
    expect(await listMarkdownFiles(createMemoryFs({ files: {} }), '/nope')).toStrictEqual([]);
  });
});
