import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { FrustrationState } from '../../../src/shared/protocol.js';
import { NOW } from '../../test/fixtures.js';
import { expectAccessible, renderView } from '../../test/render.js';
import { readChartTheme } from '../charts/chart-theme.js';
import { EChart } from '../charts/chart.js';

import {
  AIMED_LABEL,
  buildFrustrationChart,
  countLabel,
  dayTable,
  formatShare,
  GENERAL_LABEL,
} from './frustration-chart.js';
import { FrustrationView } from './frustration-view.js';

const theme = readChartTheme(document.createElement('div'));
const MINUTE = 60_000;
const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const S2 = 'bbbbbbbb-2222-4222-8222-222222222222';

const EMPTY: FrustrationState = {
  totalPrompts: 0,
  atClaude: 0,
  general: 0,
  byDay: [],
  bySession: [],
  topTerms: [],
  recent: [],
  scannedAt: null,
};

const STATE: FrustrationState = {
  totalPrompts: 400,
  atClaude: 3,
  general: 2,
  byDay: [
    { date: '2026-10-14', prompts: 100, atClaude: 2, general: 1 },
    { date: '2026-10-13', prompts: 300, atClaude: 1, general: 1 },
  ],
  bySession: [
    { sessionId: S1, title: 'Fix the build', prompts: 40, hits: 4 },
    { sessionId: S2, title: 'Write docs', prompts: 5, hits: 1 },
  ],
  topTerms: [
    { term: 'shit', count: 3 },
    { term: 'idiot', count: 2 },
  ],
  recent: [
    {
      id: 't:1',
      sessionId: S1,
      at: NOW - MINUTE,
      terms: ['idiot'],
      target: 'claude',
      excerpt: 'run it you idiot',
    },
    {
      id: 't:2',
      sessionId: 'cccccccc-gone',
      at: NOW - 2 * MINUTE,
      terms: ['shit', 'fuck'],
      target: 'general',
      excerpt: 'this API is shit',
    },
  ],
  scannedAt: NOW - 5 * MINUTE,
};

describe('frustration chart', () => {
  it('stacks aimed and general counts by date with a 2px gap and a rounded top', () => {
    const option = buildFrustrationChart(STATE.byDay, theme);
    expect(option).toMatchObject({
      animation: false,
      legend: { data: [AIMED_LABEL, GENERAL_LABEL] },
      xAxis: { data: ['2026-10-13', '2026-10-14'] },
      yAxis: { type: 'value', minInterval: 1 },
      tooltip: { trigger: 'axis' },
      grid: { top: 32 },
      series: [
        {
          type: 'bar',
          name: AIMED_LABEL,
          stack: 'hits',
          barMaxWidth: 24,
          itemStyle: {
            color: theme.series[0],
            borderColor: theme.surface,
            borderWidth: 2,
            borderRadius: 0,
          },
          data: [1, 2],
        },
        {
          name: GENERAL_LABEL,
          stack: 'hits',
          itemStyle: { color: theme.series[1], borderRadius: [4, 4, 0, 0] },
          data: [1, 1],
        },
      ],
    });
  });

  it('labels whole counts only and formats tooltip values', () => {
    expect(countLabel(1200)).toBe('1,200');
    expect(countLabel(0.5)).toBe('');
    const option = buildFrustrationChart([], theme);
    const { tooltip } = option;
    const format =
      tooltip !== undefined && !Array.isArray(tooltip) ? tooltip.valueFormatter : undefined;
    expect(format?.(1500, 0)).toBe('1,500');
  });

  it('renders in ECharts', () => {
    const { container } = render(
      <EChart option={buildFrustrationChart(STATE.byDay, theme)} label="Hits" height={200} />,
    );
    expect(container.textContent).toContain('2026-10-14');
  });

  it('builds the table twin in date order with shares', () => {
    expect(dayTable(STATE.byDay)).toStrictEqual({
      columns: ['Date', 'Prompts', AIMED_LABEL, GENERAL_LABEL, 'Share'],
      rows: [
        ['2026-10-13', '300', '1', '1', '0.7%'],
        ['2026-10-14', '100', '2', '1', '3.0%'],
      ],
    });
  });

  it('formats a share with one decimal and n/a with no prompts', () => {
    expect(formatShare(5, 400)).toBe('1.3%');
    expect(formatShare(0, 0)).toBe('n/a');
    expect(formatShare(1, 1)).toBe('100.0%');
  });
});

describe('FrustrationView', () => {
  it('shows the headline counts, chart, terms, recent hits and sessions, and passes axe', async () => {
    const { getByRole, getByText, container } = renderView(<FrustrationView state={STATE} />);
    expect(getByText('Aimed at Claude', { selector: 'dt' }).nextElementSibling?.textContent).toBe(
      '3',
    );
    expect(getByText('General', { selector: 'dt' }).nextElementSibling?.textContent).toBe('2');
    expect(getByText('Share of prompts').nextElementSibling?.textContent).toBe('1.3%');
    expect(getByText('Prompts counted').nextElementSibling?.textContent).toBe('400');
    expect(getByText('5m ago').closest('time')?.getAttribute('dateTime')).toBe(
      new Date(NOW - 5 * MINUTE).toISOString(),
    );
    expect(getByRole('img', { name: 'Prompts with hits by day' })).toBeDefined();
    const terms = getByRole('table', { name: 'Top terms' });
    expect(
      within(terms)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toStrictEqual(['TermPrompts', 'shit3', 'idiot2']);
    const recent = getByRole('region', { name: 'Recent' });
    const items = within(recent).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('run it you idiot');
    expect(items[0]?.textContent).toContain(AIMED_LABEL);
    expect(items[0]?.textContent).toContain('Fix the build');
    expect(items[1]?.textContent).toContain('shit, fuck');
    expect(items[1]?.textContent).toContain(GENERAL_LABEL);
    expect(items[1]?.textContent).toContain('Session cccccccc');
    const sessions = getByRole('table', { name: 'Sessions with hits' });
    expect(
      within(sessions)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toStrictEqual(['SessionHitsPromptsShare', 'Fix the build44010.0%', 'Write docs1520.0%']);
    await expectAccessible(container);
  });

  it('posts openAgent from session titles and rescan from the button', () => {
    const { getByRole, api } = renderView(<FrustrationView state={STATE} />);
    const sessions = getByRole('table', { name: 'Sessions with hits' });
    fireEvent.click(within(sessions).getByRole('button', { name: 'Write docs' }));
    const recent = getByRole('region', { name: 'Recent' });
    fireEvent.click(within(recent).getByRole('button', { name: 'Session cccccccc' }));
    fireEvent.click(getByRole('button', { name: 'Rescan' }));
    expect(api.actions()).toStrictEqual([
      { type: 'openAgent', sessionId: S2, agentId: S2 },
      { type: 'openAgent', sessionId: 'cccccccc-gone', agentId: 'cccccccc-gone' },
      { type: 'rescanFrustration' },
    ]);
  });

  it('sorts sessions by any column', () => {
    const { getByRole } = renderView(<FrustrationView state={STATE} />);
    const sessions = getByRole('table', { name: 'Sessions with hits' });
    const firstRow = (): string | null | undefined =>
      within(sessions).getAllByRole('row')[1]?.textContent;
    const sortBy = (name: string): void => {
      fireEvent.click(within(sessions).getByRole('button', { name }));
    };
    sortBy('Share');
    expect(firstRow()).toContain('Fix the build');
    sortBy('Share');
    expect(firstRow()).toContain('Write docs');
    sortBy('Hits');
    expect(firstRow()).toContain('Write docs');
    sortBy('Prompts');
    expect(firstRow()).toContain('Write docs');
    sortBy('Session');
    sortBy('Session');
    expect(firstRow()).toContain('Write docs');
  });

  it('says so before the first scan and when nothing matched, and passes axe', async () => {
    const { getByText, getAllByText, container } = renderView(<FrustrationView state={EMPTY} />);
    expect(getByText('Not scanned yet')).toBeDefined();
    expect(getByText('Share of prompts').nextElementSibling?.textContent).toBe('n/a');
    expect(getAllByText('None.')).toHaveLength(2);
    expect(getByText('No sessions with hits.')).toBeDefined();
    expect(getByText('No data yet.')).toBeDefined();
    await expectAccessible(container);
  });
});
