import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  fakeQueries,
  flush,
  resultMessage,
  rejected,
  resolved,
  type FakeQuery,
  type Responder,
} from '../../../test/fake-claude/fake-query.js';
import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';
import type { LaunchRun } from '../../shared/protocol.js';
import { EventBus } from '../bus.js';

import { PermissionInbox } from './inbox.js';
import { Launcher, isTerminal, type LauncherDeps, type WorktreeCreator } from './launcher.js';

function spec(prompt: string, overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    prompt,
    cwd: '/repo',
    profileId: null,
    worktree: false,
    maxBudgetUsd: null,
    label: prompt,
    ...overrides,
  };
}

const PROFILE: LaunchProfile = {
  id: 'p1',
  name: 'Opus',
  model: 'opus',
  effort: 'max',
  permissionMode: 'plan',
  env: { FROM_PROFILE: 'yes' },
  extraArgs: ['--debug'],
};

async function later(ticks: number): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function respond(query: FakeQuery, behavior: string): void {
  switch (behavior) {
    case 'ok': {
      query.emit(
        resultMessage({ total_cost_usd: 0.5, num_turns: 2, duration_ms: 42, result: 'fine' }),
      );
      break;
    }
    case 'error': {
      query.emit(
        resultMessage({ is_error: true, total_cost_usd: 0.25, result: undefined, errors: ['bad'] }),
      );
      break;
    }
    case 'throw': {
      query.fail(new Error('crash'));
      break;
    }
    case 'twice': {
      query.emit(resultMessage({ total_cost_usd: 1, result: 'first' }));
      query.emit(resultMessage({ total_cost_usd: 2, result: 'second' }));
      break;
    }
    case 'none': {
      query.end();
      break;
    }
    default: {
      // "hang": never answers, so only a stop ends the run.
      break;
    }
  }
}

async function respondLater(query: FakeQuery, behavior: string, ticks: number): Promise<void> {
  await later(ticks);
  respond(query, behavior);
}

/** Prompts look like "ok:2" or "error:0": what to do, and how many ticks to wait. */
const scripted: Responder = (query, prompt) => {
  const [behavior = 'ok', delay = '0'] = prompt.split(':');
  void respondLater(query, behavior, Number(delay));
};

interface Setup {
  readonly launcher: Launcher;
  readonly queries: FakeQuery[];
  readonly changes: LaunchRun[];
}

function setup(maxConcurrency = 2, extra: Partial<LauncherDeps> = {}): Setup {
  const fakes = fakeQueries(scripted);
  let clock = 1000;
  let ids = 0;
  const launcher = new Launcher(
    {
      queryFunction: fakes.queryFunction,
      bus: new EventBus(),
      broker: new PermissionInbox(),
      baseEnv: async (): Promise<Readonly<Record<string, string | undefined>>> =>
        resolved({ PATH: '/bin', FROM_BASE: 'yes', UNSET: undefined }),
      executablePath: (env): string | null => (env['FROM_BASE'] === 'yes' ? '/fake.mjs' : null),
      now: (): number => {
        clock += 10;
        return clock;
      },
      newId: (): string => {
        ids += 1;
        return `id-${String(ids)}`;
      },
      ...extra,
    },
    maxConcurrency,
  );
  const changes: LaunchRun[] = [];
  launcher.onChange((run) => changes.push(run));
  return { launcher, queries: fakes.queries, changes };
}

describe('Launcher basics', () => {
  it('rejects a bad concurrency limit', () => {
    expect(() => setup(0)).toThrow('maxConcurrency must be a whole number of at least 1, got 0');
    expect(() => setup(1.5)).toThrow(RangeError);
    const { launcher } = setup(1);
    expect(() => {
      launcher.setMaxConcurrency(-1);
    }).toThrow(RangeError);
    expect(launcher.maxConcurrency).toBe(1);
  });

  it('runs a batch and records each result', async () => {
    const { launcher, queries, changes } = setup(2);
    const batchId = launcher.launch([spec('ok:1'), spec('error:0'), spec('ok:0')], []);
    expect(batchId).toBe('id-1');
    expect(launcher.runningCount).toBe(2);
    expect(launcher.runs().map((run) => run.state)).toStrictEqual(['running', 'running', 'queued']);
    await launcher.idle();
    expect(queries).toHaveLength(3);
    const runs = launcher.runs();
    expect(runs.map((run) => run.state)).toStrictEqual(['done', 'failed', 'done']);
    expect(runs[0]).toStrictEqual({
      id: 'id-2',
      batchId: 'id-1',
      spec: spec('ok:1'),
      sessionId: queries[0]?.options.sessionId ?? '',
      state: 'done',
      costUsd: 0.5,
      turns: 2,
      durationMs: 42,
      result: 'fine',
      worktreePath: null,
    });
    expect(runs[1]).toMatchObject({ costUsd: 0.25, turns: 1, result: 'bad', durationMs: 100 });
    expect(launcher.spendUsd()).toBe(1.25);
    expect(launcher.state()).toStrictEqual({ runs, maxConcurrency: 2 });
    expect(launcher.runningCount).toBe(0);
    expect(changes.filter((run) => run.id === 'id-4').map((run) => run.state)).toContain('queued');
    expect(queries.every((query) => query.inputEnded)).toBe(true);
  });

  it('passes profile settings and only the budget a spec sets', async () => {
    const { launcher, queries } = setup(2);
    launcher.launch([spec('ok:0', { profileId: 'p1', maxBudgetUsd: 3 }), spec('ok:0')], [PROFILE]);
    await launcher.idle();
    expect(queries[0]?.options).toMatchObject({
      cwd: '/repo',
      model: 'opus',
      effort: 'max',
      permissionMode: 'plan',
      env: { PATH: '/bin', FROM_BASE: 'yes', FROM_PROFILE: 'yes' },
      extraArgs: { debug: null },
      maxBudgetUsd: 3,
      executablePath: '/fake.mjs',
    });
    expect(Object.keys(queries[0]?.options.env ?? {})).not.toContain('UNSET');
    expect(queries[1]?.options).toMatchObject({
      model: null,
      effort: null,
      permissionMode: null,
      maxBudgetUsd: null,
    });
    expect(queries[0]?.prompts).toStrictEqual(['ok:0']);
  });

  it('fails runs that cannot start or end without a result', async () => {
    const { launcher, queries } = setup(3);
    launcher.launch([spec('ok:0', { profileId: 'missing' }), spec('throw:0'), spec('none:0')], []);
    await launcher.idle();
    expect(queries).toHaveLength(2);
    expect(launcher.runs().map((run) => [run.state, run.result])).toStrictEqual([
      ['failed', 'Unknown launch profile "missing"'],
      ['failed', 'crash'],
      ['failed', 'The session ended without a result'],
    ]);
    const wall = launcher.runs()[0]?.durationMs ?? 0;
    expect(wall).toBeGreaterThan(0);
    expect(wall).toBeLessThan(1000);
    expect(wall % 10).toBe(0);
  });

  it('keeps only the first result of a run', async () => {
    const { launcher } = setup(1);
    launcher.launch([spec('twice:0')], []);
    await launcher.idle();
    expect(launcher.runs()[0]).toMatchObject({ state: 'done', costUsd: 1, result: 'first' });
  });

  it('works with default clock, ids and environment', async () => {
    const fakes = fakeQueries(scripted);
    const launcher = new Launcher(
      { queryFunction: fakes.queryFunction, bus: new EventBus(), broker: new PermissionInbox() },
      1,
    );
    await launcher.idle();
    launcher.launch([spec('ok:0')], []);
    await launcher.idle();
    expect(launcher.runs()[0]?.id).toMatch(/^[\da-f-]{36}$/);
    expect(fakes.queries[0]?.options.env['PATH']).toBe(process.env['PATH']);
    expect(fakes.queries[0]?.options.executablePath).toBeNull();
  });

  it('raises the limit and starts queued runs', async () => {
    const { launcher, queries } = setup(1);
    launcher.launch([spec('hang'), spec('hang')], []);
    await flush();
    expect(queries).toHaveLength(1);
    launcher.setMaxConcurrency(2);
    await flush();
    expect(queries).toHaveLength(2);
    expect(launcher.stopAll()).toBe(2);
    await launcher.idle();
  });

  it('stops listening when unsubscribed', () => {
    const { launcher } = setup(1);
    const seen: string[] = [];
    const off = launcher.onChange((run) => seen.push(run.state));
    off();
    launcher.launch([spec('hang')], []);
    expect(seen).toStrictEqual([]);
    launcher.stopAll();
  });
});

describe('Launcher stopping', () => {
  it('stops queued and running runs', async () => {
    const { launcher, queries } = setup(1);
    launcher.launch([spec('hang'), spec('ok:0')], []);
    await flush();
    const [first, second] = launcher.runs();
    expect(launcher.session(first?.id ?? '')).not.toBeNull();
    expect(launcher.session('nope')).toBeNull();
    expect(launcher.stopRun(second?.id ?? '')).toBe(true);
    expect(launcher.runs()[1]?.state).toBe('stopped');
    expect(launcher.stopRun(first?.id ?? '')).toBe(true);
    await launcher.idle();
    expect(launcher.runs().map((run) => run.state)).toStrictEqual(['stopped', 'stopped']);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.options.abortController.signal.aborted).toBe(true);
    expect(launcher.stopRun(first?.id ?? '')).toBe(false);
    expect(launcher.stopRun('unknown')).toBe(false);
    expect(launcher.stopAll()).toBe(0);
    expect(launcher.runs()[1]?.durationMs).toBe(0);
  });

  it('resolves idle when the last queued run is stopped', async () => {
    const { launcher } = setup(1);
    launcher.launch([spec('hang'), spec('hang')], []);
    const waiting = launcher.idle();
    const [first, second] = launcher.runs();
    launcher.stopRun(first?.id ?? '');
    await flush();
    launcher.stopRun(second?.id ?? '');
    await waiting;
    expect(launcher.runs().every((run) => isTerminal(run.state))).toBe(true);
  });
});

describe('Launcher worktrees', () => {
  it('runs in a fresh worktree', async () => {
    const created: [string, string][] = [];
    const worktrees: WorktreeCreator = {
      create: async (cwd, runId) => {
        created.push([cwd, runId]);
        return resolved({
          runId,
          repoRoot: cwd,
          path: `${cwd}/.claude/worktrees/overlord-${runId}`,
          branch: `overlord/${runId}`,
          baseCommit: 'abc',
        });
      },
    };
    const { launcher, queries } = setup(1, { worktrees });
    launcher.launch([spec('ok:0', { worktree: true })], []);
    await launcher.idle();
    expect(created).toStrictEqual([['/repo', 'id-2']]);
    expect(queries[0]?.options.cwd).toBe('/repo/.claude/worktrees/overlord-id-2');
    expect(launcher.runs()[0]).toMatchObject({
      state: 'done',
      worktreePath: '/repo/.claude/worktrees/overlord-id-2',
    });
  });

  it('fails without a manager or when git fails', async () => {
    const worktrees: WorktreeCreator = {
      create: async () => rejected(new Error('not a repo')),
    };
    const plain = setup(1, { worktrees: null });
    plain.launcher.launch([spec('ok:0', { worktree: true })], []);
    await plain.launcher.idle();
    expect(plain.launcher.runs()[0]).toMatchObject({
      state: 'failed',
      result: 'Worktree runs need a WorktreeManager',
    });
    const broken = setup(1, { worktrees });
    broken.launcher.launch([spec('ok:0', { worktree: true })], []);
    await broken.launcher.idle();
    expect(broken.launcher.runs()[0]).toMatchObject({ state: 'failed', result: 'not a repo' });
    expect(broken.queries).toHaveLength(0);
  });

  it('honors a stop that arrives while the worktree is being made', async () => {
    const gates: (() => void)[] = [];
    const worktrees: WorktreeCreator = {
      create: async (cwd, runId) => {
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return { runId, repoRoot: cwd, path: '/wt', branch: 'b', baseCommit: 'c' };
      },
    };
    const { launcher, queries } = setup(1, { worktrees });
    launcher.launch([spec('ok:0', { worktree: true })], []);
    await flush();
    expect(launcher.stopRun(launcher.runs()[0]?.id ?? '')).toBe(true);
    for (const open of gates) {
      open();
    }
    await launcher.idle();
    expect(launcher.runs()[0]).toMatchObject({ state: 'stopped', worktreePath: '/wt' });
    expect(queries).toHaveLength(0);
  });
});

const behaviors = fc.constantFrom('ok', 'error', 'throw', 'none', 'twice');

describe('Launcher concurrency', () => {
  it('never runs more than maxConcurrency and always ends every run', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.tuple(behaviors, fc.integer({ min: 0, max: 3 })), {
          minLength: 1,
          maxLength: 10,
        }),
        fc.array(fc.tuple(fc.nat(9), fc.integer({ min: 0, max: 3 })), { maxLength: 4 }),
        async (limit, plan, stops) => {
          const { launcher } = setup(limit);
          let peak = 0;
          launcher.onChange(() => {
            const running = launcher.runs().filter((run) => run.state === 'running').length;
            peak = Math.max(peak, running, launcher.runningCount);
          });
          launcher.launch(
            plan.map(([behavior, delay]) => spec(`${behavior}:${String(delay)}`)),
            [],
          );
          for (const [index, delay] of stops) {
            await later(delay);
            launcher.stopRun(launcher.runs()[index % plan.length]?.id ?? '');
          }
          await launcher.idle();
          expect(peak).toBeLessThanOrEqual(limit);
          expect(launcher.runs()).toHaveLength(plan.length);
          expect(launcher.runs().every((run) => isTerminal(run.state))).toBe(true);
          expect(launcher.runningCount).toBe(0);
        },
      ),
      { numRuns: 60 },
    );
  });
});
