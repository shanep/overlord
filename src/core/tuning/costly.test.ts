import { describe, expect, it } from 'vitest';

import { costlySessions, hotFiles, spendSlices } from './costly.js';
import { zeroSpend } from './spend.js';
import { measureOf } from './test-helpers/fixtures.js';

const BIG = measureOf({
  sessionId: 'big',
  title: 'Big refactor',
  cwd: '/work/demo',
  requests: 400,
  contextTokens: 400 * 300_000,
  peakContext: 600_000,
  cost: { input: 0, output: 4, cacheRead: 30, cacheWrite: 6 },
  compactSavingUsd: 12,
  subagentUsd: 10,
  spend: { ...zeroSpend(), fileReads: 20, setup: 8, toolInputs: 8, output: 4 },
  subagentSpend: { ...zeroSpend(), fileReads: 6, setup: 4 },
  files: { '/work/demo/src/app.ts': 9, '/other/notes.md': 1 },
  toolSchemas: { Artifact: 3, Bash: 1 },
  heavy: [{ source: 'fileReads', label: 'Read /work/demo/src/app.ts', tokens: 40_000, usd: 9 }],
  subagents: [
    {
      type: 'general-purpose',
      description: 'Build it',
      usd: 10,
      requests: 90,
      peakContext: 300_000,
    },
  ],
  idleRewrites: 2,
  idleRewriteUsd: 5,
});

describe('spendSlices', () => {
  it('lists the sources that cost anything, biggest first, with shares', () => {
    expect(spendSlices({ ...zeroSpend(), setup: 1, fileReads: 3 })).toStrictEqual([
      { source: 'fileReads', label: 'Reading files', usd: 3, share: 0.75 },
      { source: 'setup', label: 'System prompt and tool definitions', usd: 1, share: 0.25 },
    ]);
    expect(spendSlices(zeroSpend())).toStrictEqual([]);
  });
});

describe('costlySessions', () => {
  it('takes the expensive sessions apart, the biggest saving first', () => {
    const [session, ...rest] = costlySessions([measureOf(), BIG], new Set(['Artifact']));
    expect(rest).toStrictEqual([]);
    expect(session).toMatchObject({ sessionId: 'big', usd: 50, averageContext: 300_000 });
    expect(session?.causes.map((cause) => [cause.id, cause.savedUsd, cause.tipId])).toStrictEqual([
      ['context', 12, 'huge-context'],
      ['idle', 5, 'idle-rewrite'],
      ['setup', 3, 'unused-tools'],
      ['file-reads', null, 'file-reads'],
      ['subagents', null, 'subagent-model'],
      ['tool-inputs', null, null],
      ['output', null, null],
    ]);
    expect(session?.causes[3]?.text).toContain('most of all src/app.ts ($9.00)');
    expect(session?.heavy[0]?.label).toBe('Read src/app.ts');
    expect(session?.spend[0]).toMatchObject({ source: 'fileReads', usd: 26 });
  });

  it('leaves out cheap sessions', () => {
    expect(costlySessions([measureOf()], new Set())).toStrictEqual([]);
  });
});

describe('hotFiles', () => {
  it('adds up the same file read from different worktrees of one project', () => {
    const one = measureOf({ cwd: '/wt/a', files: { '/wt/a/src/app.ts': 2 } });
    const two = measureOf({ cwd: '/wt/b', files: { '/wt/b/src/app.ts': 3, '/repo/README.md': 1 } });
    expect(
      hotFiles([one, two, measureOf({ cwd: null, files: { '/x.ts': 1 } })], () => '/repo'),
    ).toStrictEqual([
      { project: '/repo', path: 'src/app.ts', usd: 5, sessions: 2 },
      { project: '/repo', path: 'README.md', usd: 1, sessions: 1 },
      { project: '', path: '/x.ts', usd: 1, sessions: 1 },
    ]);
  });
});
