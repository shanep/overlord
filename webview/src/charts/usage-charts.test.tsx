import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DailyUsage } from '../../../src/shared/model.js';
import { usageState } from '../../test/fixtures-tools.js';
import { first } from '../../test/render.js';

import { readChartTheme } from './chart-theme.js';
import { EChart } from './chart.js';
import {
  buildDailyUsage,
  buildHourHeatmap,
  dayTokens,
  HOURS,
  hourValues,
  modelSeries,
  OTHER,
} from './usage-charts.js';

const theme = readChartTheme(document.createElement('div'));

function day(date: string, tokensByModel: Record<string, number>): DailyUsage {
  return { date, messages: 1, sessions: 1, toolCalls: 1, tokensByModel };
}

const manyModels = [
  day('2026-10-01', { a: 50, b: 40, c: 30, d: 20, e: 10, f: 5 }),
  day('2026-10-02', { a: 1, e: 2 }),
];

describe('modelSeries', () => {
  it('ranks models by total tokens', () => {
    expect(modelSeries(usageState.days)).toStrictEqual(['claude-opus-4-7', 'claude-sonnet-4-6']);
  });

  it('folds past four models into Other and breaks ties by name', () => {
    expect(modelSeries(manyModels)).toStrictEqual(['a', 'b', 'c', 'd', OTHER]);
    expect(modelSeries([day('x', { z: 1, y: 1 })])).toStrictEqual(['y', 'z']);
  });
});

describe('dayTokens', () => {
  it('reads one model or sums the rest for Other', () => {
    const firstDay = first(manyModels);
    expect(dayTokens(firstDay, 'a', ['a', 'b'])).toBe(50);
    expect(dayTokens(firstDay, 'zzz', ['a'])).toBe(0);
    expect(dayTokens(firstDay, OTHER, ['a', 'b', 'c', 'd'])).toBe(15);
  });
});

describe('buildDailyUsage', () => {
  it('stacks bars per model by date with a rounded top segment', () => {
    expect(buildDailyUsage(usageState.days, theme)).toMatchObject({
      legend: { data: ['claude-opus-4-7', 'claude-sonnet-4-6'] },
      xAxis: { data: ['2026-10-13', '2026-10-14'] },
      series: [
        {
          name: 'claude-opus-4-7',
          stack: 'tokens',
          barMaxWidth: 24,
          itemStyle: { color: theme.series[0], borderColor: theme.surface, borderRadius: 0 },
          data: [300_000, 500_000],
        },
        {
          name: 'claude-sonnet-4-6',
          itemStyle: { color: theme.series[1], borderRadius: [4, 4, 0, 0] },
          data: [0, 120_000],
        },
      ],
    });
  });

  it('colors Other with the muted ink', () => {
    const option = buildDailyUsage(manyModels, theme);
    expect(option).toMatchObject({
      series: [{}, {}, {}, {}, { name: OTHER, itemStyle: { color: theme.muted }, data: [15, 2] }],
    });
  });

  it('handles no days', () => {
    expect(buildDailyUsage([], theme)).toMatchObject({ grid: { top: 12 }, series: [] });
  });

  it('renders in ECharts', () => {
    const { container } = render(
      <EChart option={buildDailyUsage(usageState.days, theme)} label="Daily" height={200} />,
    );
    expect(container.textContent).toContain('2026-10-14');
  });
});

describe('hourValues', () => {
  it('reads 24 hours and ignores other keys', () => {
    const values = hourValues({ '0': 2, '23': 5, x: 9, '24': 1 });
    expect(values).toHaveLength(24);
    expect(values[0]).toBe(2);
    expect(values[23]).toBe(5);
    expect(values.reduce((sum, value) => sum + value, 0)).toBe(7);
    expect(HOURS[23]).toBe(23);
  });
});

describe('buildHourHeatmap', () => {
  it('maps counts to a sequential ramp scaled to the busiest hour', () => {
    const option = buildHourHeatmap(usageState.hourCounts, theme);
    expect(option).toMatchObject({
      visualMap: { min: 0, max: 30, inRange: { color: theme.sequential } },
      yAxis: { data: ['Activity'] },
      series: [{ type: 'heatmap', itemStyle: { borderColor: theme.surface, borderWidth: 2 } }],
    });
    expect(option).toMatchObject({
      xAxis: { data: HOURS.map((hour) => hour.toString().padStart(2, '0')) },
      series: [
        {
          data: HOURS.map((hour) => {
            const counts: Readonly<Record<number, number>> = { 9: 12, 10: 30, 14: 8 };
            return [hour, 0, counts[hour] ?? 0];
          }),
        },
      ],
    });
  });

  it('keeps a positive scale with no activity and renders', () => {
    const option = buildHourHeatmap({}, theme);
    expect(option).toMatchObject({ visualMap: { max: 1 } });
    const { container } = render(<EChart option={option} label="Hours" height={140} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
