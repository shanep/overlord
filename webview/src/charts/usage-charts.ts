// Usage history charts: daily tokens by model and activity by hour.

import type { BarSeriesOption, EChartsOption } from 'echarts';

import type { DailyUsage } from '../../../src/shared/model.js';
import { formatCompact } from '../format.js';

import {
  BAR_MAX_WIDTH,
  categoryAxis,
  categoryYAxis,
  grid,
  legend,
  textStyle,
  tooltip,
  valueAxis,
  valueFormatter,
} from './base.js';
import type { ChartTheme } from './chart-theme.js';
import { seriesColor } from './chart-theme.js';

/** At most this many models get their own color; the rest fold into Other. */
const MAX_MODELS = 4;
export const OTHER = 'Other';

/** Models ordered by total tokens, cut to MAX_MODELS, plus Other when needed. */
export function modelSeries(days: readonly DailyUsage[]): string[] {
  const totals = new Map<string, number>();
  for (const day of days) {
    for (const [model, tokens] of Object.entries(day.tokensByModel)) {
      totals.set(model, (totals.get(model) ?? 0) + tokens);
    }
  }
  const ranked = [...totals.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model]) => model);
  return ranked.length > MAX_MODELS ? [...ranked.slice(0, MAX_MODELS), OTHER] : ranked;
}

/** Tokens for `series` on `day`, where Other sums every model not named. */
export function dayTokens(day: DailyUsage, series: string, named: readonly string[]): number {
  if (series !== OTHER) {
    return day.tokensByModel[series] ?? 0;
  }
  return Object.entries(day.tokensByModel)
    .filter(([model]) => !named.includes(model))
    .reduce((sum, [, tokens]) => sum + tokens, 0);
}

export function buildDailyUsage(days: readonly DailyUsage[], theme: ChartTheme): EChartsOption {
  const sorted = days.toSorted((a, b) => a.date.localeCompare(b.date));
  const names = modelSeries(sorted);
  const named = names.filter((name) => name !== OTHER);
  const series = names.map((name, index): BarSeriesOption => ({
    type: 'bar',
    name,
    stack: 'tokens',
    barMaxWidth: BAR_MAX_WIDTH,
    itemStyle: {
      color: name === OTHER ? theme.muted : seriesColor(theme, index),
      borderColor: theme.surface,
      borderWidth: 1,
      borderRadius: index === names.length - 1 ? [4, 4, 0, 0] : 0,
    },
    data: sorted.map((day) => dayTokens(day, name, named)),
  }));
  return {
    animation: false,
    textStyle: textStyle(theme),
    grid: grid(names.length > 0),
    legend: legend(theme, names),
    tooltip: { ...tooltip(theme, 'axis'), valueFormatter: valueFormatter(formatCompact) },
    xAxis: categoryAxis(
      theme,
      sorted.map((day) => day.date),
    ),
    yAxis: valueAxis(theme, formatCompact),
    series,
  };
}

export const HOURS: readonly number[] = Array.from({ length: 24 }, (_, hour) => hour);

/** Counts for hours 0 to 23. Keys that are not an hour are ignored. */
export function hourValues(hourCounts: Readonly<Record<string, number>>): number[] {
  return HOURS.map((hour) => hourCounts[hour.toString()] ?? 0);
}

export function buildHourHeatmap(
  hourCounts: Readonly<Record<string, number>>,
  theme: ChartTheme,
): EChartsOption {
  const values = hourValues(hourCounts);
  const max = Math.max(1, ...values);
  return {
    animation: false,
    textStyle: textStyle(theme),
    grid: { left: 8, right: 16, top: 8, bottom: 48, containLabel: true },
    tooltip: { ...tooltip(theme, 'item'), valueFormatter: valueFormatter(formatCompact) },
    xAxis: categoryAxis(
      theme,
      HOURS.map((hour) => hour.toString().padStart(2, '0')),
    ),
    yAxis: categoryYAxis(theme, ['Activity'], false),
    visualMap: {
      type: 'continuous',
      min: 0,
      max,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: 120,
      calculable: false,
      inRange: { color: [...theme.sequential] },
      textStyle: { color: theme.muted, fontSize: 11 },
    },
    series: [
      {
        type: 'heatmap',
        name: 'Messages',
        data: values.map((value, hour) => [hour, 0, value]),
        itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: 2 },
      },
    ],
  };
}
