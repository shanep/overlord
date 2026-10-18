import { describe, expect, it } from 'vitest';

import type { FixContext } from './fixes.js';
import { autoFixesFor, unusedTools } from './fixes.js';
import { HOME, measureOf } from './test-helpers/fixtures.js';
import { totalsOf } from './totals.js';

function sessions(
  count: number,
  extra: Parameters<typeof measureOf>[0],
): ReturnType<typeof measureOf>[] {
  return Array.from({ length: count }, (_, index) =>
    measureOf({ sessionId: `s${index.toString()}`, ...extra }),
  );
}

const MEASURES = [
  ...sessions(9, { toolSchemas: { Artifact: 0.2, Bash: 0.1 }, toolUses: { Bash: 4 } }),
  measureOf({
    sessionId: 'worst',
    cwd: '/wt/one',
    denials: 9,
    toolSchemas: { Artifact: 0.2, Bash: 0.1 },
    toolUses: { Bash: 1 },
    compactSavingUsd: 7,
    skills: { '/home/me/.claude/skills/voice': 3 },
  }),
];

function contextOf(extra: Partial<FixContext> = {}): FixContext {
  return {
    totals: totalsOf(MEASURES, HOME),
    live: MEASURES,
    hotFiles: [{ project: '/repo', path: 'src/app.ts', sessions: 3, usd: 9 }],
    knob: () => null,
    installed: new Set(),
    home: HOME,
    projectOf: () => '/repo',
    exists: () => true,
    ...extra,
  };
}

describe('unusedTools', () => {
  it('finds tools carried by many sessions and called by almost none', () => {
    const tools = unusedTools(totalsOf(MEASURES, HOME));
    expect(tools.map((tool) => [tool.name, tool.carried, tool.used])).toStrictEqual([
      ['Artifact', 10, 0],
    ]);
    expect(tools[0]?.usd).toBeCloseTo(2);
  });
});

describe('autoFixesFor', () => {
  it('denies unused tools on top of the deny rules already set', () => {
    const [deny] = autoFixesFor('unused-tools', contextOf({ knob: () => ['Bash(rm *)'] }));
    expect(deny).toMatchObject({
      kind: 'knob',
      key: 'permissions.deny',
      value: ['Bash(rm *)', 'Artifact'],
      applied: false,
    });
    const [done] = autoFixesFor('unused-tools', contextOf({ knob: () => ['Artifact'] }));
    expect(done?.applied).toBe(true);
  });

  it('puts fixes already applied last, and says what compacting would have saved', () => {
    const fixes = autoFixesFor('huge-context', contextOf({ knob: () => 150_000 }));
    expect(fixes.map((fix) => [fix.id, fix.applied])).toStrictEqual([
      ['create:handoff', false],
      ['knob:autoCompactWindow', true],
    ]);
    expect(fixes[1]?.detail).toContain('about $7.00');
  });

  it('starts sessions in folders that are still there, with prompts that name the files and skills', () => {
    const [hot] = autoFixesFor('file-reads', contextOf());
    expect(hot).toMatchObject({ kind: 'launch', cwd: '/repo', worktree: true });
    expect(hot?.kind === 'launch' ? hot.prompt : '').toContain(
      '- src/app.ts: $9.00 over 3 sessions',
    );
    const [skill] = autoFixesFor('heavy-skills', contextOf());
    expect(skill).toMatchObject({ kind: 'launch', cwd: '/home/me/.claude/skills/voice' });
    const [permissions] = autoFixesFor('denials', contextOf());
    expect(permissions).toMatchObject({
      kind: 'launch',
      cwd: '/repo',
      prompt: '/fewer-permission-prompts',
    });
    expect(
      autoFixesFor('file-reads', contextOf({ exists: () => false })).map((fix) => fix.kind),
    ).toStrictEqual(['create']);
    expect(autoFixesFor('denials', contextOf({ exists: () => false }))).toStrictEqual([]);
  });

  it('offers nothing for a tip it has no fixes for', () => {
    expect(autoFixesFor('cd-commands', contextOf())).toStrictEqual([]);
    expect(autoFixesFor('instructions', contextOf())).toStrictEqual([]);
  });
});
