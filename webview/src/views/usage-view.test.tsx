import { within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PlanLimits } from '../../../src/shared/protocol.js';
import { usageState } from '../../test/fixtures-tools.js';
import { NOW } from '../../test/fixtures.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { dailyTable, hourTable, severityTone, totalTokensAll, UsageView } from './usage-view.js';

describe('usage tables', () => {
  it('builds the daily table twin in date order', () => {
    expect(dailyTable(usageState)).toStrictEqual({
      columns: ['Date', 'claude-opus-4-7', 'claude-sonnet-4-6'],
      rows: [
        ['2026-10-13', '300,000', '0'],
        ['2026-10-14', '500,000', '120,000'],
      ],
    });
  });

  it('folds extra models into Other in the table too', () => {
    const day = {
      date: '2026-10-01',
      messages: 1,
      sessions: 1,
      toolCalls: 1,
      tokensByModel: { a: 5, b: 4, c: 3, d: 2, e: 1 },
    };
    const table = dailyTable({ ...usageState, days: [day] });
    expect(table.columns).toStrictEqual(['Date', 'a', 'b', 'c', 'd', 'Other']);
    expect(table.rows).toStrictEqual([['2026-10-01', '5', '4', '3', '2', '1']]);
  });

  it('lists only active hours', () => {
    expect(hourTable(usageState)).toStrictEqual({
      columns: ['Hour', 'Count'],
      rows: [
        ['09:00', '12'],
        ['10:00', '30'],
        ['14:00', '8'],
      ],
    });
  });

  it('totals tokens across days', () => {
    expect(totalTokensAll(usageState)).toBe(920_000);
  });
});

describe('UsageView', () => {
  it('shows totals and both charts with tables, and passes axe', async () => {
    const { getByRole, getByText, container } = renderView(<UsageView state={usageState} />);
    expect(getByText('Sessions').nextElementSibling?.textContent).toBe('10');
    expect(getByText('Messages').nextElementSibling?.textContent).toBe('200');
    expect(getByText('Tokens').nextElementSibling?.textContent).toBe('920K');
    expect(getByText('Tool calls').nextElementSibling?.textContent).toBe('450');
    expect(getByText('Days').nextElementSibling?.textContent).toBe('2');
    expect(getByRole('img', { name: 'Daily tokens by model' })).toBeDefined();
    expect(getByRole('img', { name: 'Activity by hour of day' })).toBeDefined();
    const hours = getByRole('table', { name: 'Activity by hour of day' });
    expect(within(hours).getAllByRole('row')).toHaveLength(4);
    await expectAccessible(container);
  });

  it('says there is no data for an empty history', () => {
    const { getAllByText } = renderView(
      <UsageView
        state={{ days: [], hourCounts: {}, totalSessions: 0, totalMessages: 0, plan: null }}
      />,
    );
    expect(getAllByText('No data yet.')).toHaveLength(2);
  });

  it('leaves the plan section out when there are no plan limits', () => {
    const empty = renderView(<UsageView state={usageState} />);
    expect(empty.queryByRole('heading', { name: /Plan limits/ })).toBeNull();
    const none = renderView(
      <UsageView
        state={{ ...usageState, plan: { subscription: 'pro', limits: [], fetchedAt: NOW } }}
      />,
    );
    expect(none.queryByRole('heading', { name: /Plan limits/ })).toBeNull();
  });

  it('shows each plan limit with its grade and reset time, and passes axe', async () => {
    const plan: PlanLimits = {
      subscription: 'max',
      fetchedAt: NOW - 120_000,
      limits: [
        {
          kind: 'session',
          label: 'Current session',
          percent: 90,
          resetsAt: NOW + 2 * 3_600_000 + 5 * 60_000,
          severity: 'critical',
        },
        {
          kind: 'weekly_all',
          label: 'Current week (all models)',
          percent: 18,
          resetsAt: null,
          severity: 'normal',
        },
        {
          kind: 'weekly_scoped',
          label: 'Current week (Fable)',
          percent: 75,
          resetsAt: NOW - 1000,
          severity: 'warning',
        },
      ],
    };
    const { getByRole, getByText, container } = renderView(
      <UsageView state={{ ...usageState, plan }} />,
    );
    expect(getByRole('heading', { name: 'Plan limits (max)' })).toBeDefined();
    const session = getByRole('meter', { name: 'Current session used' });
    expect(session.getAttribute('aria-valuenow')).toBe('90');
    expect(session.firstElementChild?.className).toContain('meter-critical');
    expect(
      getByRole('meter', { name: 'Current week (Fable) used' }).firstElementChild?.className,
    ).toContain('meter-warning');
    expect(
      getByRole('meter', { name: 'Current week (all models) used' }).firstElementChild?.className,
    ).toContain('meter-info');
    expect(getByText('Resets in 2h 05m')).toBeDefined();
    expect(getByText('Resets in 0ms')).toBeDefined();
    expect(getByText('Updated 2m ago')).toBeDefined();
    await expectAccessible(container);
    const unknown = renderView(
      <UsageView state={{ ...usageState, plan: { ...plan, subscription: null } }} />,
    );
    expect(unknown.getByRole('heading', { name: 'Plan limits' })).toBeDefined();
  });
});

describe('severityTone', () => {
  it('keeps warning and critical and reads anything else as info', () => {
    expect(severityTone('critical')).toBe('critical');
    expect(severityTone('warning')).toBe('warning');
    expect(severityTone('normal')).toBe('info');
    expect(severityTone('mystery')).toBe('info');
  });
});
