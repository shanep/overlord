import { within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { BridgeUsageDay } from '../../../src/shared/bridge-usage.js';
import type { PlanLimits } from '../../../src/shared/protocol.js';
import { usageState } from '../../test/fixtures-tools.js';
import { NOW } from '../../test/fixtures.js';
import { expectAccessible, renderView } from '../../test/render.js';

import {
  bridgeTotals,
  dailyTable,
  formatAmount,
  hourTable,
  localDate,
  severityTone,
  totalTokensAll,
  UsageView,
} from './usage-view.js';

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

  it('formats amounts with fewer decimals as they grow', () => {
    expect(formatAmount(0.0412)).toBe('0.04');
    expect(formatAmount(0.999)).toBe('1');
    expect(formatAmount(1)).toBe('1');
    expect(formatAmount(9.84)).toBe('9.8');
    expect(formatAmount(10.4)).toBe('10');
    expect(formatAmount(1480.6)).toBe('1,481');
    expect(formatAmount(Number.NaN)).toBe('n/a');
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

  it('shows Boise State usage by day and by model, only when the bridge logged calls', async () => {
    const day = 24 * 60 * 60_000;
    const row = (at: number, calls: number): BridgeUsageDay => ({
      date: localDate(at),
      calls,
      inputTokens: calls * 1000,
      outputTokens: calls * 100,
    });
    const bridge = {
      days: [row(NOW - 20 * day, 5), row(NOW - 3 * day, 2), row(NOW, 1)],
      models: [
        {
          model: 'global.anthropic.claude-opus-5-5',
          calls: 7,
          inputTokens: 7000,
          outputTokens: 700,
        },
        {
          model: 'global.anthropic.claude-sonnet-5',
          calls: 1,
          inputTokens: 1000,
          outputTokens: 100,
        },
      ],
    };
    expect(bridgeTotals(bridge, localDate(NOW - 6 * day))).toStrictEqual({
      calls: 3,
      inputTokens: 3000,
      outputTokens: 300,
    });
    const { getByRole, container } = renderView(<UsageView state={{ ...usageState, bridge }} />);
    const tiles = container.querySelector('[aria-label="Boise State usage"]');
    expect(tiles?.textContent).toContain('Today1.1K1 calls');
    expect(tiles?.textContent).toContain('Last 7 days3.3K3 calls');
    expect(tiles?.textContent).toContain('All time8.8K8 calls');
    const byDay = getByRole('table', { name: 'Boise State usage by day' });
    expect(within(byDay).getAllByRole('row')).toHaveLength(4);
    expect(within(byDay).getAllByRole('row')[1]?.textContent).toContain(localDate(NOW));
    expect(getByRole('table', { name: 'Boise State usage by model' })).toBeDefined();
    await expectAccessible(container);

    const plain = renderView(<UsageView state={usageState} />);
    expect(within(plain.container).queryByRole('heading', { name: /Boise State/ })).toBeNull();
  });

  it('says there is no data for an empty history and leaves the climate section out', () => {
    const climate = { ...usageState.climate, models: [], unpricedTokens: 0 };
    const { getAllByText, queryByRole } = renderView(
      <UsageView
        state={{
          days: [],
          hourCounts: {},
          totalSessions: 0,
          totalMessages: 0,
          climate,
          plan: null,
        }}
      />,
    );
    expect(getAllByText('No data yet.')).toHaveLength(2);
    expect(queryByRole('heading', { name: /Climate impact/ })).toBeNull();
  });

  it('shows the climate estimate, its assumptions and a row per model, and passes axe', async () => {
    const { getByRole, getByText, container } = renderView(<UsageView state={usageState} />);
    const section = getByRole('region', { name: 'Climate impact (estimate)' });
    const inside = within(section);
    expect(inside.getByText('Energy').nextElementSibling?.textContent).toBe('13 kWh');
    expect(inside.getByText('CO2e').nextElementSibling?.textContent).toBe('5 kg');
    expect(inside.getByText('Cooling water').nextElementSibling?.textContent).toBe('23 L');
    expect(inside.getByText('Same as driving').nextElementSibling?.textContent).toBe('13 miles');
    expect(inside.getByText('Same as a US home for').nextElementSibling?.textContent).toBe(
      '0.43 days',
    );
    expect(getByText(/assumes 40 Wh per dollar, 0.4 kg CO2e per kWh and 1.8 L/)).toBeDefined();
    const table = getByRole('table', { name: 'Climate impact by model' });
    const rows = within(table).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toStrictEqual([
      'ModelTotal tokensEnergy (kWh)CO2e (kg)',
      'claude-opus-4-7800K124.8',
      'claude-sonnet-4-6120K0.50.2',
    ]);
    expect(inside.queryByText(/no list price/)).toBeNull();
    await expectAccessible(container);
  });

  it('says how many tokens had no price, even with no priced models', () => {
    const climate = { ...usageState.climate, models: [], unpricedTokens: 2_500_000 };
    const { getByText, queryByRole } = renderView(<UsageView state={{ ...usageState, climate }} />);
    expect(getByText('2.5M tokens from models with no list price are left out.')).toBeDefined();
    expect(queryByRole('table', { name: 'Climate impact by model' })).toBeNull();
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
