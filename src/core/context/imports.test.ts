import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  codeSpanMask,
  findImports,
  MAX_IMPORT_HOPS,
  resolveImportPath,
  walkImports,
  type ImportNode,
} from './imports.js';
import { createMemoryFs } from './test-helpers/memory-fs.js';

describe('codeSpanMask', () => {
  it('marks matched backtick runs and leaves unmatched ones alone', () => {
    expect(codeSpanMask('a `b` c')).toStrictEqual([false, false, true, true, true, false, false]);
    expect(codeSpanMask('``a`b``')).toStrictEqual(Array.from({ length: 7 }, () => true));
    expect(codeSpanMask('`a')).toStrictEqual([false, false]);
    expect(codeSpanMask('``a`')).toStrictEqual([false, false, false, false]);
    expect(codeSpanMask('`a` `b')).toStrictEqual([true, true, true, false, false, false]);
    expect(codeSpanMask('')).toStrictEqual([]);
  });
});

describe('findImports', () => {
  it('finds imports at line starts and after whitespace', () => {
    expect(findImports('@README\nSee @docs/a.md and\t@b.md')).toStrictEqual([
      { raw: 'README', line: 1, inCode: false },
      { raw: 'docs/a.md', line: 2, inCode: false },
      { raw: 'b.md', line: 2, inCode: false },
    ]);
  });

  it('ignores @ inside words, bare @ and quoted paths', () => {
    expect(findImports('mail me@x.com, @ alone, @"a b.md", @\'c.md\'')).toStrictEqual([]);
  });

  it('turns escaped spaces into spaces and stops at the first plain space', () => {
    expect(findImports(String.raw`- API @Design\ Docs/api.md now`)).toStrictEqual([
      { raw: 'Design Docs/api.md', line: 1, inCode: false },
    ]);
    expect(findImports('@Design Docs/api.md')[0]?.raw).toBe('Design');
    expect(findImports(String.raw`@a\b`)[0]?.raw).toBe(String.raw`a\b`);
  });

  it('drops trailing prose punctuation', () => {
    const refs = findImports('See @README. Then @a.md, (@b.md) @c.md!? @d.md;: @e]}');
    expect(refs.map((ref) => ref.raw)).toStrictEqual(['README', 'a.md', 'c.md', 'd.md', 'e']);
    expect(findImports('@...')).toStrictEqual([]);
  });

  it('counts a backtick-led path only when the backtick opens a code span', () => {
    expect(findImports('a`@b.md')).toStrictEqual([]);
    expect(findImports('x`@a.md` y')).toStrictEqual([{ raw: 'a.md', line: 1, inCode: true }]);
    expect(findImports("@x'")).toStrictEqual([{ raw: "x'", line: 1, inCode: false }]);
  });

  it('flags imports in code spans', () => {
    expect(findImports('`@README` and @real.md')).toStrictEqual([
      { raw: 'README', line: 1, inCode: true },
      { raw: 'real.md', line: 1, inCode: false },
    ]);
  });

  it('flags imports inside fenced blocks of either fence character', () => {
    const text = [
      '```md',
      '@in-fence.md',
      '```',
      '@out.md',
      '~~~~',
      '@tilde.md',
      '```',
      '@still.md',
      '~~~~',
      '@after.md',
    ].join('\n');
    expect(findImports(text)).toStrictEqual([
      { raw: 'in-fence.md', line: 2, inCode: true },
      { raw: 'out.md', line: 4, inCode: false },
      { raw: 'tilde.md', line: 6, inCode: true },
      { raw: 'still.md', line: 8, inCode: true },
      { raw: 'after.md', line: 10, inCode: false },
    ]);
  });

  it('needs a closer at least as long as the opener, with no info string', () => {
    const text = ['````', '```', '@a.md', '```` js', '@b.md', '   ````', '@c.md'].join('\n');
    expect(findImports(text).map((ref) => [ref.raw, ref.inCode])).toStrictEqual([
      ['a.md', true],
      ['b.md', true],
      ['c.md', false],
    ]);
  });

  it('treats a fence opener line as code and an unclosed fence as running to the end', () => {
    expect(findImports('``` @x.md\n@y.md')).toStrictEqual([
      { raw: 'x.md', line: 1, inCode: true },
      { raw: 'y.md', line: 2, inCode: true },
    ]);
  });

  it('does not open a fence indented four spaces or with two backticks', () => {
    expect(findImports('    ```\n@a.md\n``\n@b.md').map((ref) => ref.inCode)).toStrictEqual([
      false,
      false,
    ]);
  });

  const word = fc.stringMatching(/^[a-z0-9./_-]{0,12}$/u);
  const proseLine = fc
    .array(fc.oneof(word, fc.constant('@'), fc.constant(' '), fc.constant('`')), { maxLength: 12 })
    .map((parts) => parts.join(''))
    .filter((line) => !/^ {0,3}(?:`{3}|~{3})/u.test(line));

  it('never counts an import inside a fenced block', () => {
    fc.assert(
      fc.property(
        fc.array(proseLine, { maxLength: 8 }),
        fc.constantFrom('```', '~~~', '````'),
        (body, fence) => {
          const refs = findImports([fence, ...body, fence].join('\n'));
          expect(refs.every((ref) => ref.inCode)).toBe(true);
        },
      ),
    );
  });

  it('never counts an import inside a code span', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9./@ _-]{0,20}$/u), (inner) => {
        const refs = findImports(`\`${inner}\``);
        expect(refs.every((ref) => ref.inCode)).toBe(true);
      }),
    );
  });

  it('finds every plain import outside code', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z][a-z0-9/_-]{0,10}$/u), { maxLength: 6 }),
        (names) => {
          const refs = findImports(names.map((name) => `@${name}`).join(' '));
          expect(refs.map((ref) => ref.raw)).toStrictEqual(names);
          expect(refs.some((ref) => ref.inCode)).toBe(false);
        },
      ),
    );
  });
});

describe('resolveImportPath', () => {
  it('resolves relative to the importing file, and expands ~', () => {
    expect(resolveImportPath('docs/a.md', '/repo/sub/CLAUDE.md', '/h')).toBe('/repo/sub/docs/a.md');
    expect(resolveImportPath('../a.md', '/repo/sub/CLAUDE.md', '/h')).toBe('/repo/a.md');
    expect(resolveImportPath('~/notes.md', '/repo/CLAUDE.md', '/h')).toBe('/h/notes.md');
    expect(resolveImportPath('/abs//x/../y.md', '/repo/CLAUDE.md', '/h')).toBe('/abs/y.md');
  });
});

describe('walkImports', () => {
  it('walks depth first in document order, once per path, and stops at the hop limit', async () => {
    const fs = createMemoryFs({
      files: {
        '/r/a.md': '@b.md\n@/r/a.md',
        '/r/b.md': '@c.md',
        '/r/c.md': '@d.md',
        '/r/d.md': '@e.md',
        '/r/e.md': '@f.md',
        '/r/z.md': 'leaf',
      },
    });
    const nodes = await walkImports(
      fs,
      { path: '/r/CLAUDE.md', text: '@a.md @z.md @missing.md' },
      '/h',
    );
    const summary = nodes.map((node) => [
      node.path,
      node.depth,
      node.exists,
      node.text !== null,
      node.parentPath,
    ]);
    expect(summary).toStrictEqual([
      ['/r/a.md', 1, true, true, '/r/CLAUDE.md'],
      ['/r/b.md', 2, true, true, '/r/a.md'],
      ['/r/c.md', 3, true, true, '/r/b.md'],
      ['/r/d.md', 4, true, true, '/r/c.md'],
      ['/r/e.md', 5, true, false, '/r/d.md'],
      ['/r/z.md', 1, true, true, '/r/CLAUDE.md'],
      ['/r/missing.md', 1, false, false, '/r/CLAUDE.md'],
    ]);
    expect(MAX_IMPORT_HOPS).toBe(4);
  });

  it('lets a real import win over a code span naming the same file', async () => {
    const fs = createMemoryFs({
      files: { '/r/a.md': '@nested.md', '/r/nested.md': 'x', '/r/b.md': 'b' },
    });
    const nodes = await walkImports(
      fs,
      { path: '/r/CLAUDE.md', text: '`@a.md` then @a.md\n```\n@b.md\n```' },
      '/h',
    );
    const expected: Partial<ImportNode>[] = [
      { path: '/r/a.md', inCode: false, exists: true, text: '@nested.md' },
      { path: '/r/nested.md', inCode: false, exists: true, text: 'x' },
      { path: '/r/b.md', inCode: true, exists: true, text: null },
    ];
    expect(
      nodes.map((node) => ({
        path: node.path,
        inCode: node.inCode,
        exists: node.exists,
        text: node.text,
      })),
    ).toStrictEqual(expected);
  });

  it('shares the seen set across roots and never reads a directory', async () => {
    const fs = createMemoryFs({ files: { '/r/a.md': 'a', '/r/dir/x': 'x' } });
    const seen = new Set<string>(['/r/a.md']);
    const nodes = await walkImports(
      fs,
      { path: '/r/CLAUDE.md', text: '@a.md @dir @CLAUDE.md' },
      '/h',
      seen,
    );
    expect(nodes).toStrictEqual([
      {
        path: '/r/dir',
        parentPath: '/r/CLAUDE.md',
        depth: 1,
        inCode: false,
        exists: false,
        text: null,
      },
    ]);
    expect([...seen]).toStrictEqual(['/r/a.md', '/r/CLAUDE.md', '/r/dir']);
  });
});
