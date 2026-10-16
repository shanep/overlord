import { describe, expect, it, vi } from 'vitest';

import { createMemoryFs } from '../context/test-helpers/memory-fs.js';
import type { ExecResult } from '../sync/exec.js';

import type { SessionRef } from './build.js';
import type { ActivityDeps } from './monitor.js';
import { ACTIVITY_INTERVAL_MS, ActivityMonitor } from './monitor.js';

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: '' };
}

const SESSION: SessionRef = { sessionId: 's1', pid: 10, title: 'Main', cwd: '/w', place: null };

function sessionList(): readonly SessionRef[] {
  return [SESSION];
}

async function someSpace(): Promise<{ freeBytes: number; totalBytes: number }> {
  await Promise.resolve();
  return { freeBytes: 1, totalBytes: 2 };
}

async function never(): Promise<void> {
  await new Promise<void>(() => {
    // Never settles, so a statfs never times out.
  });
}

interface Harness {
  readonly monitor: ActivityMonitor;
  readonly ticks: (() => void)[];
  readonly stopped: { count: number };
  readonly changed: ReturnType<typeof vi.fn>;
  readonly reported: string[];
  now: number;
}

function harness(overrides: Partial<ActivityDeps> = {}): Harness {
  const ticks: (() => void)[] = [];
  const stopped = { count: 0 };
  const reported: string[] = [];
  const changed = vi.fn();
  const stop = (): void => {
    stopped.count += 1;
  };
  const state: Harness = {
    ticks,
    stopped,
    changed,
    reported,
    now: 0,
    monitor: new ActivityMonitor({
      platform: 'darwin',
      exec: async (command): Promise<ExecResult> => {
        await Promise.resolve();
        return command === 'ps' ? ok(' 10 1 S 100 0:01.00 claude\n') : ok('');
      },
      fs: createMemoryFs({ files: {} }),
      clock: () => state.now,
      machine: { cpus: () => [], loadavg: () => [0, 0, 0], totalmem: () => 1 },
      statfs: someSpace,
      delay: never,
      interval: (callback, ms): (() => void) => {
        expect(ms).toBe(ACTIVITY_INTERVAL_MS);
        ticks.push(callback);
        return stop;
      },
      sessions: sessionList,
      onChange: changed,
      report: (source, message): void => {
        reported.push(`${source}: ${message}`);
      },
      ...overrides,
    }),
  };
  return state;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await Promise.resolve();
  }
}

describe('ActivityMonitor', () => {
  it('starts sampling on the first read and fills in the state', async () => {
    const h = harness();
    const empty = h.monitor.state();
    expect(empty.sampledAt).toBeNull();
    expect(h.monitor.sampling).toBe(true);
    expect(h.ticks).toHaveLength(1);
    await settle();
    expect(h.changed).toHaveBeenCalledTimes(1);
    const state = h.monitor.state();
    expect(state.sampledAt).toBe(0);
    expect(state.sessions.map((session) => session.title)).toStrictEqual(['Main']);
    expect(h.ticks).toHaveLength(1);
  });

  it('shares a sample that is still running', async () => {
    const h = harness();
    h.monitor.state();
    await h.monitor.tick();
    expect(h.changed).toHaveBeenCalledTimes(1);
    await h.monitor.tick();
    expect(h.changed).toHaveBeenCalledTimes(2);
  });

  it('stops once nobody has read the state for a while, and starts again on a read', async () => {
    const h = harness();
    h.monitor.state();
    await settle();
    h.now = 3 * ACTIVITY_INTERVAL_MS;
    h.ticks[0]?.();
    await settle();
    expect(h.monitor.sampling).toBe(true);
    h.now = 4 * ACTIVITY_INTERVAL_MS;
    await h.monitor.tick();
    expect(h.monitor.sampling).toBe(false);
    expect(h.stopped.count).toBe(1);
    h.monitor.state();
    expect(h.monitor.sampling).toBe(true);
    expect(h.ticks).toHaveLength(2);
    h.monitor.stop();
    h.monitor.stop();
    expect(h.stopped.count).toBe(2);
  });

  it('reports a sample that throws', async () => {
    const h = harness({
      sessions: () => {
        throw new Error('registry gone');
      },
    });
    h.monitor.state();
    await settle();
    expect(h.reported).toStrictEqual(['activity: registry gone']);
    expect(h.changed).not.toHaveBeenCalled();
  });
});
