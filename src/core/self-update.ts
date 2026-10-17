// Reload onto a new build without anyone pressing Reload Window. The host
// watches its own installed bundle, and once `code --install-extension`
// replaces it, the window reloads. A reload ends every Launcher run, so while
// runs are going it waits for them and writes a held marker instead. After it
// loads, the host writes a marker so `npm run install:local` knows the new
// build is running.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { overlordHome } from './overlord-home.js';
import type { ClaudePaths } from './paths.js';

/** Calls the listener with the file's mtime (0 while it is missing) on every poll that sees a change. */
export type WatchFile = (file: string, listener: (mtimeMs: number) => void) => () => void;

export interface UpdateWatchOptions {
  readonly bundle: string;
  readonly watch: WatchFile;
  /** Wait this long after the last change so a half written install never loads. */
  readonly settleMs: number;
  readonly onUpdate: () => void;
  /** Work a reload would cut off. The reload waits until none is left. */
  readonly runs?: ReloadBlockers;
  /** Called with the number of runs once a new build has to wait for them. */
  readonly onHold?: (runs: number) => void;
}

export interface ReloadBlockers {
  /** How many Launcher runs are queued or running now. */
  readonly active: () => number;
  /** Resolves once none are. */
  readonly idle: () => Promise<void>;
}

/**
 * Calls onUpdate once, after the bundle has been replaced and stopped
 * changing, and no run is left for the reload to cut off. Returns a stop
 * function.
 */
export function watchForUpdate(options: UpdateWatchOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let disposed = false;
  const reloadWhenIdle = async (): Promise<void> => {
    const active = options.runs?.active() ?? 0;
    if (active > 0) {
      options.onHold?.(active);
      await options.runs?.idle();
    }
    if (!disposed) {
      options.onUpdate();
    }
  };
  const unwatch = options.watch(options.bundle, (mtimeMs) => {
    clearTimeout(timer);
    if (stopped || mtimeMs === 0) {
      return;
    }
    timer = setTimeout(() => {
      stopped = true;
      unwatch();
      void reloadWhenIdle();
    }, options.settleMs);
  });
  return (): void => {
    stopped = true;
    disposed = true;
    clearTimeout(timer);
    unwatch();
  };
}

export interface LoadedMarker {
  /** mtime of the bundle this window loaded, matched against the installed file. */
  readonly bundleMtimeMs: number;
  readonly pid: number;
  readonly at: number;
}

export function loadedMarkerPath(paths: Pick<ClaudePaths, 'home'>): string {
  return path.join(overlordHome(paths.home), 'loaded.json');
}

export interface HeldMarker {
  /** mtime of the new bundle that is waiting. */
  readonly bundleMtimeMs: number;
  /** Launcher runs the reload waits for. */
  readonly runs: number;
  readonly pid: number;
  readonly at: number;
}

/** Where a window says a new build waits for Launcher runs, so the install script can say so. */
export function heldMarkerPath(paths: Pick<ClaudePaths, 'home'>): string {
  return path.join(overlordHome(paths.home), 'held.json');
}

export async function writeHeldMarker(file: string, marker: HeldMarker): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(marker)}\n`, 'utf8');
}

export async function writeLoadedMarker(file: string, marker: LoadedMarker): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(marker)}\n`, 'utf8');
}
