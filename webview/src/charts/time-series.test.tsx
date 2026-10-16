import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NOW, requests } from '../../test/fixtures.js';

import { readChartTheme } from './chart-theme.js';
import { EChart } from './chart.js';
import { buildSparkline } from './sparkline.js';
import {
  buildCacheHitRatio,
  buildContextFill,
  buildCostOverTime,
  buildTokensOverTime,
} from './time-series.js';

const theme = readChartTheme(document.createElement('div'));
const MINUTE = 60_000;
const reversed = requests.toReversed();

describe('buildTokensOverTime', () => {
  it('stacks four token kinds in time order with a legend', () => {
    const option = buildTokensOverTime(reversed, theme);
    expect(option).toMatchObject({
      legend: { data: ['Input', 'Output', 'Cache read', 'Cache write'] },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'time' },
      series: [
        {
          name: 'Input',
          stack: 'tokens',
          lineStyle: { width: 2, color: theme.series[0] },
          areaStyle: { opacity: 0.1 },
          data: [
            [NOW - 9 * MINUTE, 1100],
            [NOW - 8 * MINUTE, 1200],
            [NOW - 7 * MINUTE, 1300],
            [NOW - 6 * MINUTE, 0],
          ],
        },
        {
          name: 'Output',
          lineStyle: { color: theme.series[1] },
          data: [
            [NOW - 9 * MINUTE, 400],
            [NOW - 8 * MINUTE, 400],
            [NOW - 7 * MINUTE, 400],
            [NOW - 6 * MINUTE, 10],
          ],
        },
        {
          name: 'Cache read',
          data: [
            [NOW - 9 * MINUTE, 25_000],
            [NOW - 8 * MINUTE, 30_000],
            [NOW - 7 * MINUTE, 35_000],
            [NOW - 6 * MINUTE, 0],
          ],
        },
        {
          name: 'Cache write',
          data: [
            [NOW - 9 * MINUTE, 2000],
            [NOW - 8 * MINUTE, 2000],
            [NOW - 7 * MINUTE, 2000],
            [NOW - 6 * MINUTE, 0],
          ],
        },
      ],
    });
  });

  it('renders in ECharts', () => {
    const { container } = render(
      <EChart option={buildTokensOverTime(requests, theme)} label="Tokens" height={200} />,
    );
    expect(container.querySelectorAll('svg path').length).toBeGreaterThan(0);
  });
});

describe('buildCostOverTime', () => {
  it('accumulates cost and treats unknown cost as zero', () => {
    const option = buildCostOverTime(reversed, theme);
    expect(option).not.toHaveProperty('legend');
    expect(option).toMatchObject({
      series: [
        {
          name: 'Cost (est.)',
          data: [
            [NOW - 9 * MINUTE, 0.05],
            [NOW - 8 * MINUTE, 0.1],
            [NOW - 7 * MINUTE, 0.1],
            [NOW - 6 * MINUTE, 0.15000000000000002],
          ],
        },
      ],
    });
  });
});

describe('buildContextFill', () => {
  it('plots prompt tokens with compaction and window marks', () => {
    const option = buildContextFill(
      { requests: reversed, compactions: [NOW - 6 * MINUTE], windowTokens: 200_000 },
      theme,
    );
    expect(option).toMatchObject({
      series: [
        {
          name: 'Context tokens',
          data: [
            [NOW - 9 * MINUTE, 28_100],
            [NOW - 8 * MINUTE, 33_200],
            [NOW - 7 * MINUTE, 38_300],
            [NOW - 6 * MINUTE, 0],
          ],
          markLine: {
            symbol: 'none',
            lineStyle: { type: 'solid' },
            data: [
              { xAxis: NOW - 6 * MINUTE, name: 'Compacted' },
              { yAxis: 200_000, name: 'Window' },
            ],
          },
        },
      ],
    });
  });

  it('leaves out the window line when the size is unknown', () => {
    const option = buildContextFill({ requests, compactions: [], windowTokens: null }, theme);
    expect(option).toMatchObject({ series: [{ markLine: { data: [] } }] });
  });

  it('renders marks in ECharts', () => {
    const option = buildContextFill(
      { requests, compactions: [NOW - 7 * MINUTE], windowTokens: 50_000 },
      theme,
    );
    const { container } = render(<EChart option={option} label="Context" height={200} />);
    expect(container.textContent).toContain('Compacted');
  });
});

describe('buildCacheHitRatio', () => {
  it('skips requests with no prompt tokens and fixes the axis at 0 to 100%', () => {
    const option = buildCacheHitRatio(reversed, theme);
    expect(option).toMatchObject({
      yAxis: { min: 0, max: 1 },
      series: [
        {
          name: 'Cache hit ratio',
          showSymbol: true,
          data: [
            [NOW - 9 * MINUTE, 25_000 / 28_100],
            [NOW - 8 * MINUTE, 30_000 / 33_200],
            [NOW - 7 * MINUTE, 35_000 / 38_300],
          ],
        },
      ],
    });
  });
});

describe('buildSparkline', () => {
  it('draws one quiet line with hidden axes', () => {
    const option = buildSparkline([1, 4, 2], theme);
    expect(option).toMatchObject({
      xAxis: { show: false, data: ['1', '4', '2'] },
      yAxis: { show: false, min: 0 },
      series: [{ type: 'line', data: [1, 4, 2], silent: true, showSymbol: false }],
    });
    expect(option).not.toHaveProperty('tooltip');
  });

  it('renders at row size', () => {
    const { getByRole } = render(
      <EChart option={buildSparkline([1, 2, 3], theme)} label="Trend" height={18} width={80} />,
    );
    expect(getByRole('img', { name: 'Trend' }).querySelector('svg')).not.toBeNull();
  });
});
