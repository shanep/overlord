import { describe, expect, it } from 'vitest';

import type { PlanLimit, PlanLimits } from '../../shared/protocol.js';

import { paceHold } from './pacing.js';

const HOUR = 60 * 60_000;
const NOW = 1000 * HOUR;

function limit(fields: Partial<PlanLimit>): PlanLimit {
  return {
    kind: 'session',
    label: 'Current session',
    percent: 10,
    resetsAt: NOW + 3 * HOUR,
    severity: 'normal',
    ...fields,
  };
}

function plan(...limits: PlanLimit[]): PlanLimits {
  return { subscription: 'max', limits, fetchedAt: NOW };
}

const clock = (ms: number): string => `t+${String(Math.round((ms - NOW) / 60_000))}m`;

describe('paceHold', () => {
  it('lets runs start without plan limits or with room to spare', () => {
    expect(paceHold(null, clock)).toBeNull();
    expect(paceHold(plan(), clock)).toBeNull();
    expect(paceHold(plan(limit({ percent: 30 })), clock)).toBeNull();
  });

  it('holds once the session window is nearly used', () => {
    expect(paceHold(plan(limit({ percent: 91.6 })), clock)).toBe(
      'The 5 hour session limit is 92% used, so queued runs wait until it resets at t+180m.',
    );
    expect(paceHold(plan(limit({ percent: 95, resetsAt: null })), clock)).toBe(
      'The 5 hour session limit is 95% used, so queued runs wait.',
    );
  });

  it('holds when the pace runs the window out well before the reset', () => {
    // 70% in two hours runs out in about 51 more minutes, over two hours early.
    expect(paceHold(plan(limit({ percent: 70 })), clock)).toBe(
      'At this pace the 5 hour session limit runs out at t+51m, well before it resets, so queued runs wait until it resets at t+180m.',
    );
    // The same pace under 60% used is left alone.
    expect(paceHold(plan(limit({ percent: 55 })), clock)).toBeNull();
    // 60% in four and a half hours runs out after the reset.
    expect(paceHold(plan(limit({ percent: 60, resetsAt: NOW + HOUR / 2 })), clock)).toBeNull();
  });

  it('holds on a nearly used weekly limit first', () => {
    const weekly = limit({
      kind: 'weekly_all',
      label: 'Current week',
      percent: 96,
      resetsAt: NOW + 24 * HOUR,
    });
    expect(paceHold(plan(limit({ percent: 95 }), weekly), clock)).toBe(
      'The weekly usage limit is 96% used, so queued runs wait until it resets at t+1440m.',
    );
  });
});
