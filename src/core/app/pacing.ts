// Holds queued Launcher runs while the plan's usage limit is nearly used up.
// Starting more runs then only gets them cut off partway when the limit is
// reached, and leaves nothing for the sessions you work in by hand. Runs that
// already started carry on, and the queue moves again once the window resets
// or the pace drops.

import type { PlanLimit, PlanLimits } from '../../shared/protocol.js';
import { runsOutAt, SESSION_WINDOW_MS } from '../tuning/limit.js';

/** Hold once the 5 hour window is this full. */
export const HOLD_AT_PERCENT = 90;
/** Or once it is this full and the pace runs it out at least EARLY_MS before the reset. */
export const HOLD_EARLY_FROM_PERCENT = 60;
export const EARLY_MS = 30 * 60_000;
/** Hold once the weekly window is this full. */
export const WEEKLY_HOLD_AT_PERCENT = 95;

/** 3:40 PM, for saying when a window resets. */
export function timeOfDay(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function percentText(limit: PlanLimit): string {
  return `${String(Math.round(limit.percent))}%`;
}

function untilReset(limit: PlanLimit, clock: (ms: number) => string): string {
  return limit.resetsAt === null ? '' : ` until it resets at ${clock(limit.resetsAt)}`;
}

/**
 * Why queued runs should wait, or null when they can start. `clock` writes a
 * time of day, such as 3:40 PM.
 */
export function paceHold(plan: PlanLimits | null, clock: (ms: number) => string): string | null {
  if (plan === null) {
    return null;
  }
  const weekly = plan.limits.find((limit) => limit.kind === 'weekly_all');
  if (weekly !== undefined && weekly.percent >= WEEKLY_HOLD_AT_PERCENT) {
    return `The weekly usage limit is ${percentText(weekly)} used, so queued runs wait${untilReset(weekly, clock)}.`;
  }
  const session = plan.limits.find((limit) => limit.kind === 'session');
  if (session === undefined) {
    return null;
  }
  if (session.percent >= HOLD_AT_PERCENT) {
    return `The 5 hour session limit is ${percentText(session)} used, so queued runs wait${untilReset(session, clock)}.`;
  }
  const start = session.resetsAt === null ? null : session.resetsAt - SESSION_WINDOW_MS;
  const out = runsOutAt(session, start, plan.fetchedAt);
  if (
    out !== null &&
    session.resetsAt !== null &&
    session.resetsAt - out >= EARLY_MS &&
    session.percent >= HOLD_EARLY_FROM_PERCENT
  ) {
    return `At this pace the 5 hour session limit runs out at ${clock(out)}, well before it resets, so queued runs wait${untilReset(session, clock)}.`;
  }
  return null;
}
