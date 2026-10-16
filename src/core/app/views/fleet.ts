// The fleet view: the store's sessions and agents, the pending permissions
// from both sources, and rate limits as 0 to 1 fractions.

import type { PermissionRequest } from '../../../shared/model.js';
import type { FleetState, RateLimits } from '../../../shared/protocol.js';
import type { OverlordStore } from '../../store/store.js';

/** The harness reports fractions; anything over 1 is a percentage and gets scaled down. */
export function toFraction(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  return value > 1 ? value / 100 : value;
}

export function normalizeRateLimits(limits: RateLimits): RateLimits {
  return {
    fiveHourPct: toFraction(limits.fiveHourPct),
    sevenDayPct: toFraction(limits.sevenDayPct),
    resetsAt: limits.resetsAt,
  };
}

export function buildFleet(
  store: OverlordStore,
  pending: readonly PermissionRequest[],
  now: number,
): FleetState {
  const base = store.fleetState(now);
  return {
    sessions: base.sessions,
    agents: base.agents,
    pendingPermissions: pending,
    rateLimits: normalizeRateLimits(base.rateLimits),
    spendPerHourUsd: base.spendPerHourUsd,
  };
}
