import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LaunchRun } from '../../shared/protocol.js';

import { LaunchedSessions } from './launched-sessions.js';

let dir = '';
let file = '';
let kept: (readonly string[])[] = [];
let changes = 0;
let errors: string[] = [];

function make(): LaunchedSessions {
  return new LaunchedSessions({
    file,
    keep: async (ids): Promise<void> => {
      kept.push(ids);
      await Promise.resolve();
    },
    onChange: (): void => {
      changes += 1;
    },
    report: (source, message): void => {
      errors.push(`${source}: ${message}`);
    },
  });
}

function saved(): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('LaunchedSessions', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'overlord-launched-'));
    file = path.join(dir, 'launched.json');
    kept = [];
    changes = 0;
    errors = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('holds nothing when no file was saved yet', async () => {
    const launched = make();
    await launched.load();
    expect(launched.list()).toStrictEqual([]);
    expect(kept).toStrictEqual([[]]);
    expect(errors).toStrictEqual([]);
  });

  it('saves added sessions, holds them, and keeps them across a reload', async () => {
    const launched = make();
    await launched.load();
    await launched.add('s1');
    await launched.add('s2');
    await launched.add('s1');
    expect(launched.list()).toStrictEqual(['s1', 's2']);
    expect(launched.has('s2')).toBe(true);
    expect(saved()).toStrictEqual({ version: 1, sessions: ['s1', 's2'] });
    expect(kept.at(-1)).toStrictEqual(['s1', 's2']);
    expect(changes).toBe(3);

    const reloaded = make();
    await reloaded.load();
    expect(reloaded.list()).toStrictEqual(['s1', 's2']);
    expect(kept.at(-1)).toStrictEqual(['s1', 's2']);
  });

  it('lets a session go only when it is removed', async () => {
    const launched = make();
    await launched.add('s1');
    await launched.add('s2');
    expect(await launched.remove('s1')).toBe(true);
    expect(await launched.remove('s1')).toBe(false);
    expect(launched.list()).toStrictEqual(['s2']);
    expect(saved()).toStrictEqual({ version: 1, sessions: ['s2'] });
    expect(kept.at(-1)).toStrictEqual(['s2']);
  });

  it('adds each run once it has a session', async () => {
    const launched = make();
    const listeners: ((run: LaunchRun) => void)[] = [];
    const stop = launched.track({
      onChange: (listener) => {
        listeners.push(listener);
        return (): void => {
          listeners.length = 0;
        };
      },
    });
    const run: LaunchRun = {
      id: 'r1',
      batchId: 'b1',
      spec: {
        prompt: '',
        cwd: '/b',
        profileId: null,
        worktree: false,
        maxBudgetUsd: null,
        label: '',
      },
      sessionId: null,
      state: 'queued',
      costUsd: 0,
      turns: 0,
      durationMs: 0,
      result: null,
      worktreePath: null,
    };
    for (const listener of listeners) {
      listener(run);
      listener({ ...run, sessionId: 'run-session' });
    }
    await launched.load();
    expect(launched.list()).toStrictEqual(['run-session']);
    stop();
    expect(listeners).toStrictEqual([]);
  });

  it('reports a file it cannot read and still holds what it has', async () => {
    writeFileSync(file, '{ not json');
    const launched = make();
    await launched.load();
    expect(errors).toStrictEqual([`launched: ${file} is not valid JSON`]);
    expect(launched.list()).toStrictEqual([]);
  });
});
