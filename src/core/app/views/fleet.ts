// The fleet view: the store's sessions and agents, the pending permissions
// from both sources, and rate limits as 0 to 1 fractions.

import type { PermissionRequest } from '../../../shared/model.js';
import type { FleetState, PlanLimits, RateLimits } from '../../../shared/protocol.js';
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

/**
 * Prefer the plan limits /usage shows. Rate limit events only come from
 * sessions Overlord launched and carry no time, so they fill in only what the
 * plan does not report.
 */
export function withPlanLimits(limits: RateLimits, plan: PlanLimits | null): RateLimits {
  const session = plan?.limits.find((limit) => limit.kind === 'session');
  const week = plan?.limits.find((limit) => limit.kind === 'weekly_all');
  return {
    fiveHourPct: session === undefined ? limits.fiveHourPct : session.percent / 100,
    sevenDayPct: week === undefined ? limits.sevenDayPct : week.percent / 100,
    resetsAt: session === undefined ? limits.resetsAt : session.resetsAt,
  };
}

export function buildFleet(
  store: OverlordStore,
  pending: readonly PermissionRequest[],
  now: number,
  plan: PlanLimits | null,
): FleetState {
  const base = store.fleetState(now);
  return {
    sessions: base.sessions,
    agents: base.agents,
    pendingPermissions: pending,
    rateLimits: withPlanLimits(normalizeRateLimits(base.rateLimits), plan),
    spendPerHourUsd: base.spendPerHourUsd,
  };
}
