import { describe, expect, it } from 'vitest';

import type { AgentEntry } from '../surfaces/live.js';
import type { ExecResult } from '../sync/exec.js';

import { DETACH_TRIES, EXIT_TRIES, nothingLeft, POLL_DELAY_MS, stopIfIdle } from './idle-stop.js';
import type { Runtime } from './runtime.js';
import type { Responder, TestApp } from './test-helpers/fixtures.js';
import { makeApp, makeEnv, ok } from './test-helpers/fixtures.js';

const SESSION = '8c3efb13-full';
const IDLE_JOB = {
  id: '8c3efb13',
  pid: 4242,
  sessionId: SESSION,
  kind: 'background',
  status: 'idle',
  state: 'done',
};
const ATTACHED = '  555     1 /usr/local/bin/claude attach 8c3efb13\n';

function agents(list: readonly unknown[]): Responder {
  return (call): ExecResult | undefined =>
    call.args[0] === 'agents' ? ok(JSON.stringify(list)) : undefined;
}

/** Answers `ps` with each listing in turn, then the last one again. */
function ps(...listings: readonly string[]): Responder {
  let calls = 0;
  return (call): ExecResult | undefined => {
    if (call.command !== 'ps') {
      return undefined;
    }
    calls += 1;
    return ok(listings[Math.min(calls, listings.length) - 1]);
  };
}

const stops: Responder = (call) => (call.args[0] === 'stop' ? ok('stopped 8c3efb13\n') : undefined);

const failingStop: Responder = (call) =>
  call.args[0] === 'stop' ? { code: 1, stdout: '', stderr: 'no such job\n' } : undefined;

interface Setup {
  readonly test: TestApp;
  readonly rt: Runtime;
  readonly waits: number[];
}

async function setup(
  responders: readonly Responder[],
  options: { readonly busy?: boolean; readonly alive?: (pid: number) => boolean } = {},
): Promise<Setup> {
  const env = await makeEnv();
  const waits: number[] = [];
  const test = makeApp(env, {
    responders,
    deps: {
      delay: async (ms): Promise<void> => {
        waits.push(ms);
        await Promise.resolve();
      },
      ...(options.alive === undefined ? {} : { isAlive: options.alive }),
    },
  });
  const busy = options.busy ?? false;
  return { test, rt: { ...test.app.runtime, sessionBusy: (): boolean => busy }, waits };
}

function stopCalls(test: TestApp): readonly (readonly string[])[] {
  return test.calls.filter((call) => call.args[0] === 'stop').map((call) => call.args);
}

function job(overrides: Partial<AgentEntry>): AgentEntry {
  return {
    ...IDLE_JOB,
    name: null,
    cwd: null,
    startedAt: null,
    ...overrides,
  };
}

describe('nothingLeft', () => {
  it('is true only for a live background job that rests with nothing open', () => {
    expect(nothingLeft(job({}), false)).toBe(true);
    expect(nothingLeft(job({ state: 'blocked' }), false)).toBe(true);
    expect(nothingLeft(job({}), true)).toBe(false);
    expect(nothingLeft(job({ kind: 'interactive' }), false)).toBe(false);
    expect(nothingLeft(job({ pid: null }), false)).toBe(false);
    expect(nothingLeft(job({ status: 'busy', state: 'working' }), false)).toBe(false);
    expect(nothingLeft(job({ state: 'stopped' }), false)).toBe(false);
    expect(nothingLeft(job({ state: null }), false)).toBe(false);
  });
});

describe('stopIfIdle', () => {
  it('stops an idle background session once no tab shows it', async () => {
    const { test, rt } = await setup([agents([IDLE_JOB]), ps(''), stops]);
    expect(await stopIfIdle(rt, SESSION)).toBe(true);
    expect(stopCalls(test)).toStrictEqual([['stop', '8c3efb13']]);
  });

  it('stops a session that never got a prompt', async () => {
    const fresh = { ...IDLE_JOB, state: 'blocked' };
    const { test, rt } = await setup([agents([fresh]), ps(''), stops]);
    expect(await stopIfIdle(rt, SESSION)).toBe(true);
    expect(stopCalls(test)).toHaveLength(1);
  });

  it('leaves a session waiting on a permission prompt running', async () => {
    const blocked = { ...IDLE_JOB, state: 'blocked' };
    const { test, rt } = await setup([agents([blocked]), ps(''), stops], { busy: true });
    expect(await stopIfIdle(rt, SESSION)).toBe(false);
    expect(stopCalls(test)).toStrictEqual([]);
  });

  it('leaves a session mid turn running', async () => {
    const working = { ...IDLE_JOB, status: 'busy', state: 'working' };
    const { test, rt } = await setup([agents([working]), ps(''), stops]);
    expect(await stopIfIdle(rt, SESSION)).toBe(false);
    expect(stopCalls(test)).toStrictEqual([]);
  });

  it('leaves sessions alone that are not live background jobs', async () => {
    for (const list of [[], [{ ...IDLE_JOB, id: null }], [{ ...IDLE_JOB, pid: null }]]) {
      const { test, rt } = await setup([agents(list), ps(''), stops]);
      expect(await stopIfIdle(rt, SESSION)).toBe(false);
      expect(stopCalls(test)).toStrictEqual([]);
    }
  });

  it('waits for the closed tab to let go before deciding', async () => {
    const { test, rt, waits } = await setup([agents([IDLE_JOB]), ps(ATTACHED, ''), stops]);
    expect(await stopIfIdle(rt, SESSION)).toBe(true);
    expect(test.calls.filter((call) => call.command === 'ps')).toHaveLength(2);
    expect(waits).toStrictEqual([POLL_DELAY_MS]);
  });

  it('keeps the session when another tab still shows it', async () => {
    const { test, rt } = await setup([agents([IDLE_JOB]), ps(ATTACHED), stops]);
    expect(await stopIfIdle(rt, SESSION)).toBe(false);
    expect(test.calls.filter((call) => call.command === 'ps')).toHaveLength(DETACH_TRIES);
    expect(stopCalls(test)).toStrictEqual([]);
  });

  it('waits for the process to exit so the worktree check sees it gone', async () => {
    let checks = 0;
    const alive = (): boolean => {
      checks += 1;
      return checks <= 2;
    };
    const { rt, waits } = await setup([agents([IDLE_JOB]), ps(''), stops], { alive });
    expect(await stopIfIdle(rt, SESSION)).toBe(true);
    expect(waits).toStrictEqual([POLL_DELAY_MS, POLL_DELAY_MS]);
  });

  it('gives up waiting on a process that will not exit', async () => {
    const { rt, waits } = await setup([agents([IDLE_JOB]), ps(''), stops], { alive: () => true });
    expect(await stopIfIdle(rt, SESSION)).toBe(true);
    expect(waits).toHaveLength(EXIT_TRIES);
  });

  it('says so when claude stop fails', async () => {
    const { test, rt } = await setup([agents([IDLE_JOB]), ps(''), failingStop]);
    expect(await stopIfIdle(rt, SESSION)).toBe(false);
    expect(test.app.errorList().at(-1)).toMatchObject({
      source: 'idle stop',
      message: 'claude stop 8c3efb13 failed: no such job',
    });
  });

  it('says so when it cannot find claude', async () => {
    const { test, rt } = await setup([]);
    const broken: Runtime = {
      ...rt,
      claudeCli: async () => {
        await Promise.resolve();
        throw new Error('claude is not installed');
      },
    };
    expect(await stopIfIdle(broken, SESSION)).toBe(false);
    expect(test.app.errorList().at(-1)).toMatchObject({
      source: 'idle stop',
      message: 'claude is not installed',
    });
  });
});
