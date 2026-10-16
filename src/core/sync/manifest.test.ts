import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  emptyManifest,
  isSafeHomeTarget,
  isSafeRepoPath,
  type Manifest,
  normalizeManifest,
  parseManifest,
  readManifest,
  serializeManifest,
  upsertItems,
  writeManifest,
} from './manifest.js';
import { scratchDir, writeTree } from './test-helpers/fixtures.js';

const full: Manifest = {
  version: 1,
  claudeCodeVersion: '2.1.301',
  items: [
    {
      id: 'skill:b',
      kind: 'skill',
      source: 'skills/b',
      target: '~/.claude/skills/b',
      mode: 'link',
    },
    {
      id: 'claude-md',
      kind: 'claude-md',
      source: 'global/CLAUDE.md',
      target: '~/.claude/CLAUDE.md',
      mode: 'link',
    },
  ],
  external: [
    { repoUrl: 'git@github.com:a/z.git', path: 'skills/z', target: '~/.claude/skills/z' },
    {
      repoUrl: 'git@github.com:a/y.git',
      path: 'skills/y',
      target: '~/.claude/skills/y',
      checkout: '~/src/y',
    },
  ],
  plugins: {
    marketplaces: [
      { name: 'm2', source: 'a/m2' },
      { name: 'm1', source: 'a/m1' },
    ],
    enabled: ['p@m1', 'a@m1', 'p@m1'],
  },
  mcp: 'mcp.json',
  memory: { enabled: false, keyBy: 'git-remote' },
};

describe('path rules', () => {
  it('keeps repo paths inside the repo', () => {
    expect(isSafeRepoPath('skills/a')).toBe(true);
    expect(isSafeRepoPath('')).toBe(false);
    expect(isSafeRepoPath('/etc/passwd')).toBe(false);
    expect(isSafeRepoPath(String.raw`a\b`)).toBe(false);
    expect(isSafeRepoPath('a/../b')).toBe(false);
    expect(isSafeRepoPath('a/./b')).toBe(false);
    expect(isSafeRepoPath('a//b')).toBe(false);
  });

  it('keeps targets under home', () => {
    expect(isSafeHomeTarget('~/.claude/x')).toBe(true);
    expect(isSafeHomeTarget('/etc/x')).toBe(false);
    expect(isSafeHomeTarget('~/../x')).toBe(false);
    expect(isSafeHomeTarget('~/')).toBe(false);
    expect(isSafeHomeTarget('x/~/y')).toBe(false);
  });
});

describe('parseManifest', () => {
  it('fills defaults for a minimal manifest', () => {
    expect(parseManifest({ version: 1 })).toStrictEqual({ ok: true, manifest: emptyManifest() });
    expect(emptyManifest()).toStrictEqual({
      version: 1,
      claudeCodeVersion: null,
      items: [],
      external: [],
      plugins: { marketplaces: [], enabled: [] },
      mcp: null,
      memory: { enabled: true, keyBy: 'git-remote' },
    });
  });

  it('round trips a full manifest', () => {
    expect(parseManifest(full)).toStrictEqual({ ok: true, manifest: full });
  });

  it('rejects bad versions, kinds, modes and paths with a readable error', () => {
    const cases: unknown[] = [
      { version: 2 },
      { version: 1, items: [{ ...full.items[0], kind: 'nope' }] },
      { version: 1, items: [{ ...full.items[0], mode: 'move' }] },
      { version: 1, items: [{ ...full.items[0], id: '' }] },
      { version: 1, items: [{ ...full.items[0], source: '../x' }] },
      { version: 1, items: [{ ...full.items[0], target: '/etc/x' }] },
      { version: 1, external: [{ repoUrl: '', path: 'a', target: '~/a' }] },
      { version: 1, mcp: '/abs.json' },
      { version: 1, memory: { keyBy: 'path' } },
      { version: 1, plugins: { enabled: [''] } },
      { version: 1, plugins: { marketplaces: [{ name: '', source: 'x' }] } },
    ];
    for (const value of cases) {
      const result = parseManifest(value);
      expect(result.ok).toBe(false);
    }
    const result = parseManifest({ version: 1, items: [{ ...full.items[0], target: '/etc/x' }] });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('must be a path under ~/');
    const source = parseManifest({ version: 1, items: [{ ...full.items[0], source: '../x' }] });
    expect(source.ok).toBe(false);
    expect(JSON.stringify(source)).toContain('must be a relative path in the repo');
  });
});

describe('normalize and serialize', () => {
  it('sorts every list and dedupes enabled plugins', () => {
    const normal = normalizeManifest(full);
    expect(normal.items.map((item) => item.id)).toStrictEqual(['claude-md', 'skill:b']);
    expect(normal.external.map((item) => item.target)).toStrictEqual([
      '~/.claude/skills/y',
      '~/.claude/skills/z',
    ]);
    expect(normal.plugins.marketplaces.map((item) => item.name)).toStrictEqual(['m1', 'm2']);
    expect(normal.plugins.enabled).toStrictEqual(['a@m1', 'p@m1']);
    expect(full.items[0]?.id).toBe('skill:b');
  });

  it('writes stable sorted JSON', () => {
    const text = serializeManifest(full);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.indexOf('"claudeCodeVersion"')).toBeLessThan(text.indexOf('"version"'));
    expect(serializeManifest(normalizeManifest(full))).toBe(text);
  });
});

describe('read and write', () => {
  it('writes then reads back the normalized manifest', async () => {
    const root = await scratchDir();
    await writeManifest(root, full);
    expect(await readFile(path.join(root, 'overlord.json'), 'utf8')).toBe(serializeManifest(full));
    expect(await readManifest(root)).toStrictEqual({ ok: true, manifest: normalizeManifest(full) });
  });

  it('reports a missing, unparsable or invalid file', async () => {
    const root = await scratchDir();
    expect(await readManifest(root)).toStrictEqual({
      ok: false,
      error: `overlord.json not found in ${root}`,
    });
    await writeTree(root, { 'overlord.json': '{' });
    expect(await readManifest(root)).toStrictEqual({
      ok: false,
      error: 'overlord.json is not valid JSON',
    });
    await writeTree(root, { 'overlord.json': '{"version":3}' });
    const invalid = await readManifest(root);
    expect(invalid.ok).toBe(false);
  });
});

describe('upsertItems', () => {
  it('replaces by id and keeps the rest', () => {
    const next = upsertItems(full, [
      {
        id: 'skill:b',
        kind: 'skill',
        source: 'skills/b2',
        target: '~/.claude/skills/b',
        mode: 'copy',
      },
      {
        id: 'agent:a',
        kind: 'agent',
        source: 'agents/a.md',
        target: '~/.claude/agents/a.md',
        mode: 'link',
      },
    ]);
    expect(next.items.map((item) => `${item.id}=${item.source}`)).toStrictEqual([
      'agent:a=agents/a.md',
      'claude-md=global/CLAUDE.md',
      'skill:b=skills/b2',
    ]);
  });
});
