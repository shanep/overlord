// Connects the coordinator to the app: worktree status from the cache, live
// sessions and their status from places, and the setting that turns it off.

import { Coordinator } from '../coordination/coordinator.js';

import type { Runtime } from './runtime.js';

export function createCoordinator(rt: Runtime): Coordinator {
  return new Coordinator({
    enabled: (): boolean => rt.host.settings.coordinateSessions,
    worktrees: () => rt.caches.worktrees.value,
    statuses: () => rt.places.statuses,
    isLive: (sessionId) => rt.places.pidOf(sessionId) !== null,
    refresh: (): void => {
      void rt.caches.worktrees.refresh();
    },
    now: rt.clock,
  });
}
