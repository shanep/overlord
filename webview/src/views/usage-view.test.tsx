import { within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { usageState } from '../../test/fixtures-tools.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { dailyTable, hourTable, totalTokensAll, UsageView } from './usage-view.js';

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
      <UsageView state={{ days: [], hourCounts: {}, totalSessions: 0, totalMessages: 0 }} />,
    );
    expect(getAllByText('No data yet.')).toHaveLength(2);
  });
});
