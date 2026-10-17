import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ExecFunction } from '../surfaces/process.js';

import { PLACES_REFRESH_MS, SessionPlaces } from './places.js';
import { makeEnv, writeJson } from './test-helpers/fixtures.js';

interface State {
  readonly psCalls: string[][];
  readonly errors: string[];
  readonly kept: (readonly string[])[];
  changes: number;
  statusChanges: number;
  terminals: readonly number[] | Error;
  alive: ReadonlySet<number>;
}

interface Harness extends State {
  readonly places: SessionPlaces;
  readonly sessionsDir: string;
}

async function setup(psOut = ''): Promise<Harness> {
  const env = await makeEnv();
  const state: State = {
    psCalls: [],
    errors: [],
    kept: [],
    changes: 0,
    statusChanges: 0,
    terminals: [],
    alive: new Set(),
  };
  const exec: ExecFunction = async (command, args) => {
    state.psCalls.push([command, ...args]);
    await Promise.resolve();
    return { stdout: psOut };
  };
  const places = new SessionPlaces({
    paths: env.paths,
    exec,
    isAlive: (pid: number): boolean => state.alive.has(pid),
    terminalPids: async (): Promise<readonly number[]> => {
      await Promise.resolve();
      if (state.terminals instanceof Error) {
        throw state.terminals;
      }
      return state.terminals;
    },
    keep: async (sessionIds): Promise<void> => {
      await Promise.resolve();
      state.kept.push(sessionIds);
    },
    onChange: (): void => {
      state.changes += 1;
    },
    onStatus: (): void => {
      state.statusChanges += 1;
    },
    report: (source: string, message: string): void => {
      state.errors.push(`${source}: ${message}`);
    },
  });
  return Object.assign(state, { places, sessionsDir: env.paths.sessionsDir });
}

async function register(dir: string, pid: number, sessionId: string, kind: string): Promise<void> {
  await writeJson(path.join(dir, `${String(pid)}.json`), { pid, sessionId, kind });
}

describe('SessionPlaces', () => {
  it('places live sessions and tells panels only when something changes', async () => {
    const h = await setup('  11  10\n  10   1\n  21  20\n');
    await register(h.sessionsDir, 11, 'here', 'interactive');
    await register(h.sessionsDir, 21, 'elsewhere', 'interactive');
    await register(h.sessionsDir, 31, 'bg', 'bg');
    await register(h.sessionsDir, 41, 'gone', 'interactive');
    h.alive = new Set([11, 21, 31]);
    h.terminals = [10];
    expect(h.places.value).toStrictEqual({});
    await h.places.refresh();
    expect(h.places.value).toStrictEqual({
      here: 'vscode',
      elsewhere: 'terminal',
      bg: 'background',
    });
    expect(h.changes).toBe(1);
    expect(h.psCalls).toStrictEqual([['ps', '-A', '-o', 'pid=,ppid=,args=']]);
    expect(h.places.terminalFor('here')).toBe(10);
    expect(h.places.terminalFor('elsewhere')).toBeNull();
    expect(h.places.terminalFor('nobody')).toBeNull();
    expect(h.places.pidOf('bg')).toBe(31);
    expect(h.places.pidOf('gone')).toBeNull();
    expect(
      h.places
        .liveSessions()
        .map((entry) => entry.sessionId)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(['bg', 'elsewhere', 'here']);

    await h.places.refresh();
    expect(h.changes).toBe(1);
    expect(h.psCalls).toHaveLength(1);

    h.terminals = [];
    await h.places.refresh();
    expect(h.places.value).toStrictEqual({
      here: 'terminal',
      elsewhere: 'terminal',
      bg: 'background',
    });
    expect(h.changes).toBe(2);
    expect(h.psCalls).toHaveLength(1);
    // The fleet holds what a terminal shows, never a background session.
    expect(h.kept).toStrictEqual([
      ['elsewhere', 'here'],
      ['elsewhere', 'here'],
    ]);
    expect(h.errors).toStrictEqual([]);
    expect(PLACES_REFRESH_MS).toBe(1000);
  });

  it('keeps the busy or idle status each live session reports, and says when one changes', async () => {
    const h = await setup();
    const status = async (pid: number, sessionId: string, value: string | null): Promise<void> => {
      await writeJson(path.join(h.sessionsDir, `${String(pid)}.json`), {
        pid,
        sessionId,
        kind: 'bg',
        ...(value === null ? {} : { status: value }),
      });
    };
    await status(11, 'busy-one', 'busy');
    await status(21, 'idle-one', 'idle');
    await status(31, 'odd', 'thinking');
    await status(61, 'asking', 'waiting');
    await status(41, 'quiet', null);
    await status(51, 'dead', 'busy');
    h.alive = new Set([11, 21, 31, 41, 61]);
    await h.places.refresh();
    expect(h.places.statuses).toStrictEqual({
      'busy-one': 'busy',
      'idle-one': 'idle',
      asking: 'waiting',
    });
    expect(h.statusChanges).toBe(1);
    await h.places.refresh();
    expect(h.statusChanges).toBe(1);
    const changes = h.changes;
    await status(11, 'busy-one', 'idle');
    await h.places.refresh();
    expect(h.places.statuses).toStrictEqual({
      'busy-one': 'idle',
      'idle-one': 'idle',
      asking: 'waiting',
    });
    expect(h.statusChanges).toBe(2);
    expect(h.changes).toBe(changes + 1);
  });

  it('finds the session in the focused terminal', async () => {
    const h = await setup('  11  10\n  10   1\n');
    await register(h.sessionsDir, 11, 'here', 'interactive');
    h.alive = new Set([11]);
    h.terminals = [10, 20];
    await h.places.refresh();
    const before = h.changes;
    expect(h.places.activeSession()).toBeNull();
    h.places.setActiveTerminal({ sessionId: null, processId: 10 });
    expect(h.places.activeSession()).toBe('here');
    h.places.setActiveTerminal({ sessionId: null, processId: 10 });
    expect(h.changes).toBe(before + 1);
    h.places.setActiveTerminal({ sessionId: null, processId: 20 });
    expect(h.places.activeSession()).toBeNull();
    h.places.setActiveTerminal({ sessionId: 'opened', processId: 30 });
    expect(h.places.activeSession()).toBe('opened');
    h.places.setActiveTerminal(null);
    expect(h.places.activeSession()).toBeNull();
    expect(h.changes).toBe(before + 4);
    const version = h.places.activeVersion;
    h.places.windowFocused();
    expect(h.places.activeVersion).toBe(version + 1);
    expect(h.changes).toBe(before + 5);
  });

  it('tells panels when a session restarts under a new pid', async () => {
    const h = await setup();
    await register(h.sessionsDir, 31, 'bg', 'bg');
    h.alive = new Set([31]);
    await h.places.refresh();
    expect(h.changes).toBe(1);
    await register(h.sessionsDir, 32, 'bg', 'bg');
    h.alive = new Set([32]);
    await h.places.refresh();
    expect(h.places.value).toStrictEqual({ bg: 'background' });
    expect(h.places.pidOf('bg')).toBe(32);
    expect(h.changes).toBe(2);
  });

  it('skips ps when no terminal is open', async () => {
    const h = await setup();
    await register(h.sessionsDir, 31, 'bg', 'bg');
    h.alive = new Set([31]);
    h.terminals = [];
    await h.places.refresh();
    expect(h.places.value).toStrictEqual({ bg: 'background' });
    expect(h.psCalls).toStrictEqual([]);
  });

  it('shows a background session as VS Code while a tab there runs claude attach for it', async () => {
    const h = await setup('  55  10 /usr/local/bin/claude attach 8052765a\n  10   1 zsh\n');
    await register(h.sessionsDir, 31, '8052765a-1f6c-468e', 'bg');
    h.alive = new Set([31]);
    h.terminals = [10];
    await h.places.refresh();
    expect(h.places.value).toStrictEqual({ '8052765a-1f6c-468e': 'vscode' });
    expect(h.places.terminalFor('8052765a-1f6c-468e')).toBe(10);
    // Focusing that tab makes it the active session, as for a tab Overlord opened.
    h.places.setActiveTerminal({ sessionId: null, processId: 10 });
    expect(h.places.activeSession()).toBe('8052765a-1f6c-468e');
    h.terminals = [];
    await h.places.refresh();
    expect(h.places.value).toStrictEqual({ '8052765a-1f6c-468e': 'background' });
    expect(h.places.terminalFor('8052765a-1f6c-468e')).toBeNull();
  });

  it('shares a refresh that is already running', async () => {
    const h = await setup();
    await register(h.sessionsDir, 31, 'bg', 'bg');
    h.alive = new Set([31]);
    await Promise.all([h.places.refresh(), h.places.refresh()]);
    expect(h.changes).toBe(1);
  });

  it('remembers a session whose process exited until it runs again', async () => {
    const h = await setup();
    await register(h.sessionsDir, 31, 'a', 'bg');
    await register(h.sessionsDir, 32, 'b', 'bg');
    h.alive = new Set([31, 32]);
    await h.places.refresh();
    expect([...h.places.ended]).toStrictEqual([]);
    h.alive = new Set([32]);
    await h.places.refresh();
    expect([...h.places.ended]).toStrictEqual(['a']);
    // A session that was never seen alive did not exit here.
    await register(h.sessionsDir, 33, 'c', 'bg');
    await h.places.refresh();
    expect([...h.places.ended]).toStrictEqual(['a']);
    await register(h.sessionsDir, 34, 'a', 'bg');
    h.alive = new Set([32, 34]);
    await h.places.refresh();
    expect([...h.places.ended]).toStrictEqual([]);
  });

  it('reports a failure and keeps the last places', async () => {
    const h = await setup();
    await register(h.sessionsDir, 31, 'bg', 'bg');
    h.alive = new Set([31]);
    await h.places.refresh();
    h.terminals = new Error('terminals gone');
    await h.places.refresh();
    expect(h.places.value).toStrictEqual({ bg: 'background' });
    expect(h.errors).toStrictEqual(['session places: terminals gone']);
  });
});
