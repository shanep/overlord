// The fleet view: the store's sessions and agents with finished background
// jobs marked done, the pending permissions from both sources, and rate
// limits as 0 to 1 fractions.

import type { PermissionRequest, SessionPlace, SessionSummary } from '../../../shared/model.js';
import { ZERO_USAGE } from '../../../shared/model.js';
import type { FleetState, PlanLimits, RateLimits } from '../../../shared/protocol.js';
import type { OverlordStore } from '../../store/store.js';
import type { FinishedJob } from '../../surfaces/jobs.js';
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

/** A row for a finished job whose transcript is gone, from what Claude Code still knows. */
function jobSession(job: FinishedJob): SessionSummary {
  const startedAt = job.startedAt ?? 0;
  return {
    id: job.sessionId,
    surface: 'cli',
    title: job.name ?? '',
    cwd: job.cwd ?? '',
    state: job.state,
    startedAt,
    updatedAt: startedAt,
    usage: ZERO_USAGE,
    costUsd: null,
    model: null,
    effort: null,
    permissionMode: null,
    pid: null,
    transcriptPath: null,
    gitBranch: null,
    version: null,
    agentCount: 0,
    contextFill: null,
  };
}

/**
 * A transcript cannot tell a finished job from an idle session, so Claude
 * Code's job state wins. Jobs with no transcript still get a row.
 */
export function withFinishedJobs(
  sessions: readonly SessionSummary[],
  jobs: readonly FinishedJob[],
): readonly SessionSummary[] {
  if (jobs.length === 0) {
    return sessions;
  }
  const byId = new Map(jobs.map((job) => [job.sessionId, job]));
  const marked = sessions.map((session) => {
    const job = byId.get(session.id);
    return job === undefined || job.state === session.state
      ? session
      : { ...session, state: job.state };
  });
  const known = new Set(sessions.map((session) => session.id));
  const bare = jobs.filter((job) => !known.has(job.sessionId)).map((job) => jobSession(job));
  return [...marked, ...bare];
}

export interface FleetInputs {
  readonly store: OverlordStore;
  readonly pending: readonly PermissionRequest[];
  readonly now: number;
  readonly plan: PlanLimits | null;
  readonly places: Readonly<Record<string, SessionPlace>>;
  readonly jobs: readonly FinishedJob[];
}

export function buildFleet(input: FleetInputs): FleetState {
  const base = input.store.fleetState(input.now);
  return {
    sessions: withFinishedJobs(base.sessions, input.jobs),
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
    jobs: rt.jobs.value,
  });
}
