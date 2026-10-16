import { describe, expect, it } from 'vitest';

import type { SessionRef } from './build.js';
import { buildActivity, emptyActivity, sessionTrees } from './build.js';
import type { ProcessSnapshot } from './flags.js';
import type { ProcessRow } from './process-table.js';
import type { RawSample } from './sample.js';

const GB = 1024 ** 3;

function row(
  pid: number,
  ppid: number,
  cpuMs: number,
  overrides: Partial<ProcessRow> = {},
): ProcessRow {
  return { pid, ppid, state: 'S', rssBytes: 100, cpuMs, name: `p${String(pid)}`, ...overrides };
}

function sample(at: number, overrides: Partial<RawSample> = {}): RawSample {
  return {
    at,
    rows: [],
    args: new Map(),
    disk: new Map(),
    network: new Map(),
    wchan: new Map(),
    cpu: { busy: 0, total: 0 },
    cores: 4,
    loadAverage: [1, 1, 1],
    memoryTotalBytes: 16 * GB,
    memory: { usedBytes: 4 * GB, swapUsedBytes: 0, swapTotalBytes: 0 },
    memoryPressure: 'normal',
    stall: null,
    cpuSpeedLimitPct: 100,
    volumes: [],
    ...overrides,
  };
}

function ref(sessionId: string, pid: number, title = sessionId): SessionRef {
  return { sessionId, pid, title, cwd: `/w/${sessionId}`, place: 'vscode' };
}

describe('emptyActivity', () => {
  it('has no sample and zeroed machine numbers', () => {
    const state = emptyActivity(2000);
    expect(state.sampledAt).toBeNull();
    expect(state.intervalMs).toBe(2000);
    expect(state.machine.cores).toBe(0);
  });
});

describe('sessionTrees', () => {
  it('skips sessions whose process is gone and keeps nested sessions apart', () => {
    const rows = [row(10, 1, 0), row(11, 10, 0), row(20, 11, 0), row(21, 20, 0)];
    const trees = sessionTrees([ref('outer', 10), ref('inner', 20), ref('gone', 99)], rows);
    expect(
      trees.map((tree) => [tree.session.sessionId, tree.rows.map((entry) => entry.pid)]),
    ).toStrictEqual([
      ['outer', [10, 11]],
      ['inner', [20, 21]],
    ]);
  });
});

describe('buildActivity', () => {
  const sessions = [ref('b', 10, 'Beta'), ref('a', 30, 'Alpha')];

  it('has no rates on the first sample', () => {
    const current = sample(1000, {
      rows: [row(10, 1, 500), row(11, 10, 0), row(12, 10, 0, { rssBytes: 500 })],
    });
    const { state, histories } = buildActivity({
      previous: null,
      current,
      sessions,
      histories: new Map(),
      intervalMs: 2000,
      notes: ['a note'],
    });
    expect(state.sampledAt).toBe(1000);
    expect(state.notes).toStrictEqual(['a note']);
    expect(state.machine.cpuPct).toBeNull();
    expect(state.sessions).toHaveLength(1);
    const [session] = state.sessions;
    expect(session?.cpuPct).toBeNull();
    expect(session?.disk).toStrictEqual({ readPerSec: null, writePerSec: null });
    expect(session?.processes.map((process) => process.command)).toStrictEqual([
      'p10',
      'p12',
      'p11',
    ]);
    expect([...histories.keys()]).toStrictEqual([10, 11, 12]);
  });

  it('works out CPU, disk and network rates and sums them per session', () => {
    const previous = sample(0, {
      rows: [row(10, 1, 0), row(11, 10, 1000), row(12, 10, 0, { name: 'old' }), row(30, 1, 0)],
      cpu: { busy: 0, total: 0 },
      disk: new Map([['11', { pid: 11, read: 0, write: 0 }]]),
      network: new Map([['s', { pid: 10, read: 0, write: 0 }]]),
    });
    const current = sample(2000, {
      rows: [
        row(10, 1, 400),
        row(11, 10, 3000, { rssBytes: 900 }),
        row(12, 10, 50, { name: 'reused' }),
        row(30, 1, 0),
      ],
      cpu: { busy: 50, total: 100 },
      args: new Map([[11, 'x'.repeat(400)]]),
      disk: new Map([['11', { pid: 11, read: 4000, write: 2000 }]]),
      network: new Map([['s', { pid: 10, read: 600, write: 200 }]]),
    });
    const { state } = buildActivity({
      previous,
      current,
      sessions,
      histories: new Map(),
      intervalMs: 2000,
      notes: [],
    });
    expect(state.machine.cpuPct).toBe(50);
    expect(state.sessions.map((session) => session.title)).toStrictEqual(['Alpha', 'Beta']);
    const beta = state.sessions[1];
    expect(beta?.cpuPct).toBe(120);
    expect(beta?.memoryBytes).toBe(1100);
    expect(beta?.disk).toStrictEqual({ readPerSec: 2000, writePerSec: 1000 });
    expect(beta?.network).toStrictEqual({ readPerSec: 300, writePerSec: 100 });
    expect(beta?.processes.map((process) => [process.pid, process.cpuPct])).toStrictEqual([
      [10, 20],
      [11, 100],
      [12, null],
    ]);
    expect(beta?.processes[1]?.command).toBe(`${'x'.repeat(300)}...`);
  });

  it('turns process flags into alerts after the machine ones', () => {
    const histories = new Map<number, ProcessSnapshot[]>([
      [10, [{ state: 'D', cpuPct: 0, memoryBytes: 0, diskPerSec: 0, networkPerSec: 0 }]],
    ]);
    const current = sample(2000, {
      rows: [row(10, 1, 0, { state: 'D' }), row(11, 10, 0, { state: 'Z' })],
      loadAverage: [40, 1, 1],
      wchan: new Map([[10, 'io_schedule']]),
    });
    const { state, histories: next } = buildActivity({
      previous: sample(0, { rows: [row(10, 1, 0)] }),
      current,
      sessions,
      histories,
      intervalMs: 2000,
      notes: [],
    });
    expect(state.alerts.map((alert) => [alert.level, alert.subject])).toStrictEqual([
      ['critical', 'Machine'],
      ['warning', 'p10 (10) in Beta'],
      ['warning', 'p11 (11) in Beta'],
    ]);
    expect(state.alerts[1]?.message).toContain('io_schedule');
    expect(next.get(10)).toHaveLength(2);
  });

  it('caps each history at the window and treats missing counters as zero', () => {
    const snapshot: ProcessSnapshot = {
      state: 'S',
      cpuPct: 0,
      memoryBytes: 0,
      diskPerSec: 0,
      networkPerSec: 0,
    };
    const histories = new Map([[10, Array.from({ length: 9 }, () => snapshot)]]);
    const { state, histories: next } = buildActivity({
      previous: sample(0, { rows: [row(10, 1, 0)] }),
      current: sample(1000, { rows: [row(10, 1, 0)], network: null }),
      sessions,
      histories,
      intervalMs: 2000,
      notes: [],
    });
    expect(next.get(10)).toHaveLength(5);
    expect(state.sessions[0]?.disk).toStrictEqual({ readPerSec: 0, writePerSec: 0 });
    expect(state.sessions[0]?.network).toStrictEqual({ readPerSec: null, writePerSec: null });
  });

  it('ignores a clock that went backwards', () => {
    const { state } = buildActivity({
      previous: sample(5000, { rows: [row(10, 1, 0)] }),
      current: sample(1000, { rows: [row(10, 1, 100)] }),
      sessions: [ref('b', 10)],
      histories: new Map(),
      intervalMs: 2000,
      notes: [],
    });
    expect(state.sessions[0]?.cpuPct).toBeNull();
    expect(state.sessions[0]?.disk.readPerSec).toBeNull();
  });
});
