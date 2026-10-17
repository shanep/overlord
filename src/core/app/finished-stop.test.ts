import { describe, expect, it } from 'vitest';

import type { WorktreeSummary } from '../../shared/worktrees.js';
import type { ExecResult } from '../sync/exec.js';

import { AsyncValue } from './async-value.js';
import { FINISHED_GRACE_MS, FinishedWatch, stopFinished } from './finished-stop.js';
import type { Runtime } from './runtime.js';
import type { Responder, TestApp } from './test-helpers/fixtures.js';
import { makeApp, makeEnv, ok } from './test-helpers/fixtures.js';

const SESSION = '8c3efb13-full';
const TREE = '/home/me/.overlord/worktrees/repo-1/repo-8c3efb13';
const DONE_JOB = {
  id: '8c3efb13',
  pid: 4242,
  sessionId: SESSION,
  cwd: TREE,
  kind: 'background',
  status: 'idle',
  state: 'done',
};
const ATTACHED = '  555     1 /usr/local/bin/claude attach 8c3efb13\n';
const START = 1_000_000;

function tree(overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    id: 'tree-1',
    kind: 'session',
    label: 'Session in repo',
    repoRoot: '/home/me/repo',
    path: TREE,
    branch: 'overlord/8c3efb13',
    target: 'master',
    slot: 0,
    createdAt: 0,
    state: 'active',
    ahead: 0,
    dirty: 0,
    files: [],
    upstreamFiles: [],
    overlaps: [],
    ...overrides,
  };
}

const stops: Responder = (call) => (call.args[0] === 'stop' ? ok('stopped 8c3efb13\n') : undefined);

interface Options {
  readonly jobs?: () => readonly unknown[];
  readonly ps?: string;
  readonly trees?: readonly WorktreeSummary[];
  readonly busy?: boolean;
  readonly tabOpen?: boolean;
}

interface Setup {
  readonly test: TestApp;
  readonly rt: Runtime;
  /** Runs one check at this many milliseconds after the first. */
  readonly checkAt: (ms: number) => Promise<void>;
}

async function setup(options: Options = {}): Promise<Setup> {
  const env = await makeEnv();
  const jobs = options.jobs ?? ((): readonly unknown[] => [DONE_JOB]);
  const responders: Responder[] = [
    (call): ExecResult | undefined =>
      call.args[0] === 'agents' ? ok(JSON.stringify(jobs())) : undefined,
    (call): ExecResult | undefined => (call.command === 'ps' ? ok(options.ps ?? '') : undefined),
    stops,
  ];
  const test = makeApp(env, {
    responders,
    deps: {
      delay: async (): Promise<void> => {
        await Promise.resolve();
      },
    },
  });
  const trees = options.trees ?? [tree()];
  let now = START;
  const base = test.app.runtime;
  const rt: Runtime = {
    ...base,
    clock: (): number => now,
    sessionBusy: (): boolean => options.busy ?? false,
    sessionWorktrees: new Map(options.tabOpen === true ? [[SESSION, 'tree-1']] : []),
    caches: {
      ...base.caches,
      worktrees: new AsyncValue({
        name: 'worktrees',
        initial: trees,
        load: async (): Promise<readonly WorktreeSummary[]> => {
          await Promise.resolve();
          return trees;
        },
        onUpdate: (): void => undefined,
        onError: (): void => undefined,
      }),
    },
  };
  const watch = new FinishedWatch();
  const checkAt = async (ms: number): Promise<void> => {
    now = START + ms;
    await stopFinished(rt, watch);
  };
  return { test, rt, checkAt };
}

function stopCalls(test: TestApp): readonly (readonly string[])[] {
  return test.calls.filter((call) => call.args[0] === 'stop').map((call) => call.args);
}

/** Sees the job at the start and again once the grace period is over. */
async function afterGrace(options: Options = {}): Promise<TestApp> {
  const { test, checkAt } = await setup(options);
  await checkAt(0);
  await checkAt(FINISHED_GRACE_MS);
  return test;
}

describe('stopFinished', () => {
  it('stops a finished session in a landed worktree once the grace period is over', async () => {
    const { test, checkAt } = await setup();
    await checkAt(0);
    await checkAt(FINISHED_GRACE_MS - 1);
    expect(stopCalls(test)).toStrictEqual([]);
    await checkAt(FINISHED_GRACE_MS);
    expect(stopCalls(test)).toStrictEqual([['stop', '8c3efb13']]);
  });

  it('keeps a session whose last reply asked the user something', async () => {
    const test = await afterGrace({ jobs: () => [{ ...DONE_JOB, state: 'blocked' }] });
    expect(stopCalls(test)).toStrictEqual([]);
  });

  it('keeps a session a tab or terminal is attached to', async () => {
    const test = await afterGrace({ ps: ATTACHED });
    expect(stopCalls(test)).toStrictEqual([]);
  });

  it('keeps a session whose Overlord tab is open', async () => {
    const test = await afterGrace({ tabOpen: true });
    expect(stopCalls(test)).toStrictEqual([]);
  });

  it('keeps a session whose transcript still has something open', async () => {
    const test = await afterGrace({ busy: true });
    expect(stopCalls(test)).toStrictEqual([]);
  });

  it('keeps a session whose worktree holds work that has not landed', async () => {
    for (const trees of [[tree({ ahead: 1 })], [tree({ dirty: 2 })], []]) {
      const test = await afterGrace({ trees });
      expect(stopCalls(test)).toStrictEqual([]);
    }
  });

  it('keeps a session that starts a turn while it is being checked', async () => {
    let lists = 0;
    const test = await afterGrace({
      jobs: () => {
        lists += 1;
        return [{ ...DONE_JOB, ...(lists > 2 ? { status: 'busy', state: 'working' } : {}) }];
      },
    });
    expect(lists).toBe(3);
    expect(stopCalls(test)).toStrictEqual([]);
  });

  it('counts the grace period again after the session works some more', async () => {
    let state = 'done';
    const { test, checkAt } = await setup({ jobs: () => [{ ...DONE_JOB, state }] });
    await checkAt(0);
    state = 'working';
    await checkAt(60_000);
    state = 'done';
    await checkAt(120_000);
    await checkAt(FINISHED_GRACE_MS);
    expect(stopCalls(test)).toStrictEqual([]);
    await checkAt(120_000 + FINISHED_GRACE_MS);
    expect(stopCalls(test)).toStrictEqual([['stop', '8c3efb13']]);
  });
});
