import { describe, expect, it } from 'vitest';

import type { ExecFunction } from '../surfaces/process.js';

import { BackgroundJobs } from './jobs.js';

interface State {
  readonly calls: string[][];
  readonly kept: (readonly string[])[];
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
    claudeBin: async (): Promise<string> => {
      await Promise.resolve();
      return '/bin/claude';
    },
    keep: async (sessionIds): Promise<void> => {
      await Promise.resolve();
      state.kept.push(sessionIds);
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

describe('BackgroundJobs', () => {
  it('asks claude for every job and keeps the finished ones, telling others only on change', async () => {
    const h = setup();
    h.reply = [DONE, WORKING];
    expect(h.jobs.value).toStrictEqual([]);
    await h.jobs.refresh();
    expect(h.calls).toStrictEqual([['/bin/claude', 'agents', '--json', '--all']]);
    expect(h.jobs.value).toStrictEqual([
      { sessionId: 'd', name: 'Done', cwd: null, startedAt: 5, state: 'done' },
    ]);
    expect(h.kept).toStrictEqual([['d']]);
    expect(h.changes).toBe(1);

    await h.jobs.refresh();
    expect(h.kept).toHaveLength(1);
    expect(h.changes).toBe(1);

    h.reply = [WORKING];
    await h.jobs.refresh();
    expect(h.jobs.value).toStrictEqual([]);
    expect(h.kept).toStrictEqual([['d'], []]);
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
