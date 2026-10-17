// The background refreshes OverlordApp starts: each cache or poll on its own
// interval. Returns the functions that stop them.

import { JOBS_REFRESH_MS } from './jobs.js';
import { PLACES_REFRESH_MS } from './places.js';
import type { IntervalFunction } from './process.js';
import { checkProgress, PROGRESS_CHECK_MS, ProgressWatch } from './progress-alerts.js';
import type { Runtime } from './runtime.js';
import { CONNECTORS_REFRESH_MS } from './views/connectors.js';
import { tidyWorktrees, WORKTREE_REFRESH_MS } from './worktrees.js';

export const SESSIONS_REFRESH_MS = 30_000;
/** How often held Launcher runs look at the usage limit again. */
const PACE_RECHECK_MS = 60_000;

export function startTimers(rt: Runtime, interval: IntervalFunction): (() => void)[] {
  const every = (ms: number, work: () => Promise<unknown>): (() => void) =>
    interval(() => {
      void work();
    }, ms);
  const watch = new ProgressWatch();
  return [
    every(SESSIONS_REFRESH_MS, async () => rt.caches.sessions.refresh()),
    every(PLACES_REFRESH_MS, async () => rt.places.refresh()),
    every(JOBS_REFRESH_MS, async () => rt.jobs.refresh()),
    every(WORKTREE_REFRESH_MS, async () => tidyWorktrees(rt)),
    every(CONNECTORS_REFRESH_MS, async () => rt.caches.connectors.refresh()),
    // Queued runs held for the usage limit start once it allows.
    every(PACE_RECHECK_MS, async () => {
      await Promise.resolve();
      if (rt.launcher.recheck()) {
        rt.notify();
      }
    }),
    every(PROGRESS_CHECK_MS, async () => checkProgress(rt, watch)),
  ];
}
