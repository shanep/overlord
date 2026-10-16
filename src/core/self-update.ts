// Reload onto a new build without anyone pressing Reload Window. The host
// watches its own installed bundle, and once `code --install-extension`
// replaces it, the window reloads. After it loads, the host writes a marker so
// `npm run install:local` knows the new build is running.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ClaudePaths } from './paths.js';

/** Calls the listener with the file's mtime (0 while it is missing) on every poll that sees a change. */
export type WatchFile = (file: string, listener: (mtimeMs: number) => void) => () => void;

export interface UpdateWatchOptions {
  readonly bundle: string;
  readonly watch: WatchFile;
  /** Wait this long after the last change so a half written install never loads. */
  readonly settleMs: number;
  readonly onUpdate: () => void;
}

/** Calls onUpdate once, after the bundle has been replaced and stopped changing. Returns a stop function. */
export function watchForUpdate(options: UpdateWatchOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const unwatch = options.watch(options.bundle, (mtimeMs) => {
    clearTimeout(timer);
    if (stopped || mtimeMs === 0) {
      return;
    }
    timer = setTimeout(() => {
      stopped = true;
      unwatch();
      options.onUpdate();
    }, options.settleMs);
  });
  return (): void => {
    stopped = true;
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

export function loadedMarkerPath(paths: Pick<ClaudePaths, 'configDir'>): string {
  return path.join(paths.configDir, 'overlord', 'loaded.json');
}

export async function writeLoadedMarker(file: string, marker: LoadedMarker): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(marker)}\n`, 'utf8');
}
