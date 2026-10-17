import { describe, expect, it } from 'vitest';

import type { PlanLimit, PlanLimits } from '../../shared/protocol.js';

import { buildLimit, runsOutAt, SESSION_WINDOW_MS, WEEK_MS } from './limit.js';
import type { SpendHour } from './spend-hours.js';
import { HOUR_MS } from './spend-hours.js';
import { measureOf } from './test-helpers/fixtures.js';

const NOW = 1000 * HOUR_MS;

function hour(at: number, fields: Partial<SpendHour> = {}): SpendHour {
  return {
    at,
    usd: 0,
    subagentUsd: 0,
    premiumUsd: 0,
    premiumSavingUsd: 0,
    subagentSavingUsd: 0,
    bigContextUsd: 0,
    idleRewriteUsd: 0,
    ...fields,
  };
}

function limit(fields: Partial<PlanLimit>): PlanLimit {
  return {
    kind: 'session',
    label: 'Current session',
    percent: 50,
    resetsAt: NOW + 3 * HOUR_MS,
    severity: 'normal',
    ...fields,
  };
}

function plan(limits: readonly PlanLimit[]): PlanLimits {
  return { subscription: 'max', limits, fetchedAt: NOW };
}

describe('runsOutAt', () => {
  it('projects the pace so far and keeps it only when it beats the reset', () => {
    const start = NOW - 2 * HOUR_MS;
    // 50% in two hours fills in two more, an hour before the reset.
    expect(runsOutAt(limit({}), start, NOW)).toBe(NOW + 2 * HOUR_MS);
    expect(runsOutAt(limit({ percent: 20 }), start, NOW)).toBeNull();
  });

  it('has no pace without a start, a reset or a share in between', () => {
    expect(runsOutAt(limit({}), null, NOW)).toBeNull();
    expect(runsOutAt(limit({ resetsAt: null }), NOW - HOUR_MS, NOW)).toBeNull();
    expect(runsOutAt(limit({ percent: 0 }), NOW - HOUR_MS, NOW)).toBeNull();
    expect(runsOutAt(limit({ percent: 100 }), NOW - HOUR_MS, NOW)).toBeNull();
    expect(runsOutAt(limit({}), NOW, NOW)).toBeNull();
  });
});

describe('buildLimit', () => {
  it('reads the session and weekly windows and leaves other meters out', () => {
    const state = buildLimit({
      plan: plan([
        limit({}),
        limit({ kind: 'weekly_all', label: 'Current week', resetsAt: NOW + WEEK_MS / 2 }),
        limit({ kind: 'weekly_scoped', label: 'Current week (Opus)' }),
      ]),
      measures: [],
      now: NOW,
    });
    expect(state.subscription).toBe('max');
    expect(state.windows.map((window) => [window.kind, window.startsAt])).toStrictEqual([
      ['session', NOW + 3 * HOUR_MS - SESSION_WINDOW_MS],
      ['weekly_all', NOW - WEEK_MS / 2],
    ]);
    expect(state.windowStart).toBe(NOW - 2 * HOUR_MS);
    expect(state.levers).toStrictEqual([]);
  });

  it('splits the window spend by session, biggest first', () => {
    const big = measureOf({
      sessionId: 'big',
      title: 'Big',
      hours: [hour(NOW - 10 * HOUR_MS, { usd: 100 }), hour(NOW - HOUR_MS, { usd: 3 })],
    });
    const small = measureOf({ sessionId: 'small', title: 'Small', hours: [hour(NOW, { usd: 1 })] });
    const old = measureOf({ sessionId: 'old', hours: [hour(NOW - 9 * HOUR_MS, { usd: 5 })] });
    const state = buildLimit({ plan: null, measures: [small, old, big], now: NOW });
    expect(state.windowStart).toBe(NOW - SESSION_WINDOW_MS);
    expect(state.windowUsd).toBe(4);
    expect(state.sessions).toStrictEqual([
      { sessionId: 'big', title: 'Big', usd: 3, share: 0.75 },
      { sessionId: 'small', title: 'Small', usd: 1, share: 0.25 },
    ]);
    expect(state.weekUsd).toBe(109);
  });

  it('ranks the levers by what they save over the week and drops the small ones', () => {
    const measure = measureOf({
      hours: [
        hour(NOW - 2 * 24 * HOUR_MS, {
          usd: 100,
          premiumUsd: 80,
          premiumSavingUsd: 40,
          subagentUsd: 10,
          subagentSavingUsd: 1,
          bigContextUsd: 20,
          idleRewriteUsd: 5,
        }),
        // Older than a week, so it does not count.
        hour(NOW - WEEK_MS - HOUR_MS, { usd: 1000, premiumSavingUsd: 1000 }),
      ],
    });
    const state = buildLimit({ plan: null, measures: [measure], now: NOW });
    expect(state.levers.map((lever) => [lever.id, lever.saving])).toStrictEqual([
      ['routine-model', 0.4],
      ['context', 0.2],
      ['idle-rewrite', 0.05],
    ]);
    expect(state.levers[0]?.finding).toBe(
      '80% of the last week went to Opus, Fable or Mythos in main sessions. Changing this would have saved about $40 of $100.',
    );
    expect(state.levers[1]?.tipId).toBe('huge-context');
  });
});
