import { describe, expect, it } from 'vitest';

import type { RegistryEntry } from './live.js';
import { liveEntries, parseProcessTable, placeSessions, rootOf } from './places.js';

function entry(overrides: Partial<RegistryEntry> & { pid: number }): RegistryEntry {
  return {
    sessionId: `s${String(overrides.pid)}`,
    cwd: null,
    kind: 'interactive',
    entrypoint: 'cli',
    status: 'idle',
    statusUpdatedAt: null,
    startedAt: null,
    updatedAt: null,
    name: null,
    version: null,
    messagingSocketPath: null,
    ...overrides,
  };
}

describe('parseProcessTable', () => {
  it('reads pid and parent pid pairs and skips anything else', () => {
    const table = parseProcessTable('    1     0\n  200     1\nbogus line\n 300   200  \n\n');
    expect([...table]).toStrictEqual([
      [1, 0],
      [200, 1],
      [300, 200],
    ]);
  });
});

describe('rootOf', () => {
  const parents = new Map([
    [400, 300],
    [300, 200],
    [200, 1],
    [500, 500],
  ]);

  it('climbs the parents to a root', () => {
    expect(rootOf(400, parents, new Set([200, 999]))).toBe(200);
    expect(rootOf(200, parents, new Set([200]))).toBe(200);
    expect(rootOf(400, parents, new Set([999]))).toBeNull();
  });

  it('stops at init, at an unknown pid and in a loop', () => {
    expect(rootOf(400, parents, new Set([1]))).toBeNull();
    expect(rootOf(600, parents, new Set([200]))).toBeNull();
    expect(rootOf(500, parents, new Set([200]))).toBeNull();
  });
});

describe('liveEntries', () => {
  it('keeps one running entry per session', () => {
    const alive = new Set([10, 30]);
    const entries = [
      entry({ pid: 10, sessionId: 'a' }),
      entry({ pid: 20, sessionId: 'a' }),
      entry({ pid: 30, sessionId: 'b' }),
      entry({ pid: 40, sessionId: 'c' }),
    ];
    expect(liveEntries(entries, (pid) => alive.has(pid)).map((item) => item.pid)).toStrictEqual([
      10, 30,
    ]);
  });
});

describe('placeSessions', () => {
  it('places background, VS Code and other terminal sessions and skips other kinds', () => {
    const parents = new Map([
      [11, 10],
      [10, 5],
      [21, 20],
    ]);
    const places = placeSessions(
      [
        entry({ pid: 11, sessionId: 'here' }),
        entry({ pid: 21, sessionId: 'elsewhere' }),
        entry({ pid: 31, sessionId: 'bg', kind: 'background' }),
        entry({ pid: 41, sessionId: 'sdk', kind: 'sdk' }),
        entry({ pid: 51, sessionId: 'unknown', kind: null }),
      ],
      parents,
      new Set([5]),
    );
    expect(Object.fromEntries(places)).toStrictEqual({
      here: { place: 'vscode', terminal: 5 },
      elsewhere: { place: 'terminal', terminal: null },
      bg: { place: 'background', terminal: null },
    });
  });
});
