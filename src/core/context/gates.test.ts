import { describe, expect, it } from 'vitest';

import { judge, MAX_INSTRUCTION_BYTES, type Verdict } from './gates.js';
import { candidate, CWD, gateContext } from './test-helpers/fixtures.js';
import type { Candidate } from './types.js';

const LAUNCH: Verdict = {
  load: true,
  reason: 'session_start',
  triggerPath: null,
  detail: 'Loaded at launch.',
};

function settingsWith(
  overrides: Partial<ReturnType<typeof gateContext>['settings']>,
): ReturnType<typeof gateContext>['settings'] {
  return { ...gateContext().settings, ...overrides };
}

function flagsWith(
  overrides: Partial<ReturnType<typeof gateContext>['flags']>,
): ReturnType<typeof gateContext>['flags'] {
  return { ...gateContext().flags, ...overrides };
}

const memoryIndex: Candidate = candidate({
  path: '/m/MEMORY.md',
  tier: 'AutoMem',
  kind: 'memory-index',
  mode: 'auto-memory',
  origin: 'auto-memory',
  ownerDir: '/m',
});

describe('judge basics', () => {
  it('loads a plain project file at launch', () => {
    expect(judge(candidate(), gateContext())).toStrictEqual(LAUNCH);
  });

  it('reports a missing file first', () => {
    const context = gateContext({ flags: flagsWith({ bare: true }) });
    expect(judge(candidate({ exists: false, text: null }), context)).toStrictEqual({
      load: false,
      code: 'missing',
      detail: 'The file does not exist.',
    });
  });

  it('skips files over 4 MiB but not auto memory', () => {
    expect(MAX_INSTRUCTION_BYTES).toBe(4_194_304);
    const big = MAX_INSTRUCTION_BYTES + 1;
    expect(judge(candidate({ bytes: big }), gateContext())).toStrictEqual({
      load: false,
      code: 'excluded',
      detail: 'The file is larger than 4 MiB, so Claude Code skips it.',
    });
    expect(judge(candidate({ bytes: MAX_INSTRUCTION_BYTES }), gateContext())).toStrictEqual(LAUNCH);
    expect(judge({ ...memoryIndex, bytes: big }, gateContext()).load).toBe(true);
  });
});

describe('CLAUDE.md switches', () => {
  it('turns everything off with CLAUDE_CODE_DISABLE_CLAUDE_MDS, auto memory included', () => {
    const context = gateContext({
      settings: settingsWith({ env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: 'true' } }),
    });
    const off: Verdict = {
      load: false,
      code: 'claude-md-disabled',
      detail:
        'CLAUDE_CODE_DISABLE_CLAUDE_MDS is set, which turns off every CLAUDE.md and auto memory file.',
    };
    expect(judge(candidate(), context)).toStrictEqual(off);
    expect(judge(candidate({ tier: 'Managed', origin: 'managed' }), context)).toStrictEqual(off);
    expect(judge(memoryIndex, context)).toStrictEqual(off);
    const unset = gateContext({
      settings: settingsWith({ env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0' } }),
    });
    expect(judge(candidate(), unset)).toStrictEqual(LAUNCH);
  });

  it('turns CLAUDE.md off in safe mode, managed included', () => {
    const context = gateContext({ flags: flagsWith({ safeMode: true, bare: true }) });
    const off: Verdict = {
      load: false,
      code: 'claude-md-disabled',
      detail:
        'The session runs with --safe-mode, which loads no CLAUDE.md files, managed ones included.',
    };
    expect(judge(candidate(), context)).toStrictEqual(off);
    expect(judge(candidate({ tier: 'Managed', origin: 'managed' }), context)).toStrictEqual(off);
  });

  it('turns CLAUDE.md off in bare mode', () => {
    const context = gateContext({ flags: flagsWith({ bare: true }) });
    expect(judge(candidate({ kind: 'rule' }), context)).toStrictEqual({
      load: false,
      code: 'claude-md-disabled',
      detail: 'The session runs with --bare, which skips CLAUDE.md discovery.',
    });
  });
});

describe('managed files', () => {
  it('load whatever settings say', () => {
    const context = gateContext({
      settings: settingsWith({
        claudeMdExcludes: [{ layer: 'user', patterns: ['**'] }],
        instructionFiles: 'managed-only',
      }),
      flags: flagsWith({ settingSources: [] }),
      agent: { isSubagent: true, omitClaudeMd: true },
    });
    expect(judge(candidate({ tier: 'Managed', origin: 'managed' }), context)).toStrictEqual({
      load: true,
      reason: 'session_start',
      triggerPath: null,
      detail: 'Managed policy file, which settings cannot exclude.',
    });
  });

  it('still check their imports for code and depth, but not excludes or approval', () => {
    const context = gateContext({
      settings: settingsWith({ claudeMdExcludes: [{ layer: 'user', patterns: ['**'] }] }),
    });
    const imported = candidate({
      tier: 'Managed',
      kind: 'import',
      mode: 'import',
      path: '/etc/x.md',
      depth: 1,
    });
    expect(judge(imported, context)).toStrictEqual({
      load: true,
      reason: 'include',
      triggerPath: null,
      detail: 'Imported with @ by another instruction file.',
    });
    expect(judge({ ...imported, inCode: true }, context).load).toBe(false);
  });
});

function memory(overrides: Partial<ReturnType<typeof gateContext>> = {}): Verdict {
  return judge(memoryIndex, gateContext(overrides));
}

function memoryOff(detail: string): Verdict {
  return { load: false, code: 'auto-memory-disabled', detail };
}

describe('auto memory', () => {
  it('loads the index at launch', () => {
    expect(memory()).toStrictEqual({
      load: true,
      reason: 'session_start',
      triggerPath: null,
      detail: 'Auto memory index, loaded at launch.',
    });
  });

  it('honors safe mode over everything', () => {
    const settings = settingsWith({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' } });
    expect(memory({ flags: flagsWith({ safeMode: true }), settings })).toStrictEqual(
      memoryOff('The session runs with --safe-mode, which turns off auto memory.'),
    );
  });

  it('honors CLAUDE_CODE_DISABLE_AUTO_MEMORY', () => {
    expect(
      memory({ settings: settingsWith({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } }) }),
    ).toStrictEqual(
      memoryOff('CLAUDE_CODE_DISABLE_AUTO_MEMORY is set, which turns off auto memory.'),
    );
  });

  it('lets CLAUDE_CODE_DISABLE_AUTO_MEMORY=0 force it on over the setting and bare mode', () => {
    const settings = settingsWith({
      autoMemoryEnabled: false,
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: 'false' },
    });
    expect(memory({ settings, flags: flagsWith({ bare: true }) }).load).toBe(true);
  });

  it('honors autoMemoryEnabled false and bare mode', () => {
    expect(memory({ settings: settingsWith({ autoMemoryEnabled: false }) })).toStrictEqual(
      memoryOff('autoMemoryEnabled is false in settings, which turns off auto memory.'),
    );
    expect(memory({ settings: settingsWith({ autoMemoryEnabled: true }) }).load).toBe(true);
    expect(memory({ flags: flagsWith({ bare: true }) })).toStrictEqual(
      memoryOff('The session runs with --bare, which skips auto memory.'),
    );
  });

  it('is not passed to subagents', () => {
    expect(memory({ agent: { isSubagent: true, omitClaudeMd: false } })).toStrictEqual({
      load: false,
      code: 'not-passed-to-subagent',
      detail: "Subagents do not get the main conversation's auto memory.",
    });
  });

  it('loads topic files only on demand', () => {
    expect(
      judge({ ...memoryIndex, kind: 'memory-topic', path: '/m/t.md' }, gateContext()),
    ).toStrictEqual({
      load: false,
      code: 'lazy-not-touched',
      detail: 'Auto memory topic files load only when Claude reads them.',
    });
  });
});

describe('project instructions setting', () => {
  it('managed-only drops eager files but not lazy ones', () => {
    const context = gateContext({ settings: settingsWith({ instructionFiles: 'managed-only' }) });
    expect(judge(candidate(), context)).toStrictEqual({
      load: false,
      code: 'excluded',
      detail:
        'Project instructions is set to managed-only, so only managed CLAUDE.md and auto memory load at launch.',
    });
    expect(judge(candidate({ mode: 'lazy-subdir', ownerDir: `${CWD}/a` }), context).load).toBe(
      false,
    );
    expect(judge(candidate({ mode: 'lazy-subdir', ownerDir: `${CWD}/a` }), context)).toHaveProperty(
      'code',
      'lazy-not-touched',
    );
  });

  it('claude-md drops AGENTS.md only', () => {
    const context = gateContext({ settings: settingsWith({ instructionFiles: 'claude-md' }) });
    expect(judge(candidate({ kind: 'agents-md' }), context)).toStrictEqual({
      load: false,
      code: 'excluded',
      detail: 'Project instructions is set to claude-md, so AGENTS.md is not read.',
    });
    expect(judge(candidate(), context)).toStrictEqual(LAUNCH);
  });
});

describe('setting sources', () => {
  it('skips tiers whose source is left out', () => {
    const context = gateContext({ flags: flagsWith({ settingSources: ['user'] }) });
    expect(judge(candidate(), context)).toStrictEqual({
      load: false,
      code: 'setting-source-excluded',
      detail: '--setting-sources leaves out project, so project instruction files are skipped.',
    });
    expect(judge(candidate({ tier: 'Local', kind: 'local-md' }), context)).toStrictEqual({
      load: false,
      code: 'setting-source-excluded',
      detail: '--setting-sources leaves out local, so local instruction files are skipped.',
    });
    expect(judge(candidate({ tier: 'User', origin: 'user' }), context)).toStrictEqual(LAUNCH);
    const noUser = gateContext({ flags: flagsWith({ settingSources: ['project', 'local'] }) });
    expect(judge(candidate({ tier: 'User', origin: 'user' }), noUser)).toHaveProperty(
      'detail',
      '--setting-sources leaves out user, so user instruction files are skipped.',
    );
    expect(judge(candidate({ tier: 'Local' }), noUser)).toStrictEqual(LAUNCH);
  });
});

describe('add-dir, omitClaudeMd and excludes', () => {
  it('needs the env var for --add-dir files', () => {
    const file = candidate({ origin: 'add-dir', path: '/other/CLAUDE.md', ownerDir: '/other' });
    expect(judge(file, gateContext())).toStrictEqual({
      load: false,
      code: 'add-dir-without-env',
      detail:
        'It sits in an --add-dir directory, which loads instruction files only with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1.',
    });
    const on = gateContext({
      settings: settingsWith({ env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' } }),
    });
    expect(judge(file, on)).toStrictEqual(LAUNCH);
  });

  it('skips eager files for an omitClaudeMd subagent only', () => {
    const omit = gateContext({ agent: { isSubagent: true, omitClaudeMd: true } });
    expect(judge(candidate(), omit)).toStrictEqual({
      load: false,
      code: 'omit-claude-md',
      detail:
        'This subagent sets omitClaudeMd, so it starts without user, project and local CLAUDE.md files.',
    });
    expect(judge(candidate({ mode: 'glob', globs: ['**'] }), omit)).toHaveProperty(
      'code',
      'glob-not-matched',
    );
    expect(
      judge(candidate(), gateContext({ agent: { isSubagent: false, omitClaudeMd: true } })),
    ).toStrictEqual(LAUNCH);
    expect(
      judge(candidate(), gateContext({ agent: { isSubagent: true, omitClaudeMd: false } })),
    ).toStrictEqual(LAUNCH);
  });

  it('names the pattern and layer for claudeMdExcludes, matching the path or its link target', () => {
    const context = gateContext({
      settings: settingsWith({
        claudeMdExcludes: [
          { layer: 'managed', patterns: ['/nothing/**'] },
          { layer: 'project-local', patterns: ['', '**/vendor/**'] },
          { layer: 'cli', patterns: ['/real/**'] },
        ],
      }),
    });
    expect(judge(candidate({ path: `${CWD}/vendor/CLAUDE.md` }), context)).toStrictEqual({
      load: false,
      code: 'excluded',
      detail: 'Excluded by claudeMdExcludes pattern **/vendor/** in local project settings.',
    });
    expect(judge(candidate({ realPath: '/real/r.md', kind: 'rule' }), context)).toHaveProperty(
      'detail',
      'Excluded by claudeMdExcludes pattern /real/** in --settings.',
    );
    expect(judge(candidate({ realPath: null }), context)).toStrictEqual(LAUNCH);
  });

  it('labels every settings layer', () => {
    const labels: [Parameters<typeof settingsWith>[0], string][] = [
      [{ claudeMdExcludes: [{ layer: 'managed', patterns: ['**'] }] }, 'managed settings'],
      [{ claudeMdExcludes: [{ layer: 'project', patterns: ['**'] }] }, 'project settings'],
      [{ claudeMdExcludes: [{ layer: 'user', patterns: ['**'] }] }, 'user settings'],
      [{ claudeMdExcludes: [{ layer: 'env', patterns: ['**'] }] }, 'the environment'],
      [{ claudeMdExcludes: [{ layer: 'default', patterns: ['**'] }] }, 'the defaults'],
    ];
    for (const [settings, label] of labels) {
      expect(judge(candidate(), gateContext({ settings: settingsWith(settings) }))).toHaveProperty(
        'detail',
        `Excluded by claudeMdExcludes pattern ** in ${label}.`,
      );
    }
  });
});

describe('AGENTS.md', () => {
  const agents = candidate({ kind: 'agents-md', path: `${CWD}/AGENTS.md` });

  it('loads when no CLAUDE.md exists at or above cwd', () => {
    expect(judge(agents, gateContext())).toStrictEqual(LAUNCH);
  });

  it('is shadowed by an ancestor CLAUDE.md unless both are read', () => {
    expect(judge(agents, gateContext({ ancestorHasClaudeMd: true }))).toStrictEqual({
      load: false,
      code: 'agents-md-shadowed',
      detail:
        'AGENTS.md is skipped because a CLAUDE.md or CLAUDE.local.md exists in the working directory or above it.',
    });
    const both = gateContext({
      ancestorHasClaudeMd: true,
      settings: settingsWith({ instructionFiles: 'claude-md-and-agents-md' }),
    });
    expect(judge(agents, both)).toStrictEqual(LAUNCH);
    expect(judge(candidate(), gateContext({ ancestorHasClaudeMd: true }))).toStrictEqual(LAUNCH);
  });

  it('is shadowed in a subdirectory only by that directory', () => {
    const nested = candidate({
      kind: 'agents-md',
      origin: 'nested',
      mode: 'lazy-subdir',
      ownerDir: `${CWD}/a`,
    });
    const touched = [`${CWD}/a/x.ts`];
    expect(
      judge(nested, gateContext({ nestedClaudeMdDirs: new Set([`${CWD}/a`]), touched })),
    ).toStrictEqual({
      load: false,
      code: 'agents-md-shadowed',
      detail:
        'AGENTS.md is skipped because its directory has its own CLAUDE.md or CLAUDE.local.md.',
    });
    expect(
      judge(
        nested,
        gateContext({
          ancestorHasClaudeMd: true,
          nestedClaudeMdDirs: new Set([`${CWD}/b`]),
          touched,
        }),
      ).load,
    ).toBe(true);
  });
});

describe('external files', () => {
  const external = candidate({ kind: 'import', mode: 'import', path: '/elsewhere/x.md', depth: 1 });

  it('holds external imports from project files until approved', () => {
    expect(judge(external, gateContext())).toStrictEqual({
      load: false,
      code: 'external-import-unapproved',
      detail:
        'It imports a file outside the working directory, which waits for the one-time external import approval.',
    });
    expect(judge(external, gateContext({ approvedExternalImports: true })).load).toBe(true);
    expect(judge({ ...external, tier: 'User' }, gateContext()).load).toBe(true);
    expect(judge({ ...external, tier: 'Local' }, gateContext()).load).toBe(false);
    expect(judge(external, gateContext({ workDirs: [CWD, '/elsewhere'] })).load).toBe(true);
    expect(judge({ ...external, path: `${CWD}/docs/x.md` }, gateContext()).load).toBe(true);
  });

  it('holds rule symlinks that point outside the working directory', () => {
    const linked = candidate({
      kind: 'rule',
      path: `${CWD}/.claude/rules/s.md`,
      realPath: '/shared/s.md',
    });
    expect(judge(linked, gateContext())).toStrictEqual({
      load: false,
      code: 'external-import-unapproved',
      detail:
        'It links to a rule outside the working directory, which waits for the one-time external import approval.',
    });
    expect(judge({ ...linked, realPath: `${CWD}/shared/s.md` }, gateContext()).load).toBe(true);
    expect(judge({ ...linked, realPath: null }, gateContext()).load).toBe(true);
    expect(judge({ ...linked, kind: 'claude-md' }, gateContext()).load).toBe(true);
    const above = candidate({
      kind: 'rule',
      path: '/home/u/.claude/rules/x.md',
      realPath: '/home/u/.claude/rules/x.md',
    });
    expect(judge(above, gateContext()).load).toBe(true);
  });
});

describe('imports', () => {
  const imported = candidate({ kind: 'import', mode: 'import', path: `${CWD}/a.md`, depth: 4 });

  it('loads an import within four hops', () => {
    expect(judge(imported, gateContext()).load).toBe(true);
  });

  it('flags imports in code and past four hops', () => {
    expect(judge({ ...imported, inCode: true, depth: 9 }, gateContext())).toStrictEqual({
      load: false,
      code: 'import-in-code',
      detail: 'The @ reference sits in a code span or fenced code block, so it is not an import.',
    });
    expect(judge({ ...imported, depth: 5 }, gateContext())).toStrictEqual({
      load: false,
      code: 'import-too-deep',
      detail: 'It is 5 imports deep, past the limit of 4 hops.',
    });
  });

  it('skips the tier checks, which the parent already passed', () => {
    const context = gateContext({
      flags: flagsWith({ settingSources: [] }),
      agent: { isSubagent: true, omitClaudeMd: true },
    });
    expect(judge(imported, context).load).toBe(true);
    const excluded = gateContext({
      settings: settingsWith({ claudeMdExcludes: [{ layer: 'user', patterns: ['**/a.md'] }] }),
    });
    expect(judge(imported, excluded)).toHaveProperty('code', 'excluded');
  });
});

describe('lazy and glob files', () => {
  it('loads a nested file once a file under its dir is touched', () => {
    const nested = candidate({
      mode: 'lazy-subdir',
      origin: 'nested',
      ownerDir: `${CWD}/packages/api`,
    });
    expect(judge(nested, gateContext({ touched: [`${CWD}/packages/web/x.ts`] }))).toStrictEqual({
      load: false,
      code: 'lazy-not-touched',
      detail: 'Only loads after Claude touches a file under packages/api.',
    });
    expect(
      judge(
        nested,
        gateContext({
          touched: ['/other/x.ts', `${CWD}/packages/api/src/a.ts`, `${CWD}/packages/api/b.ts`],
        }),
      ),
    ).toStrictEqual({
      load: true,
      reason: 'nested_traversal',
      triggerPath: `${CWD}/packages/api/src/a.ts`,
      detail: 'Loaded when Claude touched a file under packages/api.',
    });
  });

  it('loads a glob rule once a touched file matches, relative to its owner dir', () => {
    const rule = candidate({
      kind: 'rule',
      mode: 'glob',
      globs: ['src/**/*.ts', 'lib/*.js'],
      ownerDir: CWD,
    });
    expect(
      judge(rule, gateContext({ touched: [`${CWD}/README.md`, '/elsewhere/src/a.ts'] })),
    ).toStrictEqual({
      load: false,
      code: 'glob-not-matched',
      detail: 'Its paths globs (src/**/*.ts, lib/*.js) have not matched a file Claude touched.',
    });
    expect(
      judge(
        rule,
        gateContext({ touched: [`${CWD}/README.md`, `${CWD}/lib/x.js`, `${CWD}/src/a.ts`] }),
      ),
    ).toStrictEqual({
      load: true,
      reason: 'path_glob_match',
      triggerPath: `${CWD}/lib/x.js`,
      detail: 'Loaded when a touched file matched its paths globs.',
    });
  });
});
