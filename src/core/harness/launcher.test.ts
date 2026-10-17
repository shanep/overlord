import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  fakeRuntime,
  flush,
  resultMessage,
  rejected,
  resolved,
  type FakeQuery,
  type Responder,
} from '../../../test/fake-claude/fake-query.js';
import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';
import type { LaunchRun } from '../../shared/protocol.js';
import { claudeCode } from '../agents/claude/index.js';
import { AgentRegistry } from '../agents/registry.js';
import type { AgentEvent } from '../agents/shared/events.js';
import type { AgentRun, RuntimeFacet } from '../agents/shared/runtime.js';
import type { AgentAdapter } from '../agents/types.js';
import type { BackendEndpoint } from '../bridge/backend.js';
import { BOISESTATE_PROFILE, BRIDGE_BASE_URL } from '../bridge/boisestate.js';
import { EventBus } from '../bus.js';

import { PermissionInbox } from './inbox.js';
import { AsyncQueue } from './input-queue.js';
import { Launcher, isTerminal, type LauncherDeps, type WorktreeProvider } from './launcher.js';

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
  agent: 'claude-code',
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
  const fakes = fakeRuntime(scripted);
  let clock = 1000;
  let ids = 0;
  const launcher = new Launcher(
    {
      agents: fakes.agents,
      bus: new EventBus(),
      broker: new PermissionInbox(),
      baseEnv: async (): Promise<Readonly<Record<string, string | undefined>>> =>
        resolved({ PATH: '/bin', FROM_BASE: 'yes', UNSET: undefined }),
      executablePath: (_agent, env): string | null =>
        env['FROM_BASE'] === 'yes' ? '/fake.mjs' : null,
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
    expect(launcher.state()).toStrictEqual({ runs, maxConcurrency: 2, held: null });
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
    const fakes = fakeRuntime(scripted);
    const launcher = new Launcher(
      { agents: fakes.agents, bus: new EventBus(), broker: new PermissionInbox() },
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

  it('holds queued runs while canStart says why, and starts them once it allows', async () => {
    let hold: string | null = 'The 5 hour session limit is 92% used.';
    const { launcher, queries } = setup(2, { canStart: () => hold });
    launcher.launch([spec('hang')], []);
    await flush();
    expect(queries).toHaveLength(0);
    expect(launcher.state().held).toBe('The 5 hour session limit is 92% used.');
    expect(launcher.recheck()).toBe(false);
    hold = null;
    expect(launcher.recheck()).toBe(true);
    await flush();
    expect(queries).toHaveLength(1);
    expect(launcher.state().held).toBeNull();
    expect(launcher.stopAll()).toBe(1);
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

/** A worktree provider that records what it hands out and takes back. */
function provider(overrides: Partial<WorktreeProvider> = {}): {
  readonly worktrees: WorktreeProvider;
  readonly acquired: [string, string, string][];
  readonly released: string[];
} {
  const acquired: [string, string, string][] = [];
  const released: string[] = [];
  const worktrees: WorktreeProvider = {
    acquire: async (cwd, runId, label) => {
      acquired.push([cwd, runId, label]);
      return resolved({ path: `/wt/${runId}`, env: { OVERLORD_SLOT: '3' } });
    },
    release: async (runId) => {
      released.push(runId);
      await Promise.resolve();
    },
    ...overrides,
  };
  return { worktrees, acquired, released };
}

describe('Launcher worktrees', () => {
  it('runs in a leased worktree with its variables and releases it at the end', async () => {
    const { worktrees, acquired, released } = provider();
    const { launcher, queries } = setup(1, { worktrees });
    launcher.launch([spec('ok:0', { worktree: true, label: 'Fix' })], []);
    await launcher.idle();
    expect(acquired).toStrictEqual([['/repo', 'id-2', 'Fix']]);
    expect(queries[0]?.options.cwd).toBe('/wt/id-2');
    expect(queries[0]?.options.env).toMatchObject({ OVERLORD_SLOT: '3' });
    expect(launcher.runs()[0]).toMatchObject({ state: 'done', worktreePath: '/wt/id-2' });
    expect(released).toStrictEqual(['id-2']);
  });

  it('runs in the folder itself when it is not a repository', async () => {
    const { worktrees, released } = provider({ acquire: async () => resolved(null) });
    const { launcher, queries } = setup(1, { worktrees });
    launcher.launch([spec('ok:0', { worktree: true })], []);
    await launcher.idle();
    expect(queries[0]?.options.cwd).toBe('/repo');
    expect(launcher.runs()[0]).toMatchObject({ state: 'done', worktreePath: null });
    expect(released).toStrictEqual([]);
  });

  it('fails without a provider or when the worktree cannot be made', async () => {
    const plain = setup(1, { worktrees: null });
    plain.launcher.launch([spec('ok:0', { worktree: true })], []);
    await plain.launcher.idle();
    expect(plain.launcher.runs()[0]).toMatchObject({
      state: 'failed',
      result: 'Worktree runs need a WorktreeProvider',
    });
    const { worktrees, released } = provider({
      acquire: async () => rejected(new Error('disk full')),
    });
    const broken = setup(1, { worktrees });
    broken.launcher.launch([spec('ok:0', { worktree: true })], []);
    await broken.launcher.idle();
    expect(broken.launcher.runs()[0]).toMatchObject({ state: 'failed', result: 'disk full' });
    expect(broken.queries).toHaveLength(0);
    expect(released).toStrictEqual([]);
  });

  it('reports a failed release without failing the run', async () => {
    const { worktrees } = provider({ release: async () => rejected(new Error('locked')) });
    const bus = new EventBus();
    const { launcher } = setup(1, { worktrees, bus });
    const errors: unknown[] = [];
    bus.on('source.error', (payload) => errors.push(payload));
    launcher.launch([spec('ok:0', { worktree: true })], []);
    await launcher.idle();
    expect(launcher.runs()[0]).toMatchObject({ state: 'done' });
    expect(errors).toStrictEqual([{ source: 'worktrees', message: 'locked' }]);
  });

  it('honors a stop that arrives while the worktree is being made', async () => {
    const gates: (() => void)[] = [];
    const { worktrees, released } = provider({
      acquire: async () => {
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return { path: '/wt', env: {} };
      },
    });
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
    expect(released).toHaveLength(1);
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

/** A host whose backend endpoints answer on one loopback port, recording each ask. */
function endpoints(asked: string[]): Partial<LauncherDeps> {
  return {
    backendEndpoint: async (backend): Promise<BackendEndpoint> => {
      asked.push(backend);
      await Promise.resolve();
      return { baseUrl: 'http://127.0.0.1:1', token: 'tok' };
    },
  };
}

describe('Launcher backends', () => {
  it('leaves a profile with no backend on its own account', async () => {
    const asked: string[] = [];
    const { launcher, queries } = setup(1, endpoints(asked));
    launcher.launch([spec('ok:0', { profileId: 'p1' })], [PROFILE]);
    await launcher.idle();
    expect(asked).toStrictEqual([]);
    expect(queries[0]?.options.env['FROM_PROFILE']).toBe('yes');
    expect(queries[0]?.options.env['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(queries[0]?.options.noMcp).toBe(false);
  });

  it.each([
    ['the backend field', { backend: BOISESTATE_PROFILE.backend ?? '' }],
    ['the old placeholder', { env: { ANTHROPIC_BASE_URL: BRIDGE_BASE_URL } }],
  ])('runs a profile on the bridge from %s, with no MCP servers', async (_how, fields) => {
    const asked: string[] = [];
    const { launcher, queries } = setup(1, endpoints(asked));
    const bridged: LaunchProfile = { ...PROFILE, id: 'bsu', ...fields };
    launcher.launch([spec('ok:0', { profileId: 'bsu' })], [bridged]);
    await launcher.idle();
    expect(launcher.runs()[0]?.state).toBe('done');
    expect(asked).toStrictEqual(['boisestate']);
    expect(queries[0]?.options.noMcp).toBe(true);
    expect(queries[0]?.options.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      ANTHROPIC_API_KEY: 'tok',
    });
  });

  it('fails a run whose backend is unknown or has no endpoint here', async () => {
    const { launcher } = setup(2);
    const unknown: LaunchProfile = { ...PROFILE, id: 'u', backend: 'nope' };
    launcher.launch(
      [spec('ok:0', { profileId: 'u' }), spec('ok:0', { profileId: 'b' })],
      [unknown, { ...BOISESTATE_PROFILE, id: 'b' }],
    );
    await launcher.idle();
    expect(launcher.runs().map((run) => [run.state, run.result])).toStrictEqual([
      ['failed', 'Unknown backend "nope"'],
      ['failed', 'The Boise State (Opus 5.5) backend is not available here.'],
    ]);
  });
});

/** An agent whose runtime mints its id on the first event and gives no dollars. */
function lateAgent(): AgentAdapter {
  const runtime: RuntimeFacet = {
    permissionSource: 'runtime',
    start: (): AgentRun => {
      const events = new AsyncQueue<AgentEvent>();
      let sessionId: string | null = null;
      return {
        get sessionId(): string | null {
          return sessionId;
        },
        send: (): void => {
          sessionId = 'thread-1';
          events.push({
            type: 'turn_result',
            ok: true,
            subtype: 'completed',
            text: 'late',
            costUsd: null,
            turns: null,
            durationMs: null,
            usage: null,
          });
        },
        endInput: (): void => {
          events.end();
        },
        interrupt: async (): Promise<void> => {
          await resolved(null);
        },
        stop: (): void => {
          events.end();
        },
        [Symbol.asyncIterator]: (): AsyncIterator<AgentEvent, undefined, undefined> =>
          events[Symbol.asyncIterator](),
      };
    },
  };
  return { ...claudeCode, id: 'late', name: 'Late CLI', runtime };
}

function profileFor(agent: string): LaunchProfile {
  return { ...PROFILE, id: agent, agent };
}

/** Claude's adapter with every facet past models left out. */
function bareAgent(): AgentAdapter {
  const { short, icon, detect, capabilities, modes, models } = claudeCode;
  return { id: 'bare', name: 'Bare CLI', short, icon, detect, capabilities, modes, models };
}

describe('Launcher agents', () => {
  const profile = profileFor;

  it('fails runs whose agent is unknown or has no runtime', async () => {
    const agents = new AgentRegistry([bareAgent()]);
    const { launcher, queries } = setup(2, { agents });
    launcher.launch(
      [spec('ok:0', { profileId: 'gone' }), spec('ok:0', { profileId: 'bare' })],
      [profile('gone'), profile('bare')],
    );
    await launcher.idle();
    expect(queries).toHaveLength(0);
    expect(launcher.runs().map((run) => run.result)).toStrictEqual([
      'Unknown agent "gone"',
      'Bare CLI cannot run from the Launcher yet',
    ]);
  });

  it('records an id the agent reports late and keeps cost at zero without dollars', async () => {
    const agents = new AgentRegistry([lateAgent()]);
    const { launcher } = setup(1, { agents });
    launcher.launch([spec('go', { profileId: 'late' })], [{ ...profile('late'), effort: null }]);
    await launcher.idle();
    expect(launcher.runs()[0]).toMatchObject({
      sessionId: 'thread-1',
      state: 'done',
      costUsd: 0,
      turns: 1,
      result: 'late',
    });
  });

  it('starts a session of an agent with no prices at an unknown cost', async () => {
    const unpriced: AgentAdapter = {
      ...lateAgent(),
      models: { ...claudeCode.models, price: () => null },
    };
    const bus = new EventBus();
    const costs: (number | null)[] = [];
    bus.on('session.upserted', (summary) => costs.push(summary.costUsd));
    const { launcher } = setup(1, { agents: new AgentRegistry([unpriced]), bus });
    launcher.launch([spec('go', { profileId: 'late' })], [{ ...profile('late'), effort: null }]);
    await launcher.idle();
    expect(costs.length).toBeGreaterThan(0);
    expect(costs.every((cost) => cost === null)).toBe(true);
  });

  it('starts a session of an agent with prices at $0', async () => {
    const bus = new EventBus();
    const costs: (number | null)[] = [];
    bus.on('session.upserted', (summary) => costs.push(summary.costUsd));
    const { launcher } = setup(1, { agents: new AgentRegistry([lateAgent()]), bus });
    launcher.launch([spec('go', { profileId: 'late' })], [{ ...profile('late'), effort: null }]);
    await launcher.idle();
    expect(costs[0]).toBe(0);
  });
});
