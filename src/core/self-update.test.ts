import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WatchFile } from './self-update.js';
import {
  heldMarkerPath,
  loadedMarkerPath,
  watchForUpdate,
  writeHeldMarker,
  writeLoadedMarker,
} from './self-update.js';

const NOTHING_RUNNING = Promise.resolve();

/** An unwatch that leaves the poll in place, like a poll already in flight. */
function keepWatching(): void {
  // Deliberately empty.
}

function fakeWatch(): {
  readonly watch: WatchFile;
  readonly change: (mtimeMs: number) => void;
  readonly watched: () => string | null;
} {
  let listener: ((mtimeMs: number) => void) | null = null;
  let file: string | null = null;
  return {
    watch: (target, next) => {
      file = target;
      listener = next;
      return (): void => {
        file = null;
        listener = null;
      };
    },
    change: (mtimeMs): void => {
      listener?.(mtimeMs);
    },
    watched: (): string | null => file,
  };
}

describe('watchForUpdate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after the bundle stops changing, then stops watching', () => {
    const fake = fakeWatch();
    const onUpdate = vi.fn();
    watchForUpdate({
      bundle: '/x/dist/extension.cjs',
      watch: fake.watch,
      settleMs: 1000,
      onUpdate,
    });
    expect(fake.watched()).toBe('/x/dist/extension.cjs');
    fake.change(5);
    vi.advanceTimersByTime(900);
    fake.change(6);
    vi.advanceTimersByTime(900);
    expect(onUpdate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(fake.watched()).toBeNull();
  });

  it('waits while the bundle is missing mid install', () => {
    const fake = fakeWatch();
    const onUpdate = vi.fn();
    watchForUpdate({ bundle: '/b', watch: fake.watch, settleMs: 1000, onUpdate });
    fake.change(5);
    vi.advanceTimersByTime(500);
    fake.change(0);
    vi.advanceTimersByTime(5000);
    expect(onUpdate).not.toHaveBeenCalled();
    fake.change(7);
    vi.advanceTimersByTime(1000);
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('never fires after stop', () => {
    const fake = fakeWatch();
    const onUpdate = vi.fn();
    const stop = watchForUpdate({ bundle: '/b', watch: fake.watch, settleMs: 1000, onUpdate });
    fake.change(5);
    stop();
    vi.advanceTimersByTime(5000);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(fake.watched()).toBeNull();
  });

  it('holds the reload until the Launcher runs finish', async () => {
    const fake = fakeWatch();
    const onUpdate = vi.fn();
    const onHold = vi.fn();
    let finish: (() => void) | undefined;
    const idle = new Promise<void>((resolve) => {
      finish = resolve;
    });
    watchForUpdate({
      bundle: '/b',
      watch: fake.watch,
      settleMs: 1000,
      onUpdate,
      onHold,
      runs: { active: () => 2, idle: async () => idle },
    });
    fake.change(5);
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    expect(onHold).toHaveBeenCalledWith(2);
    expect(onUpdate).not.toHaveBeenCalled();
    finish?.();
    await vi.runAllTimersAsync();
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('reloads at once when no run is going, and never once stopped while holding', async () => {
    const fake = fakeWatch();
    const onUpdate = vi.fn();
    const onHold = vi.fn();
    watchForUpdate({
      bundle: '/b',
      watch: fake.watch,
      settleMs: 1000,
      onUpdate,
      onHold,
      runs: { active: () => 0, idle: async () => NOTHING_RUNNING },
    });
    fake.change(5);
    vi.advanceTimersByTime(1000);
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onHold).not.toHaveBeenCalled();

    const held = fakeWatch();
    const heldUpdate = vi.fn();
    const stop = watchForUpdate({
      bundle: '/b',
      watch: held.watch,
      settleMs: 1000,
      onUpdate: heldUpdate,
      runs: { active: () => 1, idle: async () => NOTHING_RUNNING },
    });
    held.change(5);
    vi.advanceTimersByTime(1000);
    stop();
    await vi.runAllTimersAsync();
    expect(heldUpdate).not.toHaveBeenCalled();
  });

  it('ignores a late poll that lands after stop', () => {
    const polls: ((mtimeMs: number) => void)[] = [];
    const watch: WatchFile = (_file, next) => {
      polls.push(next);
      return keepWatching;
    };
    const onUpdate = vi.fn();
    const stop = watchForUpdate({ bundle: '/b', watch, settleMs: 1000, onUpdate });
    stop();
    for (const poll of polls) {
      poll(9);
    }
    vi.advanceTimersByTime(5000);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe('loaded marker', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'overlord-loaded-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sits next to the hook socket', () => {
    expect(loadedMarkerPath({ home: '/h' })).toBe('/h/.overlord/loaded.json');
  });

  it('writes the held marker next to it', async () => {
    const file = heldMarkerPath({ home: root });
    expect(file).toBe(path.join(root, '.overlord', 'held.json'));
    await writeHeldMarker(file, { bundleMtimeMs: 7, runs: 2, pid: 42, at: 99 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toStrictEqual({
      bundleMtimeMs: 7,
      runs: 2,
      pid: 42,
      at: 99,
    });
  });

  it('writes the marker as JSON, creating the directory', async () => {
    const file = loadedMarkerPath({ home: root });
    await writeLoadedMarker(file, { bundleMtimeMs: 12.5, pid: 42, at: 99 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toStrictEqual({
      bundleMtimeMs: 12.5,
      pid: 42,
      at: 99,
    });
  });
});
