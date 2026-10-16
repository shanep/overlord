import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parsePlanUsage } from './plan-limits.js';

const NOW = 1_800_000_000_000;

// Trimmed from a real get_usage reply (Claude Agent SDK 0.3.301).
const REPLY = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 90, resets_at: '2026-10-16T04:50:00.137086+00:00' },
    seven_day: { utilization: 18, resets_at: '2026-10-20T08:00:00.137108+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: { is_enabled: false, utilization: null },
    limits: [
      {
        kind: 'session',
        group: 'session',
        percent: 90,
        severity: 'critical',
        resets_at: '2026-10-16T04:50:00.137086+00:00',
        scope: null,
        is_active: true,
      },
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 18,
        severity: 'normal',
        resets_at: '2026-10-20T08:00:00.137108+00:00',
        scope: null,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 0,
        severity: 'normal',
        resets_at: '2026-10-20T08:00:00+00:00',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      },
    ],
    model_scoped: [
      { display_name: 'Fable', utilization: 0, resets_at: '2026-10-20T08:00:00+00:00' },
    ],
  },
  behaviors: null,
};

function extra(isEnabled: boolean): unknown {
  return {
    rate_limits_available: true,
    rate_limits: { limits: [], extra_usage: { is_enabled: isEnabled, utilization: 20 } },
  };
}

describe('parsePlanUsage', () => {
  it('uses the server rows in order with their grades and reset times', () => {
    expect(parsePlanUsage(REPLY, NOW)).toStrictEqual({
      subscription: 'max',
      fetchedAt: NOW,
      limits: [
        {
          kind: 'session',
          label: 'Current session',
          percent: 90,
          resetsAt: Date.parse('2026-10-16T04:50:00.137Z'),
          severity: 'critical',
        },
        {
          kind: 'weekly_all',
          label: 'Current week (all models)',
          percent: 18,
          resetsAt: Date.parse('2026-10-20T08:00:00.137Z'),
          severity: 'normal',
        },
        {
          kind: 'weekly_scoped',
          label: 'Current week (Fable)',
          percent: 0,
          resetsAt: Date.parse('2026-10-20T08:00:00Z'),
          severity: 'normal',
        },
      ],
    });
  });

  it('labels scoped surfaces and unknown kinds, and drops broken rows', () => {
    const plan = parsePlanUsage(
      {
        rate_limits_available: true,
        rate_limits: {
          limits: [
            { kind: 'weekly_scoped', percent: 5, scope: { surface: { display_name: 'Cowork' } } },
            { kind: 'weekly_scoped', percent: 6, scope: null },
            { kind: 'monthly_spend', percent: 150, severity: 7, resets_at: 'not a date' },
            { kind: 'session' },
            'junk',
          ],
        },
      },
      NOW,
    );
    expect(plan?.subscription).toBeNull();
    expect(plan?.limits).toStrictEqual([
      {
        kind: 'weekly_scoped',
        label: 'Current week (Cowork)',
        percent: 5,
        resetsAt: null,
        severity: 'normal',
      },
      {
        kind: 'weekly_scoped',
        label: 'Current week',
        percent: 6,
        resetsAt: null,
        severity: 'normal',
      },
      {
        kind: 'monthly_spend',
        label: 'Monthly spend',
        percent: 100,
        resetsAt: null,
        severity: 'normal',
      },
    ]);
  });

  it('builds rows from the named windows when the server sends no rows', () => {
    const plan = parsePlanUsage(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 75, resets_at: null },
          seven_day: { utilization: 95 },
          seven_day_opus: { utilization: 10, resets_at: '2026-10-20T08:00:00Z' },
          seven_day_sonnet: { utilization: null },
        },
      },
      NOW,
    );
    expect(plan?.limits).toStrictEqual([
      {
        kind: 'session',
        label: 'Current session',
        percent: 75,
        resetsAt: null,
        severity: 'warning',
      },
      {
        kind: 'weekly_all',
        label: 'Current week (all models)',
        percent: 95,
        resetsAt: null,
        severity: 'critical',
      },
      {
        kind: 'weekly_scoped',
        label: 'Current week (Opus)',
        percent: 10,
        resetsAt: Date.parse('2026-10-20T08:00:00Z'),
        severity: 'normal',
      },
    ]);
  });

  it('prefers model_scoped over the opus and sonnet windows', () => {
    const plan = parsePlanUsage(
      {
        rate_limits_available: true,
        rate_limits: {
          seven_day_opus: { utilization: 10 },
          model_scoped: [{ display_name: 'Fable', utilization: 3 }],
        },
      },
      NOW,
    );
    expect(plan?.limits.map((limit) => limit.label)).toStrictEqual(['Current week (Fable)']);
  });

  it('adds extra usage only when it is turned on', () => {
    expect(parsePlanUsage(extra(false), NOW)?.limits).toStrictEqual([]);
    expect(parsePlanUsage(extra(true), NOW)?.limits).toStrictEqual([
      {
        kind: 'extra_usage',
        label: 'Extra usage this month',
        percent: 20,
        resetsAt: null,
        severity: 'normal',
      },
    ]);
  });

  it('is null when plan limits do not apply or the reply is not an object', () => {
    expect(parsePlanUsage({ rate_limits_available: false, rate_limits: null }, NOW)).toBeNull();
    expect(parsePlanUsage({ rate_limits_available: true, rate_limits: null }, NOW)).toBeNull();
    expect(parsePlanUsage({ ...REPLY, rate_limits_available: 'yes' }, NOW)).toBeNull();
    expect(parsePlanUsage(null, NOW)).toBeNull();
    expect(parsePlanUsage('nope', NOW)).toBeNull();
  });

  it('never throws and keeps every percent in range', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (limits, fiveHour) => {
        const plan = parsePlanUsage(
          { rate_limits_available: true, rate_limits: { limits, five_hour: fiveHour } },
          NOW,
        );
        for (const limit of plan?.limits ?? []) {
          expect(limit.percent).toBeGreaterThanOrEqual(0);
          expect(limit.percent).toBeLessThanOrEqual(100);
        }
      }),
    );
  });
});
