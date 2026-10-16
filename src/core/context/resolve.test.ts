import { describe, expect, it } from 'vitest';

import type { LoadedInstruction, SkipReasonCode } from '../../shared/model.js';

import { autoMemoryDir, resolveContext, type ResolvedContext } from './resolve.js';
import { CWD, HOME, MEMORY_DIR, resolveInput } from './test-helpers/fixtures.js';
import type { MemoryTree } from './test-helpers/memory-fs.js';
import type { ResolveInput } from './types.js';

function codes(result: ResolvedContext): [string, SkipReasonCode][] {
  return result.skipped.map((item) => [item.path, item.code]);
}

function loadedPaths(result: ResolvedContext): string[] {
  return result.expected.map((item) => item.path);
}

function observed(filePath: string, overrides: Partial<LoadedInstruction> = {}): LoadedInstruction {
  return {
    path: filePath,
    tier: 'Project',
    reason: 'session_start',
    triggerPath: null,
    parentPath: null,
    globs: [],
    bytes: 42,
    differsFromDisk: false,
    loadedAt: 1000,
    ...overrides,
  };
}

const bigMemory = Array.from({ length: 250 }, (_, index) => `- line ${String(index)}\n`).join('');

const TREE: MemoryTree = {
  files: {
    '/home/u/.claude/CLAUDE.md': 'user @~/notes.md',
    '/home/u/notes.md': 'notes',
    [`${CWD}/CLAUDE.md`]: 'project @docs/a.md @~/outside.md `@README.md`',
    [`${CWD}/README.md`]: 'readme',
    [`${CWD}/AGENTS.md`]: 'agents',
    [`${CWD}/docs/a.md`]: '@b.md',
    [`${CWD}/docs/b.md`]: '@c.md',
    [`${CWD}/docs/c.md`]: '@d.md',
    [`${CWD}/docs/d.md`]: '@e.md',
    [`${CWD}/docs/e.md`]: 'too deep',
    '/home/u/outside.md': 'outside',
    [`${CWD}/.claude/rules/api.md`]: '---\npaths: "src/api/**"\n---\napi',
    [`${CWD}/.claude/rules/web.md`]: '---\npaths: "src/web/**"\n---\nweb',
    [`${CWD}/packages/api/CLAUDE.md`]: 'api',
    [`${CWD}/packages/web/CLAUDE.md`]: 'web',
    [`${CWD}/vendor/lib/CLAUDE.md`]: 'vendor',
    '/add/CLAUDE.md': 'add',
    [`${MEMORY_DIR}/MEMORY.md`]: bigMemory,
    [`${MEMORY_DIR}/topic.md`]: 'topic',
  },
};

const BASE: Partial<ResolveInput> = {
  touchedFiles: [`${CWD}/src/api/x.ts`, `${CWD}/packages/api/src/y.ts`, `${CWD}/vendor/lib/z.ts`],
  flags: { bare: false, safeMode: false, settingSources: null, addDirs: ['/add'] },
  settings: {
    claudeMdExcludes: [{ layer: 'user', patterns: ['**/vendor/**'] }],
    autoMemoryEnabled: null,
    autoMemoryDirectory: null,
    instructionFiles: null,
    env: {},
  },
};

describe('resolveContext on a full tree', () => {
  it('predicts what loads and explains every skip', async () => {
    const result = await resolveContext(resolveInput(TREE, BASE));
    expect(loadedPaths(result)).toStrictEqual([
      '/home/u/.claude/CLAUDE.md',
      `${CWD}/CLAUDE.md`,
      `${CWD}/.claude/rules/api.md`,
      `${CWD}/packages/api/CLAUDE.md`,
      `${MEMORY_DIR}/MEMORY.md`,
      '/home/u/notes.md',
      `${CWD}/docs/a.md`,
      `${CWD}/docs/b.md`,
      `${CWD}/docs/c.md`,
      `${CWD}/docs/d.md`,
    ]);
    expect(codes(result)).toStrictEqual([
      ['/etc/claude-code/CLAUDE.md', 'missing'],
      [`${CWD}/.claude/CLAUDE.md`, 'missing'],
      [`${CWD}/.claude/rules/web.md`, 'glob-not-matched'],
      [`${CWD}/CLAUDE.local.md`, 'missing'],
      [`${CWD}/AGENTS.md`, 'agents-md-shadowed'],
      [`${CWD}/packages/web/CLAUDE.md`, 'lazy-not-touched'],
      [`${CWD}/vendor/lib/CLAUDE.md`, 'excluded'],
      ['/add/CLAUDE.md', 'add-dir-without-env'],
      [`${MEMORY_DIR}/topic.md`, 'lazy-not-touched'],
      [`${CWD}/docs/e.md`, 'import-too-deep'],
      ['/home/u/outside.md', 'external-import-unapproved'],
      [`${CWD}/README.md`, 'import-in-code'],
      [`${MEMORY_DIR}/MEMORY.md`, 'memory-truncated'],
    ]);
    expect(result.unexplained).toStrictEqual([]);
    expect(result.memoryDir).toBe(MEMORY_DIR);
    expect(result.memory?.firstDroppedLine).toBe(201);
  });

  it('fills each expected entry in full', async () => {
    const result = await resolveContext(resolveInput(TREE, BASE));
    const byPath = new Map(result.expected.map((item) => [item.path, item]));
    expect(byPath.get(`${CWD}/CLAUDE.md`)).toStrictEqual({
      path: `${CWD}/CLAUDE.md`,
      tier: 'Project',
      reason: 'session_start',
      triggerPath: null,
      parentPath: null,
      globs: [],
      bytes: 45,
      differsFromDisk: null,
      loadedAt: null,
      mode: 'eager',
      detail: 'Loaded at launch.',
      observed: null,
    });
    expect(byPath.get(`${CWD}/docs/b.md`)).toMatchObject({
      tier: 'Project',
      reason: 'include',
      parentPath: `${CWD}/docs/a.md`,
      mode: 'import',
      bytes: 5,
    });
    expect(byPath.get('/home/u/notes.md')).toMatchObject({ tier: 'User', reason: 'include' });
    expect(byPath.get(`${CWD}/.claude/rules/api.md`)).toMatchObject({
      reason: 'path_glob_match',
      triggerPath: `${CWD}/src/api/x.ts`,
      globs: ['src/api/**'],
      mode: 'glob',
    });
    expect(byPath.get(`${CWD}/packages/api/CLAUDE.md`)).toMatchObject({
      reason: 'nested_traversal',
      triggerPath: `${CWD}/packages/api/src/y.ts`,
      mode: 'lazy-subdir',
    });
    expect(byPath.get(`${MEMORY_DIR}/MEMORY.md`)).toMatchObject({
      tier: 'AutoMem',
      bytes: 2090,
      mode: 'auto-memory',
    });
    const truncated = result.skipped.find((item) => item.code === 'memory-truncated');
    expect(truncated).toStrictEqual({
      path: `${MEMORY_DIR}/MEMORY.md`,
      tier: 'AutoMem',
      exists: true,
      code: 'memory-truncated',
      detail:
        'MEMORY.md has 250 lines, so lines 201 to 250 are past the 200 line limit and do not load.',
    });
    const missing = result.skipped.find((item) => item.code === 'missing');
    expect(missing).toStrictEqual({
      path: '/etc/claude-code/CLAUDE.md',
      tier: 'Managed',
      exists: false,
      code: 'missing',
      detail: 'The file does not exist.',
    });
  });

  it('turns on the add-dir files and external imports when allowed', async () => {
    const result = await resolveContext(
      resolveInput(TREE, {
        ...BASE,
        approvedExternalImports: true,
        settings: {
          ...resolveInput(TREE, BASE).settings,
          env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
        },
      }),
    );
    expect(loadedPaths(result)).toContain('/add/CLAUDE.md');
    expect(loadedPaths(result)).toContain('/home/u/outside.md');
    expect(loadedPaths(result)).not.toContain(`${CWD}/vendor/lib/CLAUDE.md`);
  });
});

describe('resolveContext switches', () => {
  const simple: MemoryTree = {
    files: {
      '/etc/claude-code/CLAUDE.md': 'managed',
      '/home/u/.claude/CLAUDE.md': 'user',
      [`${CWD}/CLAUDE.md`]: 'project',
      [`${CWD}/CLAUDE.local.md`]: 'local',
      [`${MEMORY_DIR}/MEMORY.md`]: 'memory',
    },
  };

  it('turns off CLAUDE.md in bare mode but keeps no auto memory either', async () => {
    const result = await resolveContext(
      resolveInput(simple, {
        flags: { bare: true, safeMode: false, settingSources: null, addDirs: [] },
      }),
    );
    expect(loadedPaths(result)).toStrictEqual([]);
    expect(codes(result)).toStrictEqual([
      ['/etc/claude-code/CLAUDE.md', 'claude-md-disabled'],
      ['/home/u/.claude/CLAUDE.md', 'claude-md-disabled'],
      [`${CWD}/CLAUDE.md`, 'claude-md-disabled'],
      [`${CWD}/.claude/CLAUDE.md`, 'missing'],
      [`${CWD}/CLAUDE.local.md`, 'claude-md-disabled'],
      [`${MEMORY_DIR}/MEMORY.md`, 'auto-memory-disabled'],
    ]);
  });

  it('follows --setting-sources', async () => {
    const result = await resolveContext(
      resolveInput(simple, {
        flags: { bare: false, safeMode: false, settingSources: ['user'], addDirs: [] },
      }),
    );
    expect(loadedPaths(result)).toStrictEqual([
      '/etc/claude-code/CLAUDE.md',
      '/home/u/.claude/CLAUDE.md',
      `${MEMORY_DIR}/MEMORY.md`,
    ]);
    expect(codes(result).filter(([, code]) => code === 'setting-source-excluded')).toStrictEqual([
      [`${CWD}/CLAUDE.md`, 'setting-source-excluded'],
      [`${CWD}/CLAUDE.local.md`, 'setting-source-excluded'],
    ]);
  });

  it('starts an omitClaudeMd subagent with only managed files', async () => {
    const result = await resolveContext(
      resolveInput(simple, { agent: { isSubagent: true, omitClaudeMd: true } }),
    );
    expect(loadedPaths(result)).toStrictEqual(['/etc/claude-code/CLAUDE.md']);
    expect(codes(result)).toStrictEqual([
      ['/home/u/.claude/CLAUDE.md', 'omit-claude-md'],
      [`${CWD}/CLAUDE.md`, 'omit-claude-md'],
      [`${CWD}/.claude/CLAUDE.md`, 'missing'],
      [`${CWD}/CLAUDE.local.md`, 'omit-claude-md'],
      [`${MEMORY_DIR}/MEMORY.md`, 'not-passed-to-subagent'],
    ]);
  });

  it('does not report a truncation for a MEMORY.md that does not load', async () => {
    const tree: MemoryTree = { files: { [`${MEMORY_DIR}/MEMORY.md`]: bigMemory } };
    const result = await resolveContext(
      resolveInput(tree, { agent: { isSubagent: true, omitClaudeMd: false } }),
    );
    expect(result.skipped.some((item) => item.code === 'memory-truncated')).toBe(false);
    expect(result.memory?.truncated).toBe(true);
  });

  it('reports no memory cut when MEMORY.md is missing', async () => {
    const result = await resolveContext(resolveInput({ files: {} }));
    expect(result.memory).toBeNull();
    expect(result.expected).toStrictEqual([]);
  });

  it('does not skip a shadowed AGENTS.md that CLAUDE.md imports', async () => {
    const tree: MemoryTree = {
      files: { [`${CWD}/CLAUDE.md`]: '@AGENTS.md', [`${CWD}/AGENTS.md`]: 'agents' },
    };
    const result = await resolveContext(resolveInput(tree));
    expect(loadedPaths(result)).toStrictEqual([`${CWD}/CLAUDE.md`, `${CWD}/AGENTS.md`]);
    expect(result.skipped.some((item) => item.path === `${CWD}/AGENTS.md`)).toBe(false);
  });

  it('drops code span mentions of files that do not exist and walks lazily loaded files', async () => {
    const tree: MemoryTree = {
      files: { [`${CWD}/pkg/CLAUDE.md`]: '`@nothing.md` @real.md', [`${CWD}/pkg/real.md`]: 'real' },
    };
    const result = await resolveContext(resolveInput(tree, { touchedFiles: [`${CWD}/pkg/x.ts`] }));
    expect(loadedPaths(result)).toStrictEqual([`${CWD}/pkg/CLAUDE.md`, `${CWD}/pkg/real.md`]);
    expect(result.skipped.some((item) => item.path.endsWith('nothing.md'))).toBe(false);
  });

  it('normalizes relative touched paths', async () => {
    const tree: MemoryTree = { files: { [`${CWD}/pkg/CLAUDE.md`]: 'x' } };
    const result = await resolveContext(
      resolveInput(tree, { touchedFiles: [`${CWD}/pkg/../pkg/x.ts`] }),
    );
    expect(loadedPaths(result)).toStrictEqual([`${CWD}/pkg/CLAUDE.md`]);
  });

  it('uses the default scan limits unless given others', async () => {
    const tree: MemoryTree = { files: { [`${CWD}/pkg/CLAUDE.md`]: 'x' } };
    const scanned = await resolveContext(resolveInput(tree));
    expect(codes(scanned)).toContainEqual([`${CWD}/pkg/CLAUDE.md`, 'lazy-not-touched']);
    const limited = await resolveContext(resolveInput(tree, { scan: { maxDirs: 0, maxDepth: 0 } }));
    expect(codes(limited).some(([file]) => file === `${CWD}/pkg/CLAUDE.md`)).toBe(false);
  });
});

describe('resolveContext and AGENTS.md', () => {
  it('reads AGENTS.md when only user files, rules and nested CLAUDE.md files exist', async () => {
    const tree: MemoryTree = {
      files: {
        '/home/u/.claude/CLAUDE.md': 'user',
        [`${CWD}/.claude/rules/r.md`]: 'rule',
        [`${CWD}/AGENTS.md`]: 'agents',
        [`${CWD}/sub/CLAUDE.md`]: 'nested',
      },
    };
    const result = await resolveContext(resolveInput(tree));
    expect(loadedPaths(result)).toContain(`${CWD}/AGENTS.md`);
  });

  it('lets CLAUDE.local.md in an ancestor shadow AGENTS.md', async () => {
    const tree: MemoryTree = {
      files: { '/home/u/CLAUDE.local.md': 'local', [`${CWD}/AGENTS.md`]: 'agents' },
    };
    const result = await resolveContext(resolveInput(tree));
    expect(codes(result)).toContainEqual([`${CWD}/AGENTS.md`, 'agents-md-shadowed']);
  });

  it('shadows a nested AGENTS.md only by its own directory', async () => {
    const tree: MemoryTree = {
      files: {
        [`${CWD}/CLAUDE.md`]: 'root',
        [`${CWD}/a/CLAUDE.local.md`]: 'own local',
        [`${CWD}/a/AGENTS.md`]: 'shadowed',
        [`${CWD}/b/AGENTS.md`]: 'loads',
      },
    };
    const result = await resolveContext(
      resolveInput(tree, { touchedFiles: [`${CWD}/a/x.ts`, `${CWD}/b/x.ts`] }),
    );
    expect(codes(result)).toContainEqual([`${CWD}/a/AGENTS.md`, 'agents-md-shadowed']);
    expect(loadedPaths(result)).toContain(`${CWD}/b/AGENTS.md`);
    expect(loadedPaths(result)).toContain(`${CWD}/a/CLAUDE.local.md`);
  });
});

describe('resolveContext imports', () => {
  it('walks each file once, even when one loaded file imports another', async () => {
    const tree: MemoryTree = {
      files: {
        [`${CWD}/CLAUDE.md`]: '@CLAUDE.local.md @shared.md',
        [`${CWD}/CLAUDE.local.md`]: '@shared.md',
        [`${CWD}/shared.md`]: 'shared',
      },
    };
    const result = await resolveContext(resolveInput(tree));
    expect(loadedPaths(result)).toStrictEqual([
      `${CWD}/CLAUDE.md`,
      `${CWD}/CLAUDE.local.md`,
      `${CWD}/shared.md`,
    ]);
    expect(result.expected[2]).toStrictEqual({
      path: `${CWD}/shared.md`,
      tier: 'Project',
      reason: 'include',
      triggerPath: null,
      parentPath: `${CWD}/CLAUDE.md`,
      globs: [],
      bytes: 6,
      differsFromDisk: null,
      loadedAt: null,
      mode: 'import',
      detail: 'Imported with @ by another instruction file.',
      observed: null,
    });
  });

  it('does not treat @ in MEMORY.md as an import', async () => {
    const tree: MemoryTree = {
      files: { [`${MEMORY_DIR}/MEMORY.md`]: '- see @topic.md', [`${MEMORY_DIR}/topic.md`]: 't' },
    };
    const result = await resolveContext(resolveInput(tree));
    expect(loadedPaths(result)).toStrictEqual([`${MEMORY_DIR}/MEMORY.md`]);
    expect(codes(result)).toContainEqual([`${MEMORY_DIR}/topic.md`, 'lazy-not-touched']);
  });
});

describe('resolveContext with observed loads', () => {
  const tree: MemoryTree = {
    files: {
      [`${CWD}/CLAUDE.md`]: 'project',
      [`${CWD}/pkg/CLAUDE.md`]: 'lazy',
      [`${CWD}/real/CLAUDE.md`]: 'linked',
    },
    links: { [`${CWD}/linked`]: `${CWD}/real` },
  };

  it('treats observations as the truth and lists surprises', async () => {
    const seenProject = observed(`${CWD}/CLAUDE.md`, { bytes: 7 });
    const seenLazy = observed(`${CWD}/pkg/CLAUDE.md`, {
      reason: 'nested_traversal',
      triggerPath: `${CWD}/pkg/a.ts`,
    });
    const stranger = observed('/somewhere/else.md');
    const result = await resolveContext(
      resolveInput(tree, { observedLoaded: [seenProject, seenLazy, stranger] }),
    );
    const byPath = new Map(result.expected.map((item) => [item.path, item]));
    expect(byPath.get(`${CWD}/CLAUDE.md`)).toStrictEqual({
      ...seenProject,
      mode: 'eager',
      detail: 'Loaded at launch.',
      observed: true,
    });
    expect(byPath.get(`${CWD}/pkg/CLAUDE.md`)).toStrictEqual({
      ...seenLazy,
      mode: 'lazy-subdir',
      detail: 'The session shows it loaded, although the rules predicted lazy-not-touched.',
      observed: true,
    });
    expect(result.unexplained).toStrictEqual([seenLazy, stranger]);
    expect(result.skipped.some((item) => item.path === `${CWD}/pkg/CLAUDE.md`)).toBe(false);
  });

  it('marks predicted loads the session did not show', async () => {
    const result = await resolveContext(
      resolveInput(tree, { observedLoaded: [observed('/somewhere/else.md')] }),
    );
    expect(result.expected.find((item) => item.path === `${CWD}/CLAUDE.md`)?.observed).toBe(false);
  });

  it('matches an observation by the real path of a linked file', async () => {
    const linkedTree: MemoryTree = {
      files: { '/shared/rule.md': 'rule' },
      links: { [`${CWD}/.claude/rules/rule.md`]: '/shared/rule.md' },
    };
    const seen = observed('/shared/rule.md');
    const result = await resolveContext(
      resolveInput(linkedTree, { observedLoaded: [seen], approvedExternalImports: true }),
    );
    expect(
      result.expected.find((item) => item.path === `${CWD}/.claude/rules/rule.md`)?.observed,
    ).toBe(true);
    expect(result.unexplained).toStrictEqual([]);
  });

  it('normalizes observed paths', async () => {
    const seen = observed(`${CWD}/./CLAUDE.md`);
    const result = await resolveContext(resolveInput(tree, { observedLoaded: [seen] }));
    expect(result.expected.find((item) => item.path === `${CWD}/CLAUDE.md`)?.observed).toBe(true);
  });
});

describe('autoMemoryDir', () => {
  const base = resolveInput({ files: {} });

  it('keys the project dir by the git root, else cwd', () => {
    expect(autoMemoryDir({ ...base, gitRoot: '/home/u/main' })).toBe(
      '/home/u/.claude/projects/-home-u-main/memory',
    );
    expect(autoMemoryDir({ ...base, gitRoot: null })).toBe(MEMORY_DIR);
  });

  it('honors autoMemoryDirectory with ~ expansion', () => {
    const settings = (dir: string | null): ResolveInput['settings'] => ({
      ...base.settings,
      autoMemoryDirectory: dir,
    });
    expect(autoMemoryDir({ ...base, settings: settings('~/mem') })).toBe(`${HOME}/mem`);
    expect(autoMemoryDir({ ...base, settings: settings('/abs/mem/') })).toBe('/abs/mem');
    expect(autoMemoryDir({ ...base, settings: settings('') })).toBe(MEMORY_DIR);
  });

  it('uses CLAUDE_CODE_PROJECT_DIR_NAME only with CLAUDE_CONFIG_DIR', () => {
    const env = (values: Record<string, string>): ResolveInput['settings'] => ({
      ...base.settings,
      env: values,
    });
    expect(
      autoMemoryDir({
        ...base,
        settings: env({ CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_PROJECT_DIR_NAME: 'work' }),
      }),
    ).toBe('/home/u/.claude/projects/work/memory');
    expect(
      autoMemoryDir({ ...base, settings: env({ CLAUDE_CODE_PROJECT_DIR_NAME: 'work' }) }),
    ).toBe(MEMORY_DIR);
    expect(autoMemoryDir({ ...base, settings: env({ CLAUDE_CONFIG_DIR: '/c' }) })).toBe(MEMORY_DIR);
    expect(
      autoMemoryDir({
        ...base,
        settings: env({ CLAUDE_CONFIG_DIR: '', CLAUDE_CODE_PROJECT_DIR_NAME: 'work' }),
      }),
    ).toBe(MEMORY_DIR);
    expect(
      autoMemoryDir({
        ...base,
        settings: env({ CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_PROJECT_DIR_NAME: '' }),
      }),
    ).toBe(MEMORY_DIR);
  });
});
