import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../bus.js';
import type { Exec } from '../sync/exec.js';
import { DEFAULT_PRICES } from '../transcripts/pricing.js';

import { AsyncValue } from './async-value.js';
import { ChangeHub } from './changes.js';
import { ErrorLog, MAX_ERRORS, messageOf } from './errors.js';
import { DEFAULT_MODEL, formatUsd, MODEL_ALIASES, toEstimatePrices } from './prices.js';
import { defaultInterval, defaultKill, pollingFileWatch, toSurfacesExec } from './process.js';
import { makeEnv, settle, sorted, waitFor, writeText } from './test-helpers/fixtures.js';
import { plural, shortId } from './text.js';

describe('messageOf', () => {
  it('uses the message of an Error and stringifies anything else', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf('plain')).toBe('plain');
    expect(messageOf(42)).toBe('42');
  });
});

describe('ErrorLog', () => {
  it('records bus errors with the clock time until detached', () => {
    const bus = new EventBus();
    let now = 5;
    const log = new ErrorLog(() => now);
    const off = log.attach(bus);
    bus.emit('source.error', { source: 'a', message: 'one' });
    now = 9;
    bus.emit('source.error', { source: 'b', message: 'two' });
    off();
    bus.emit('source.error', { source: 'c', message: 'three' });
    expect(log.list()).toStrictEqual([
      { source: 'a', message: 'one', at: 5 },
      { source: 'b', message: 'two', at: 9 },
    ]);
  });

  it('moves a repeat to the end with the new time instead of adding it again', () => {
    let now = 1;
    const log = new ErrorLog(() => now);
    log.add('a', 'same');
    log.add('a', 'other');
    log.add('b', 'same');
    now = 2;
    log.add('a', 'same');
    expect(log.list()).toStrictEqual([
      { source: 'a', message: 'other', at: 1 },
      { source: 'b', message: 'same', at: 1 },
      { source: 'a', message: 'same', at: 2 },
    ]);
  });

  it('keeps only the newest entries up to the limit', () => {
    const log = new ErrorLog(() => 0, 2);
    log.add('s', '1');
    log.add('s', '2');
    expect(log.list()).toHaveLength(2);
    log.add('s', '3');
    expect(log.list().map((entry) => entry.message)).toStrictEqual(['2', '3']);
  });

  it('defaults to fifty entries and returns a copy', () => {
    const log = new ErrorLog(() => 0);
    for (let index = 0; index < MAX_ERRORS + 5; index += 1) {
      log.add('s', String(index));
    }
    const list = log.list();
    expect(MAX_ERRORS).toBe(50);
    expect(list).toHaveLength(50);
    expect(list[0]?.message).toBe('5');
    expect(log.list()).not.toBe(list);
  });
});

describe('ChangeHub', () => {
  it('calls every listener until it unsubscribes or the hub is cleared', () => {
    const hub = new ChangeHub();
    const first = vi.fn();
    const second = vi.fn();
    const off = hub.on(first);
    hub.on(second);
    hub.notify();
    off();
    hub.notify();
    hub.clear();
    hub.notify();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('skips a listener that another one removed during the same notify', () => {
    const hub = new ChangeHub();
    const later = vi.fn();
    const holder: { off: (() => void) | null } = { off: null };
    hub.on(() => {
      holder.off?.();
    });
    holder.off = hub.on(later);
    hub.notify();
    expect(later).not.toHaveBeenCalled();
  });
});

interface Gate<T> {
  readonly promise: Promise<T>;
  readonly open: (value: T) => void;
}

function deferred<T>(): Gate<T> {
  const box: { resolve: ((value: T) => void) | null } = { resolve: null };
  const promise = new Promise<T>((resolve) => {
    box.resolve = resolve;
  });
  return {
    promise,
    open: (value): void => {
      box.resolve?.(value);
    },
  };
}

describe('AsyncValue', () => {
  it('returns the initial value, loads on first read and notifies', async () => {
    const onUpdate = vi.fn();
    const load = vi.fn(async (): Promise<string> => {
      await Promise.resolve();
      return 'loaded';
    });
    const value = new AsyncValue({ name: 'x', initial: 'start', load, onUpdate, onError: vi.fn() });
    expect(value.peek()).toBe('start');
    expect(load).not.toHaveBeenCalled();
    expect(value.value).toBe('start');
    await settle();
    expect(value.value).toBe('loaded');
    expect(load).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('runs one more load when refreshed during a load', async () => {
    const gates = [deferred<number>(), deferred<number>()];
    let calls = 0;
    const value = new AsyncValue({
      name: 'x',
      initial: 0,
      load: async (): Promise<number> => {
        const gate = gates[calls];
        calls += 1;
        return gate === undefined ? 99 : await gate.promise;
      },
      onUpdate: vi.fn(),
      onError: vi.fn(),
    });
    expect(value.loading).toBe(false);
    const first = value.refresh();
    expect(value.loading).toBe(true);
    const second = value.refresh();
    const third = value.refresh();
    gates[0]?.open(1);
    await settle();
    expect(calls).toBe(2);
    gates[1]?.open(2);
    await Promise.all([first, second, third]);
    expect(value.loading).toBe(false);
    expect(value.peek()).toBe(2);
    expect(calls).toBe(2);
    await value.refresh();
    expect(value.peek()).toBe(99);
  });

  it('keeps the old value and reports a failed load once', async () => {
    const onError = vi.fn();
    const onUpdate = vi.fn();
    const value = new AsyncValue({
      name: 'usage',
      initial: 'old',
      load: async (): Promise<string> => {
        await Promise.resolve();
        throw new Error('disk gone');
      },
      onUpdate,
      onError,
    });
    expect(value.value).toBe('old');
    await settle();
    expect(value.value).toBe('old');
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('usage', 'disk gone');
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe('prices', () => {
  it('converts every list price and adds the CLI aliases', () => {
    const table = toEstimatePrices(DEFAULT_PRICES);
    expect(table['claude-opus-5-5']).toStrictEqual({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(table['opus']).toStrictEqual({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(table['sonnet']).toStrictEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(table['haiku']).toStrictEqual({ inputPerMTok: 0.1, outputPerMTok: 0.5 });
    expect(table['fable']).toStrictEqual({ inputPerMTok: 10, outputPerMTok: 50 });
    expect(Object.keys(table)).toHaveLength(Object.keys(DEFAULT_PRICES).length + 4);
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
    expect(Object.keys(MODEL_ALIASES)).toStrictEqual(['opus', 'sonnet', 'haiku', 'fable']);
  });

  it('skips an alias whose model has no price', () => {
    const table = toEstimatePrices({
      'claude-opus-5-5': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    });
    expect(sorted(Object.keys(table))).toStrictEqual(['claude-opus-5-5', 'opus']);
  });

  it('formats dollars with two decimals', () => {
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(0)).toBe('$0.00');
  });
});

describe('text helpers', () => {
  it('pluralizes and shortens ids', () => {
    expect(plural(1, 'run')).toBe('1 run');
    expect(plural(0, 'run')).toBe('0 runs');
    expect(plural(3, 'run')).toBe('3 runs');
    expect(shortId('0123456789abcdef')).toBe('01234567');
  });
});

describe('process helpers', () => {
  it('adapts the sync exec for the surfaces modules', async () => {
    const seen: unknown[] = [];
    const exec: Exec = async (command, args, options) => {
      seen.push({ command, args, options });
      await Promise.resolve();
      return args[0] === 'good'
        ? { code: 0, stdout: 'out', stderr: '' }
        : { code: 3, stdout: '', stderr: args[0] === 'loud' ? ' broke \n' : '' };
    };
    const surfaces = toSurfacesExec(exec);
    await expect(surfaces('claude', ['good'], { timeoutMs: 7 })).resolves.toStrictEqual({
      stdout: 'out',
    });
    await expect(surfaces('claude', ['loud'], { timeoutMs: 7 })).rejects.toThrow(
      'claude failed: broke',
    );
    await expect(surfaces('claude', ['quiet'], { timeoutMs: 7 })).rejects.toThrow(
      'claude exited 3',
    );
    expect(seen[0]).toStrictEqual({ command: 'claude', args: ['good'], options: { timeoutMs: 7 } });
  });

  it('runs an interval until stopped', async () => {
    const tick = vi.fn<() => void>();
    const stop = defaultInterval(tick, 2);
    await waitFor(() => tick.mock.calls.length >= 2);
    stop();
    const count = tick.mock.calls.length;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(tick).toHaveBeenCalledTimes(count);
  });

  it('notices a file that appears and stops watching when asked', async () => {
    const env = await makeEnv();
    const file = path.join(env.root, 'watched.json');
    const changed = vi.fn<() => void>();
    const stop = pollingFileWatch(5)(file, changed);
    await writeText(file, '{}');
    await waitFor(() => changed.mock.calls.length > 0);
    stop();
    const count = changed.mock.calls.length;
    await rm(file);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 40);
    });
    expect(changed).toHaveBeenCalledTimes(count);
    await expect(readFile(file)).rejects.toThrow();
  });

  it('sends a real signal to a process', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    const exited = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once('exit', (_code, signal) => {
        resolve(signal);
      });
    });
    const { pid } = child;
    if (pid === undefined) {
      throw new Error('the child has no pid');
    }
    defaultKill(pid, 'SIGTERM');
    await expect(exited).resolves.toBe('SIGTERM');
  });
});
