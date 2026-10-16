import { describe, expect, it } from 'vitest';

import type { RegistryEntry } from './live.js';
import {
  liveEntries,
  parseAttachClients,
  parseProcessTable,
  placeSessions,
  rootOf,
} from './places.js';

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

describe('parseProcessTable with commands', () => {
  it('reads the pids when ps also prints each command', () => {
    const table = parseProcessTable('  55   22 /usr/bin/claude attach 8052765a\n  60    1\n7 x\n');
    expect([...table]).toStrictEqual([
      [55, 22],
      [60, 1],
    ]);
  });
});

describe('parseAttachClients', () => {
  it('finds claude attach clients by their target id', () => {
    const stdout = [
      '  55060 22566 /Users/me/.local/bin/claude attach 8052765a',
      '  44071 22566 claude attach f5a80612-aaaa',
      '  60491 59514 /bin/zsh -c echo claude attach 99999999',
      '  70000 22566 /usr/bin/claude --resume 8052765a',
      '  80000 22566 /opt/tools/claude attach 12345678',
      'garbage',
    ].join('\n');
    expect(parseAttachClients(stdout)).toStrictEqual([
      { pid: 55_060, target: '8052765a' },
      { pid: 44_071, target: 'f5a80612-aaaa' },
      { pid: 80_000, target: '12345678' },
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

  it('places a background session in VS Code when a terminal there runs claude attach for it', () => {
    const parents = new Map([
      [70, 5],
      [80, 9],
    ]);
    const live = [
      entry({ pid: 31, sessionId: '8052765a-1f6c', kind: 'background' }),
      entry({ pid: 32, sessionId: 'f5a80612-2222', kind: 'background' }),
      entry({ pid: 33, sessionId: 'abc12345-3333', kind: 'background' }),
      entry({ pid: 34, sessionId: 'short-4444', kind: 'background' }),
    ];
    const attaches = [
      { pid: 80, target: '8052765a' },
      { pid: 70, target: '8052765a' },
      { pid: 70, target: 'f5a80612' },
      { pid: 99, target: 'abc12345' },
      { pid: 70, target: 'short' },
    ];
    expect(Object.fromEntries(placeSessions(live, parents, new Set([5]), attaches))).toStrictEqual({
      '8052765a-1f6c': { place: 'vscode', terminal: 5 },
      'f5a80612-2222': { place: 'vscode', terminal: 5 },
      'abc12345-3333': { place: 'background', terminal: null },
      'short-4444': { place: 'background', terminal: null },
    });
  });
});
