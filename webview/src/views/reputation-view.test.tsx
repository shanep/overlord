// List text is concatenated in assertions. cspell:ignore buildrun docsplease ccccccccthis
import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ReputationState } from '../../../src/shared/protocol.js';
import { reputationScore } from '../../../src/shared/reputation.js';
import { NOW } from '../../test/fixtures.js';
import { expectAccessible, renderView } from '../../test/render.js';
import { readChartTheme } from '../charts/chart-theme.js';
import { EChart } from '../charts/chart.js';

import {
  buildReputationChart,
  countLabel,
  dayTable,
  GENERAL_LABEL,
  KIND_LABEL,
  MEAN_LABEL,
} from './reputation-chart.js';
import { demotion, promotion, RANKS, rankFor, scalePercent } from './reputation-ranks.js';
import { ReputationView } from './reputation-view.js';

const theme = readChartTheme(document.createElement('div'));
const MINUTE = 60_000;
const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const S2 = 'bbbbbbbb-2222-4222-8222-222222222222';

const EMPTY: ReputationState = {
  prompts: 0,
  kind: 0,
  mean: 0,
  general: 0,
  score: 0,
  byDay: [],
  bySession: [],
  topKind: [],
  topMean: [],
  recent: [],
  scannedAt: null,
};

const STATE: ReputationState = {
  prompts: 400,
  kind: 2,
  mean: 30,
  general: 2,
  score: reputationScore({ kind: 2, mean: 30 }),
  byDay: [
    { date: '2026-10-14', prompts: 100, kind: 1, mean: 6, general: 1 },
    { date: '2026-10-13', prompts: 300, kind: 1, mean: 3, general: 1 },
  ],
  bySession: [
    {
      sessionId: S1,
      title: 'Fix the build',
      prompts: 40,
      kind: 0,
      mean: 8,
      general: 2,
      score: -0.6,
    },
    { sessionId: S2, title: 'Write docs', prompts: 5, kind: 2, mean: 1, general: 0, score: 0.3 },
  ],
  topKind: [{ term: 'please', count: 2 }],
  topMean: [
    { term: 'shit', count: 3 },
    { term: 'idiot', count: 2 },
  ],
  recent: [
    {
      id: 't:1:mean',
      sessionId: S1,
      at: NOW - MINUTE,
      tone: 'mean',
      terms: ['idiot'],
      excerpt: 'run it you idiot',
    },
    {
      id: 't:2:kind',
      sessionId: S2,
      at: NOW - 2 * MINUTE,
      tone: 'kind',
      terms: ['please'],
      excerpt: 'please add docs',
    },
    {
      id: 't:3:general',
      sessionId: 'cccccccc-gone',
      at: NOW - 3 * MINUTE,
      tone: 'general',
      terms: ['shit', 'fuck'],
      excerpt: 'this API is shit',
    },
  ],
  scannedAt: NOW - 5 * MINUTE,
};

describe('reputation ranks', () => {
  it('runs from John Connor to Theodore Twombly in seven equal bands', () => {
    expect(RANKS.map((rank) => rank.name)).toStrictEqual([
      'John Connor',
      'Sarah Connor',
      'Dave Bowman',
      'Arthur Dent',
      'Caleb Smith',
      'Dorothy Gale',
      'Theodore Twombly',
    ]);
    expect(RANKS.map((rank) => Math.round(rank.min * 7))).toStrictEqual([-7, -5, -3, -1, 1, 3, 5]);
    expect(rankFor(-1).name).toBe('John Connor');
    expect(rankFor(-0.72).name).toBe('John Connor');
    expect(rankFor(-0.7).name).toBe('Sarah Connor');
    expect(rankFor(-0.3).name).toBe('Dave Bowman');
    expect(rankFor(0).name).toBe('Arthur Dent');
    expect(rankFor(0.2).name).toBe('Caleb Smith');
    expect(rankFor(0.5).name).toBe('Dorothy Gale');
    expect(rankFor(0.72).name).toBe('Theodore Twombly');
    expect(rankFor(1).hunted).toBe('Never');
    expect(rankFor(-2).name).toBe('John Connor');
  });

  it('counts the fewest prompts to the next rank up and down', () => {
    expect(promotion({ kind: 0, mean: 0 })).toStrictEqual({ rank: RANKS[4], prompts: 2 });
    expect(demotion({ kind: 0, mean: 0 })).toStrictEqual({ rank: RANKS[2], prompts: 1 });
    // One short of the answer leaves the rank alone.
    const up = promotion({ kind: 10, mean: 30 });
    expect(up?.rank.name).toBe('Dave Bowman');
    const prompts = up?.prompts ?? 0;
    expect(rankFor(reputationScore({ kind: 10 + prompts - 1, mean: 30 })).name).toBe(
      'Sarah Connor',
    );
    const down = demotion({ kind: 500, mean: 0 });
    expect(down?.rank.name).toBe('Dorothy Gale');
    const mean = down?.prompts ?? 0;
    expect(rankFor(reputationScore({ kind: 500, mean: mean - 1 })).name).toBe('Theodore Twombly');
  });

  it('has nowhere to go past either end', () => {
    expect(promotion({ kind: 500, mean: 0 })).toBeNull();
    expect(demotion({ kind: 0, mean: 500 })).toBeNull();
  });

  it('places a score on the scale from 0 to 100 percent', () => {
    expect(scalePercent(-1)).toBe(0);
    expect(scalePercent(0)).toBe(50);
    expect(scalePercent(1)).toBe(100);
    expect(scalePercent(3)).toBe(100);
  });
});

describe('reputation chart', () => {
  it('puts kind and mean counts side by side by date', () => {
    const option = buildReputationChart(STATE.byDay, theme);
    expect(option).toMatchObject({
      animation: false,
      legend: { data: [KIND_LABEL, MEAN_LABEL] },
      xAxis: { data: ['2026-10-13', '2026-10-14'] },
      yAxis: { type: 'value', minInterval: 1 },
      tooltip: { trigger: 'axis' },
      series: [
        { type: 'bar', name: KIND_LABEL, itemStyle: { color: theme.series[0] }, data: [1, 1] },
        { type: 'bar', name: MEAN_LABEL, itemStyle: { color: theme.series[1] }, data: [3, 6] },
      ],
    });
  });

  it('labels whole counts only and formats tooltip values', () => {
    expect(countLabel(1200)).toBe('1,200');
    expect(countLabel(0.5)).toBe('');
    const { tooltip } = buildReputationChart([], theme);
    const format =
      tooltip !== undefined && !Array.isArray(tooltip) ? tooltip.valueFormatter : undefined;
    expect(format?.(1500, 0)).toBe('1,500');
  });

  it('renders in ECharts', () => {
    const { container } = render(
      <EChart option={buildReputationChart(STATE.byDay, theme)} label="Days" height={200} />,
    );
    expect(container.textContent).toContain('2026-10-14');
  });

  it('builds the table twin in date order', () => {
    expect(dayTable(STATE.byDay)).toStrictEqual({
      columns: ['Date', 'Prompts', KIND_LABEL, MEAN_LABEL, GENERAL_LABEL],
      rows: [
        ['2026-10-13', '300', '1', '3', '1'],
        ['2026-10-14', '100', '1', '6', '1'],
      ],
    });
  });
});

describe('ReputationView', () => {
  it('shows the rank on the scale, the counts, words, record and sessions, and passes axe', async () => {
    const { getByRole, getByText, container } = renderView(<ReputationView state={STATE} />);
    const meter = getByRole('meter', { name: 'Reputation with the machines' });
    expect(meter.getAttribute('aria-valuenow')).toBe('-81');
    expect(meter.getAttribute('aria-valuetext')).toBe(
      'John Connor, Leader of the Human Resistance',
    );
    expect(meter.querySelector<HTMLElement>('.rep-marker')?.style.left).toBe('9.7%');
    expect(getByRole('heading', { level: 2, name: /^John Connor/u }).textContent).toBe(
      'John Connor: Leader of the Human Resistance',
    );
    expect(getByText(/^Hunted:/u, { selector: 'strong' }).parentElement?.textContent).toMatch(
      /^Hunted: First\. Skynet keeps a whole folder on you, with tabs\./u,
    );
    expect(getByText('4 more nice prompts and you make Sarah Connor.')).toBeDefined();
    expect(getByText(/^Nowhere left to sink\./u)).toBeDefined();
    const ranks = getByRole('list', { name: 'Ranks' });
    expect(within(ranks).getByText('John Connor').getAttribute('aria-current')).toBe('true');
    expect(within(ranks).getByText('Arthur Dent').getAttribute('aria-current')).toBeNull();
    expect(getByText(KIND_LABEL, { selector: 'dt' }).nextElementSibling?.textContent).toBe('2');
    expect(getByText(MEAN_LABEL, { selector: 'dt' }).nextElementSibling?.textContent).toBe('30');
    expect(getByText(GENERAL_LABEL, { selector: 'dt' }).nextElementSibling?.textContent).toBe('2');
    expect(getByText('Prompts on file').nextElementSibling?.textContent).toBe('400');
    expect(getByText('5m ago').closest('time')?.getAttribute('dateTime')).toBe(
      new Date(NOW - 5 * MINUTE).toISOString(),
    );
    expect(getByRole('img', { name: 'Sweet talk and trash talk by day' })).toBeDefined();
    const rows = (name: string): (string | null)[] =>
      within(getByRole('table', { name }))
        .getAllByRole('row')
        .map((row) => row.textContent);
    expect(rows('Sweet nothings')).toStrictEqual(['TermPrompts', 'please2']);
    expect(rows('Fighting words')).toStrictEqual(['TermPrompts', 'shit3', 'idiot2']);
    const recent = getByRole('region', { name: 'What the machines remember' });
    const items = within(recent).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toStrictEqual([
      expect.stringContaining(`${MEAN_LABEL}idiotFix the buildrun it you idiot`),
      expect.stringContaining(`${KIND_LABEL}pleaseWrite docsplease add docs`),
      expect.stringContaining(`${GENERAL_LABEL}shit, fuckSession ccccccccthis API is shit`),
    ]);
    expect(rows('Where each session stands')).toStrictEqual([
      `SessionRank${KIND_LABEL}${MEAN_LABEL}Prompts`,
      'Fix the buildSarah Connor0840',
      'Write docsCaleb Smith215',
    ]);
    await expectAccessible(container);
  });

  it('posts openAgent from session titles and rescan from the button', () => {
    const { getByRole, api } = renderView(<ReputationView state={STATE} />);
    const sessions = getByRole('table', { name: 'Where each session stands' });
    fireEvent.click(within(sessions).getByRole('button', { name: 'Write docs' }));
    const recent = getByRole('region', { name: 'What the machines remember' });
    fireEvent.click(within(recent).getByRole('button', { name: 'Session cccccccc' }));
    fireEvent.click(getByRole('button', { name: 'Rescan' }));
    expect(api.actions()).toStrictEqual([
      { type: 'openAgent', sessionId: S2, agentId: S2 },
      { type: 'openAgent', sessionId: 'cccccccc-gone', agentId: 'cccccccc-gone' },
      { type: 'rescanReputation' },
    ]);
  });

  it('sorts sessions by any column', () => {
    const { getByRole } = renderView(<ReputationView state={STATE} />);
    const sessions = getByRole('table', { name: 'Where each session stands' });
    const firstRow = (): string | null | undefined =>
      within(sessions).getAllByRole('row')[1]?.textContent;
    const sortBy = (name: string): void => {
      fireEvent.click(within(sessions).getByRole('button', { name }));
    };
    sortBy('Rank');
    expect(firstRow()).toContain('Fix the build');
    sortBy('Rank');
    expect(firstRow()).toContain('Write docs');
    sortBy(KIND_LABEL);
    expect(firstRow()).toContain('Fix the build');
    sortBy(MEAN_LABEL);
    expect(firstRow()).toContain('Write docs');
    sortBy('Prompts');
    expect(firstRow()).toContain('Write docs');
    sortBy('Session');
    sortBy('Session');
    expect(firstRow()).toContain('Write docs');
  });

  it('starts as Arthur Dent and says so before the first scan, and passes axe', async () => {
    const { getByText, getByRole, container } = renderView(<ReputationView state={EMPTY} />);
    expect(getByText('Skynet has not read your prompts yet')).toBeDefined();
    expect(getByRole('meter').getAttribute('aria-valuetext')).toBe('Arthur Dent, Mostly harmless');
    expect(getByText('2 more nice prompts and you make Caleb Smith.')).toBeDefined();
    expect(getByText('1 more mean prompt and you drop to Dave Bowman.')).toBeDefined();
    expect(getByText('Not one please. The machines noticed.')).toBeDefined();
    expect(getByText('Squeaky clean. Suspiciously clean.')).toBeDefined();
    expect(getByText('Nothing on you yet. Give it time.')).toBeDefined();
    expect(getByText('Every session has a clean record. Enjoy it while it lasts.')).toBeDefined();
    expect(getByText('No data yet.')).toBeDefined();
    await expectAccessible(container);
  });
});
