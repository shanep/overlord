// A check an installed build runs on itself right after it loads: it builds
// the state of every view from the real data on this machine, the way a
// panel would, and notes what failed, how long it took and what errors the
// sources reported meanwhile. The install script waits for the result, so a
// change that only breaks on real transcripts or a real config shows up at
// install time instead of when someone opens the view.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { overlordHome } from './overlord-home.js';
import type { ClaudePaths } from './paths.js';

export interface ViewCheck {
  readonly view: string;
  readonly ok: boolean;
  /** Time to build the state the second time, once the caches had loaded. */
  readonly ms: number;
  /** Size of the state as JSON, which is what the panel is sent. */
  readonly bytes: number;
  readonly error: string | null;
}

export interface CheckedError {
  readonly source: string;
  readonly message: string;
}

export interface SelfCheckReport {
  /** mtime of the bundle that ran the check, matched against the installed file. */
  readonly bundleMtimeMs: number;
  readonly at: number;
  readonly views: readonly ViewCheck[];
  /** Errors the sources reported while the check ran. */
  readonly errors: readonly CheckedError[];
}

export interface SelfCheckDeps<V extends string> {
  readonly views: readonly V[];
  /** Builds one view's state, as a panel asking for it would. */
  readonly build: (view: V) => unknown;
  /** Waits while the first builds load caches and scan in the background. */
  readonly settle: () => Promise<void>;
  readonly errors: () => readonly (CheckedError & { readonly at: number })[];
  readonly clock: () => number;
}

function checkOne<V extends string>(view: V, deps: SelfCheckDeps<V>): ViewCheck {
  const start = deps.clock();
  try {
    const bytes = JSON.stringify(deps.build(view)).length;
    return { view, ok: true, ms: deps.clock() - start, bytes, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { view, ok: false, ms: deps.clock() - start, bytes: 0, error: message };
  }
}

/** Builds every view once to start the loads, waits, then builds and measures each again. */
export async function runSelfCheck<V extends string>(
  deps: SelfCheckDeps<V>,
): Promise<Omit<SelfCheckReport, 'bundleMtimeMs'>> {
  const started = deps.clock();
  for (const view of deps.views) {
    checkOne(view, deps);
  }
  await deps.settle();
  const views = deps.views.map((view) => checkOne(view, deps));
  const errors = deps
    .errors()
    .filter((error) => error.at >= started)
    .map(({ source, message }) => ({ source, message }));
  return { at: deps.clock(), views, errors };
}

export function selfCheckPath(paths: Pick<ClaudePaths, 'home'>): string {
  return path.join(overlordHome(paths.home), 'check.json');
}

export async function writeSelfCheck(file: string, report: SelfCheckReport): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
