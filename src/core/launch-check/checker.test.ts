import { describe, expect, it } from 'vitest';

import type { WorktreeSummary } from '../../shared/protocol.js';
import type { KnownPayload } from '../hooks/payloads.js';

import { FRESH_MS, LaunchChecker } from './checker.js';
import type { LaunchCheck, ProbeTarget } from './probe.js';

interface World {
  enabled: boolean;
  now: number;
  probes: ProbeTarget[];
  located: string[];
  fail: boolean;
  reports: string[];
  worktrees: WorktreeSummary[];
}

/** Folders under /repo and /other are repositories. Anything else is outside git. */
const REPOS: readonly ProbeTarget[] = [
  { repoRoot: '/repo', target: 'main' },
  { repoRoot: '/other', target: null },
];

function setUp(): { world: World; checker: LaunchChecker } {
  const world: World = {
    enabled: true,
    now: 1000,
    probes: [],
    located: [],
    fail: false,
    reports: [],
    worktrees: [],
  };
  const checker = new LaunchChecker({
    enabled: (): boolean => world.enabled,
    locate: async (cwd): Promise<ProbeTarget | null> => {
      world.located.push(cwd);
      await Promise.resolve();
      return (
        REPOS.find((repo) => cwd === repo.repoRoot || cwd.startsWith(`${repo.repoRoot}/`)) ?? null
      );
    },
    probe: async (target): Promise<LaunchCheck> => {
      world.probes.push(target);
      await Promise.resolve();
      if (world.fail) {
        throw new Error('boom');
      }
      return {
        repoRoot: target.repoRoot,
        checkedAt: world.now,
        findings: [{ level: 'warn', text: `checked ${String(world.probes.length)}` }],
      };
    },
    worktrees: (): readonly WorktreeSummary[] => world.worktrees,
    home: '/home/me',
    now: (): number => world.now,
    formatTime: (at): string => `t${String(at)}`,
    report: (message): void => {
      world.reports.push(message);
    },
  });
  return { world, checker };
}

const PLACE = { path: '/wt/a', repoRoot: '/repo', target: 'main' };

function start(session: string, cwd: string, source = 'startup'): KnownPayload {
  return { session_id: session, hook_event_name: 'SessionStart', cwd, source };
}

function prompt(session: string): KnownPayload {
  return { session_id: session, hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
}

function toolUse(session: string, agent?: string): KnownPayload {
  return {
    session_id: session,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    ...(agent === undefined ? {} : { agent_id: agent }),
  };
}

describe('LaunchChecker in Overlord worktrees', () => {
  it('answers SessionStart with a check that finished after the worktree was handed out', async () => {
    const { world, checker } = setUp();
    checker.prime(PLACE);
    await checker.idle();
    expect(world.probes).toStrictEqual([PLACE]);
    expect(world.located).toStrictEqual([]);
    const note = checker.noteFor(start('s1', '/wt/a/sub'));
    expect(note).toContain('Overlord compatibility check for repo at t1000.');
    expect(note).toContain('This project is set up for Overlord.');
    expect(note).not.toContain('Own worktree');
    expect(checker.noteFor(prompt('s1'))).toBeNull();
  });

  it('waits for a running check and gives it on the first prompt after it ends', async () => {
    const { checker } = setUp();
    checker.prime(PLACE);
    expect(checker.noteFor(start('s1', '/wt/a'))).toBeNull();
    expect(checker.noteFor(prompt('s1'))).toBeNull();
    await checker.idle();
    expect(checker.noteFor(prompt('s1'))).toContain('- checked 1');
    expect(checker.noteFor(prompt('s1'))).toBeNull();
  });

  it('gives a late note on a main-thread tool call, not a subagent one', async () => {
    const { checker } = setUp();
    checker.prime(PLACE);
    checker.noteFor(start('s1', '/wt/a'));
    await checker.idle();
    expect(checker.noteFor(toolUse('s1', 'agent-1'))).toBeNull();
    expect(checker.noteFor(toolUse('s1'))).toContain('- checked 1');
  });

  it('checks a stale result again before a new session hears it', async () => {
    const { world, checker } = setUp();
    checker.prime(PLACE);
    await checker.idle();
    world.now += FRESH_MS;
    expect(checker.noteFor(start('s2', '/wt/a'))).toBeNull();
    await checker.idle();
    expect(world.probes).toHaveLength(2);
    expect(checker.noteFor(prompt('s2'))).toContain('- checked 2');
  });

  it('runs one probe per repository at a time', async () => {
    const { world, checker } = setUp();
    checker.prime(PLACE);
    checker.prime({ ...PLACE, path: '/wt/b' });
    await checker.idle();
    expect(world.probes).toHaveLength(1);
  });

  it('finds worktrees made before this window from the cache', async () => {
    const { world, checker } = setUp();
    const old: WorktreeSummary = {
      id: 'old',
      kind: 'session',
      label: 'Old',
      repoRoot: '/other',
      path: '/wt/old',
      branch: 'overlord/old',
      target: null,
      slot: 0,
      createdAt: 0,
      state: 'active',
      ahead: 0,
      dirty: 0,
      files: [],
      upstreamFiles: [],
      overlaps: [],
    };
    world.worktrees = [old];
    expect(checker.noteFor(start('s1', '/wt/old'))).toBeNull();
    await checker.idle();
    expect(world.probes).toStrictEqual([{ path: '/wt/old', repoRoot: '/other', target: null }]);
    expect(checker.noteFor(prompt('s1'))).toContain('compatibility check for other');
  });
});

describe('LaunchChecker outside Overlord worktrees', () => {
  it('tells a session in a repo Overlord never managed what it is missing', async () => {
    const { world, checker } = setUp();
    expect(checker.noteFor(start('s1', '/repo/web'))).toBeNull();
    await checker.idle();
    expect(world.located).toStrictEqual(['/repo/web']);
    const note = checker.noteFor(prompt('s1')) ?? '';
    expect(note).toContain('This project is not fully set up for Overlord');
    expect(note).toContain(
      '- Own worktree: this session was not started by Overlord, so it works in /repo/web directly',
    );
    expect(note).toContain('- Session coordination: Overlord has made no worktrees for this repo');
    expect(note).toContain('- checked 1');
  });

  it('leaves out coordination once Overlord has a worktree for the repo', async () => {
    const { checker } = setUp();
    checker.prime(PLACE);
    await checker.idle();
    checker.noteFor(start('s1', '/repo'));
    await checker.idle();
    const note = checker.noteFor(prompt('s1')) ?? '';
    expect(note).toContain('Own worktree');
    expect(note).not.toContain('Session coordination');
  });

  it('answers the next session in the same folder at once', async () => {
    const { world, checker } = setUp();
    checker.noteFor(start('s1', '/repo'));
    await checker.idle();
    expect(checker.noteFor(start('s2', '/repo'))).toContain('Own worktree');
    expect(world.located).toHaveLength(1);
  });

  it('tells a session outside git that the git features are missing', async () => {
    const { world, checker } = setUp();
    expect(checker.noteFor(start('s1', '/tmp/notes'))).toBeNull();
    await checker.idle();
    expect(world.probes).toHaveLength(0);
    const note = checker.noteFor(prompt('s1')) ?? '';
    expect(note).toContain('Overlord compatibility check for notes at t1000.');
    expect(note).toContain('- Git: this folder is not in a git repository');
    const again = checker.noteFor(start('s2', '/tmp/notes')) ?? '';
    expect(again).toContain('- Git:');
    await checker.idle();
    expect(world.located).toStrictEqual(['/tmp/notes', '/tmp/notes']);
  });

  it('skips home, resumed sessions and sessions without a folder', async () => {
    const { world, checker } = setUp();
    expect(checker.noteFor(start('s1', '/home/me'))).toBeNull();
    expect(checker.noteFor(start('s2', '/repo', 'resume'))).toBeNull();
    expect(checker.noteFor(start('s3', ''))).toBeNull();
    await checker.idle();
    expect(world.located).toStrictEqual([]);
    expect(checker.noteFor(prompt('s1'))).toBeNull();
  });
});

describe('LaunchChecker failures and settings', () => {
  it('reports a failed check and stops waiting for it', async () => {
    const { world, checker } = setUp();
    world.fail = true;
    checker.prime(PLACE);
    checker.noteFor(start('s1', '/wt/a'));
    await checker.idle();
    expect(world.reports).toStrictEqual(['compatibility check failed for /wt/a: Error: boom']);
    expect(checker.noteFor(prompt('s1'))).toBeNull();
    world.fail = false;
    expect(checker.noteFor(start('s2', '/wt/a'))).toBeNull();
  });

  it('forgets a session that ends before its note', async () => {
    const { checker } = setUp();
    checker.prime(PLACE);
    checker.noteFor(start('s1', '/wt/a'));
    checker.noteFor({
      session_id: 's1',
      hook_event_name: 'SessionEnd',
      reason: 'exit',
    });
    await checker.idle();
    expect(checker.noteFor(prompt('s1'))).toBeNull();
  });

  it('does nothing while turned off', async () => {
    const { world, checker } = setUp();
    world.enabled = false;
    checker.prime(PLACE);
    await checker.idle();
    expect(world.probes).toHaveLength(0);
    expect(checker.noteFor(start('s1', '/repo'))).toBeNull();
    expect(world.located).toHaveLength(0);
  });
});
