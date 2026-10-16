// The fleet view: the store's sessions and agents, the pending permissions
// from both sources, and rate limits as 0 to 1 fractions.

import type { PermissionRequest, SessionPlace } from '../../../shared/model.js';
import type { FleetState, PlanLimits, RateLimits } from '../../../shared/protocol.js';
import type { OverlordStore } from '../../store/store.js';
import type { Runtime } from '../runtime.js';

import { currentPlan } from './usage.js';

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

export interface FleetInputs {
  readonly store: OverlordStore;
  readonly pending: readonly PermissionRequest[];
  readonly now: number;
  readonly plan: PlanLimits | null;
  readonly places: Readonly<Record<string, SessionPlace>>;
}

export function buildFleet(input: FleetInputs): FleetState {
  const base = input.store.fleetState(input.now);
  return {
    sessions: base.sessions,
    agents: base.agents,
    pendingPermissions: input.pending,
    places: input.places,
    rateLimits: withPlanLimits(normalizeRateLimits(base.rateLimits), input.plan),
    spendPerHourUsd: base.spendPerHourUsd,
  };
}

export function fleetFor(rt: Runtime): FleetState {
  return buildFleet({
    store: rt.store,
    pending: rt.permissions.list(),
    now: rt.clock(),
    plan: currentPlan(rt),
    places: rt.places.value,
  });
}
