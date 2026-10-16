import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ExecFunction } from '../surfaces/process.js';

import { PLACES_REFRESH_MS, SessionPlaces } from './places.js';
import { makeEnv, writeJson } from './test-helpers/fixtures.js';

interface State {
  readonly psCalls: string[][];
  readonly errors: string[];
  changes: number;
  terminals: readonly number[] | Error;
  alive: ReadonlySet<number>;
}

interface Harness extends State {
  readonly places: SessionPlaces;
  readonly sessionsDir: string;
}

async function setup(psOut = ''): Promise<Harness> {
  const env = await makeEnv();
  const state: State = { psCalls: [], errors: [], changes: 0, terminals: [], alive: new Set() };
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
    onChange: (): void => {
      state.changes += 1;
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
    expect(h.psCalls).toStrictEqual([['ps', '-A', '-o', 'pid=,ppid=']]);
    expect(h.places.terminalFor('here')).toBe(10);
    expect(h.places.terminalFor('elsewhere')).toBeNull();
    expect(h.places.terminalFor('nobody')).toBeNull();

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
    expect(h.errors).toStrictEqual([]);
    expect(PLACES_REFRESH_MS).toBe(5000);
  });

  it('skips ps when only background sessions run', async () => {
    const h = await setup();
    await register(h.sessionsDir, 31, 'bg', 'bg');
    h.alive = new Set([31]);
    h.terminals = [10];
    await h.places.refresh();
    expect(h.places.value).toStrictEqual({ bg: 'background' });
    expect(h.psCalls).toStrictEqual([]);
  });

  it('shares a refresh that is already running', async () => {
    const h = await setup();
    await register(h.sessionsDir, 31, 'bg', 'bg');
    h.alive = new Set([31]);
    await Promise.all([h.places.refresh(), h.places.refresh()]);
    expect(h.changes).toBe(1);
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
