import { describe, expect, it } from 'vitest';

import { resolveClaudePaths } from '../paths.js';

import { collectCandidates, type CandidateInput } from './candidates.js';
import { CWD, MEMORY_DIR, PATHS } from './test-helpers/fixtures.js';
import { createMemoryFs, type MemoryTree } from './test-helpers/memory-fs.js';
import { DEFAULT_SCAN_LIMITS } from './types.js';

function input(tree: MemoryTree, overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    fs: createMemoryFs(tree),
    paths: PATHS,
    cwd: CWD,
    addDirs: [],
    touchedFiles: [],
    memoryDir: MEMORY_DIR,
    scan: DEFAULT_SCAN_LIMITS,
    ...overrides,
  };
}

describe('collectCandidates', () => {
  it('lists only the fixed locations, as missing, for an empty tree', async () => {
    const found = await collectCandidates(input({ files: {} }));
    expect(
      found.map((item) => [item.path, item.tier, item.kind, item.origin, item.mode, item.exists]),
    ).toStrictEqual([
      ['/etc/claude-code/CLAUDE.md', 'Managed', 'claude-md', 'managed', 'eager', false],
      ['/home/u/.claude/CLAUDE.md', 'User', 'claude-md', 'user', 'eager', false],
      ['/home/u/repo/CLAUDE.md', 'Project', 'claude-md', 'ancestor', 'eager', false],
      ['/home/u/repo/.claude/CLAUDE.md', 'Project', 'claude-md', 'ancestor', 'eager', false],
      ['/home/u/repo/CLAUDE.local.md', 'Local', 'local-md', 'ancestor', 'eager', false],
      [`${MEMORY_DIR}/MEMORY.md`, 'AutoMem', 'memory-index', 'auto-memory', 'auto-memory', false],
    ]);
    expect(found.every((item) => item.text === null && item.realPath === null)).toBe(true);
  });

  it('orders files managed, user, ancestors root first, nested, add-dir, then memory', async () => {
    const files: Record<string, string> = {
      '/etc/claude-code/CLAUDE.md': 'managed',
      '/home/u/.claude/CLAUDE.md': 'user',
      '/home/u/.claude/rules/u.md': 'user rule',
      '/CLAUDE.md': 'root',
      '/home/AGENTS.md': 'agents',
      '/home/u/repo/CLAUDE.md': 'project',
      '/home/u/repo/.claude/CLAUDE.md': 'dot project',
      '/home/u/repo/.claude/rules/b.md': '---\npaths: "src/**"\n---\nb',
      '/home/u/repo/.claude/rules/a.md': 'a',
      '/home/u/repo/.claude/rules/bad.md': '---\npaths: [unclosed\n---\nbad',
      '/home/u/repo/CLAUDE.local.md': 'local',
      '/home/u/repo/.claude/AGENTS.md': 'dot agents',
      '/home/u/repo/pkg/CLAUDE.md': 'nested',
      '/home/u/repo/pkg/AGENTS.md': 'nested agents',
      '/home/u/repo/pkg/.claude/rules/n.md': 'nested rule',
      '/home/u/repo/pkg/.claude/rules/g.md': '---\npaths:\n  - "*.ts"\n---\n',
      '/add/CLAUDE.md': 'add',
      '/add/AGENTS.md': 'not listed',
      [`${MEMORY_DIR}/MEMORY.md`]: 'index',
      [`${MEMORY_DIR}/topic.md`]: 'topic',
      [`${MEMORY_DIR}/notes.txt`]: 'not md',
    };
    const found = await collectCandidates(input({ files }, { addDirs: ['/add'] }));
    expect(
      found.map((item) => [item.path, item.kind, item.origin, item.mode, item.ownerDir]),
    ).toStrictEqual([
      ['/etc/claude-code/CLAUDE.md', 'claude-md', 'managed', 'eager', CWD],
      ['/home/u/.claude/CLAUDE.md', 'claude-md', 'user', 'eager', CWD],
      ['/home/u/.claude/rules/u.md', 'rule', 'user', 'eager', CWD],
      ['/CLAUDE.md', 'claude-md', 'ancestor', 'eager', '/'],
      ['/home/AGENTS.md', 'agents-md', 'ancestor', 'eager', '/home'],
      ['/home/u/repo/CLAUDE.md', 'claude-md', 'ancestor', 'eager', CWD],
      ['/home/u/repo/.claude/CLAUDE.md', 'claude-md', 'ancestor', 'eager', CWD],
      ['/home/u/repo/.claude/rules/a.md', 'rule', 'ancestor', 'eager', CWD],
      ['/home/u/repo/.claude/rules/b.md', 'rule', 'ancestor', 'glob', CWD],
      ['/home/u/repo/.claude/rules/bad.md', 'rule', 'ancestor', 'eager', CWD],
      ['/home/u/repo/CLAUDE.local.md', 'local-md', 'ancestor', 'eager', CWD],
      ['/home/u/repo/.claude/AGENTS.md', 'agents-md', 'ancestor', 'eager', CWD],
      ['/home/u/repo/pkg/CLAUDE.md', 'claude-md', 'nested', 'lazy-subdir', `${CWD}/pkg`],
      ['/home/u/repo/pkg/.claude/rules/g.md', 'rule', 'nested', 'glob', `${CWD}/pkg`],
      ['/home/u/repo/pkg/.claude/rules/n.md', 'rule', 'nested', 'lazy-subdir', `${CWD}/pkg`],
      ['/home/u/repo/pkg/AGENTS.md', 'agents-md', 'nested', 'lazy-subdir', `${CWD}/pkg`],
      ['/add/CLAUDE.md', 'claude-md', 'add-dir', 'eager', '/add'],
      [`${MEMORY_DIR}/MEMORY.md`, 'memory-index', 'auto-memory', 'auto-memory', MEMORY_DIR],
      [`${MEMORY_DIR}/topic.md`, 'memory-topic', 'auto-memory', 'auto-memory', MEMORY_DIR],
    ]);
    const byPath = new Map(found.map((item) => [item.path, item]));
    expect(byPath.get('/home/u/repo/.claude/rules/b.md')?.globs).toStrictEqual(['src/**']);
    expect(byPath.get('/home/u/repo/pkg/.claude/rules/g.md')?.globs).toStrictEqual(['*.ts']);
    expect(byPath.get('/home/u/repo/.claude/rules/bad.md')?.globs).toStrictEqual([]);
    expect(byPath.get('/home/u/repo/CLAUDE.md')).toStrictEqual({
      path: '/home/u/repo/CLAUDE.md',
      tier: 'Project',
      kind: 'claude-md',
      mode: 'eager',
      origin: 'ancestor',
      ownerDir: CWD,
      exists: true,
      text: 'project',
      bytes: 7,
      realPath: '/home/u/repo/CLAUDE.md',
      globs: [],
      parentPath: null,
      depth: 0,
      inCode: false,
    });
    expect(byPath.get('/home/u/repo/CLAUDE.local.md')?.tier).toBe('Local');
    expect(byPath.get('/home/u/.claude/rules/u.md')?.tier).toBe('User');
    expect(byPath.get('/home/u/repo/.claude/rules/a.md')?.tier).toBe('Project');
    expect(byPath.get('/home/AGENTS.md')?.tier).toBe('Project');
    expect(byPath.get('/home/u/repo/.claude/AGENTS.md')?.tier).toBe('Project');
    expect(byPath.get(`${MEMORY_DIR}/topic.md`)?.tier).toBe('AutoMem');
  });

  it('lists a path once, keeping the first place it was found', async () => {
    // With cwd at home, ~/.claude/CLAUDE.md is also cwd/.claude/CLAUDE.md.
    const found = await collectCandidates(
      input(
        { files: { '/home/u/.claude/CLAUDE.md': 'user', '/home/u/.claude/rules/r.md': 'r' } },
        { cwd: '/home/u' },
      ),
    );
    const user = found.filter(
      (item) => item.path.startsWith('/home/u/.claude/') && item.origin !== 'auto-memory',
    );
    expect(user.map((item) => [item.path, item.origin, item.tier])).toStrictEqual([
      ['/home/u/.claude/CLAUDE.md', 'user', 'User'],
      ['/home/u/.claude/rules/r.md', 'user', 'User'],
    ]);
  });

  it('puts a Windows managed path together with Windows separators', async () => {
    const paths = resolveClaudePaths({ home: '/home/u', platform: 'win32', env: {} });
    const found = await collectCandidates(input({ files: {} }, { paths }));
    expect(found[0]?.path).toBe(String.raw`C:\Program Files\ClaudeCode\CLAUDE.md`);
  });

  it('records the link target of a symlinked file', async () => {
    const found = await collectCandidates(
      input({
        files: { '/shared/rule.md': 'r' },
        links: { '/home/u/repo/.claude/rules/rule.md': '/shared/rule.md' },
      }),
    );
    const rule = found.find((item) => item.kind === 'rule');
    expect(rule?.realPath).toBe('/shared/rule.md');
    expect(rule?.text).toBe('r');
  });

  it('respects the scan limits for nested dirs but always adds touched ones', async () => {
    const tree: MemoryTree = {
      files: { '/home/u/repo/a/CLAUDE.md': 'a', '/home/u/repo/b/CLAUDE.md': 'b' },
    };
    const none = await collectCandidates(input(tree, { scan: { maxDirs: 0, maxDepth: 0 } }));
    expect(none.some((item) => item.origin === 'nested')).toBe(false);
    const touched = await collectCandidates(
      input(tree, { scan: { maxDirs: 0, maxDepth: 0 }, touchedFiles: ['/home/u/repo/b/x.ts'] }),
    );
    expect(
      touched.filter((item) => item.origin === 'nested').map((item) => item.path),
    ).toStrictEqual(['/home/u/repo/b/CLAUDE.md']);
  });
});
