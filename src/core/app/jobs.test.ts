import { describe, expect, it } from 'vitest';

import type { AgentCli } from '../agents/types.js';
import type { ExecFunction } from '../surfaces/process.js';

import { BackgroundJobs } from './jobs.js';

interface Kept {
  readonly held: readonly string[];
  readonly finished: readonly string[];
}

interface State {
  readonly calls: string[][];
  readonly kept: Kept[];
  readonly errors: string[];
  changes: number;
  reply: unknown[] | Error;
}

function setup(): State & { readonly jobs: BackgroundJobs } {
  const state: State = { calls: [], kept: [], errors: [], changes: 0, reply: [] };
  const exec: ExecFunction = async (command, args) => {
    state.calls.push([command, ...args]);
    await Promise.resolve();
    if (state.reply instanceof Error) {
      throw state.reply;
    }
    return { stdout: JSON.stringify(state.reply) };
  };
  const jobs = new BackgroundJobs({
    exec,
    cliFor: async (): Promise<AgentCli> => {
      await Promise.resolve();
      return { bin: '/bin/claude', env: {} };
    },
    keep: async (held, finished): Promise<void> => {
      await Promise.resolve();
      state.kept.push({ held, finished });
    },
    onChange: (): void => {
      state.changes += 1;
    },
    report: (source, message): void => {
      state.errors.push(`${source}: ${message}`);
    },
  });
  return Object.assign(state, { jobs });
}

const DONE = { sessionId: 'd', kind: 'background', state: 'done', name: 'Done', startedAt: 5 };
const WORKING = { sessionId: 'w', kind: 'background', state: 'working', startedAt: 6 };
const BLOCKED = { sessionId: 'b', kind: 'background', state: 'blocked', startedAt: 7 };

describe('BackgroundJobs', () => {
  it('asks claude for every job and keeps the finished ones, telling others only on change', async () => {
    const h = setup();
    h.reply = [DONE, WORKING, BLOCKED];
    expect(h.jobs.value).toStrictEqual([]);
    await h.jobs.refresh();
    expect(h.calls).toStrictEqual([['/bin/claude', 'agents', '--json', '--all']]);
    expect(h.jobs.value).toStrictEqual([
      { sessionId: 'd', name: 'Done', cwd: null, startedAt: 5, state: 'done' },
      { sessionId: 'b', name: null, cwd: null, startedAt: 7, state: 'waiting' },
    ]);
    // Only the job waiting on the user is held for good; the finished one ages out.
    expect(h.kept).toStrictEqual([{ held: ['b'], finished: ['d'] }]);
    expect(h.changes).toBe(1);

    await h.jobs.refresh();
    expect(h.kept).toHaveLength(1);
    expect(h.changes).toBe(1);

    h.reply = [WORKING];
    await h.jobs.refresh();
    expect(h.jobs.value).toStrictEqual([]);
    expect(h.kept).toStrictEqual([
      { held: ['b'], finished: ['d'] },
      { held: [], finished: [] },
    ]);
    expect(h.changes).toBe(2);
    expect(h.errors).toStrictEqual([]);
  });

  it('keeps the last list through a failed read and reports each problem once', async () => {
    const h = setup();
    h.reply = [DONE];
    await h.jobs.refresh();
    h.reply = new Error('no claude');
    await h.jobs.refresh();
    await h.jobs.refresh();
    expect(h.jobs.value).toHaveLength(1);
    expect(h.errors).toStrictEqual(['background jobs: no claude']);
    expect(h.changes).toBe(1);

    h.reply = [DONE];
    await h.jobs.refresh();
    h.reply = new Error('no claude');
    await h.jobs.refresh();
    expect(h.errors).toHaveLength(2);
  });

  it('shares one read between overlapping refreshes', async () => {
    const h = setup();
    await Promise.all([h.jobs.refresh(), h.jobs.refresh()]);
    expect(h.calls).toHaveLength(1);
    await h.jobs.refresh();
    expect(h.calls).toHaveLength(2);
  });
});
