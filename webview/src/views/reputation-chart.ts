// The reputation chart: kind prompts and prompts mean to Claude, side by side
// for each day.

import type { BarSeriesOption, EChartsOption } from 'echarts';

import type { ReputationState } from '../../../src/shared/reputation.js';
import {
  BAR_MAX_WIDTH,
  categoryAxis,
  grid,
  legend,
  textStyle,
  tooltip,
  valueAxis,
  valueFormatter,
} from '../charts/base.js';
import type { ChartTheme } from '../charts/chart-theme.js';
import { seriesColor } from '../charts/chart-theme.js';
import type { FigureTable } from '../components/chart-figure.js';
import { formatInteger } from '../format.js';

type Day = ReputationState['byDay'][number];

export const KIND_LABEL = 'Sweet talk';
export const MEAN_LABEL = 'Trash talk at Claude';
export const GENERAL_LABEL = 'Yelling at the void';

interface Series {
  readonly name: string;
  readonly value: (day: Day) => number;
}

const SERIES: readonly Series[] = [
  { name: KIND_LABEL, value: (day) => day.kind },
  { name: MEAN_LABEL, value: (day) => day.mean },
];

/** Whole numbers only on the count axis. */
export function countLabel(value: number): string {
  return Number.isInteger(value) ? formatInteger(value) : '';
}

function sortedDays(days: readonly Day[]): Day[] {
  return days.toSorted((left, right) => left.date.localeCompare(right.date));
}

export function buildReputationChart(days: readonly Day[], theme: ChartTheme): EChartsOption {
  const sorted = sortedDays(days);
  const series = SERIES.map((item, index): BarSeriesOption => ({
    type: 'bar',
    name: item.name,
    barMaxWidth: BAR_MAX_WIDTH,
    itemStyle: { color: seriesColor(theme, index), borderRadius: [4, 4, 0, 0] },
    data: sorted.map((day) => item.value(day)),
  }));
  return {
    animation: false,
    textStyle: textStyle(theme),
    grid: grid(true),
    legend: legend(
      theme,
      SERIES.map((item) => item.name),
    ),
    tooltip: { ...tooltip(theme, 'axis'), valueFormatter: valueFormatter(formatInteger) },
    xAxis: categoryAxis(
      theme,
      sorted.map((day) => day.date),
    ),
    yAxis: { ...valueAxis(theme, countLabel), minInterval: 1 },
    series,
  };
}

/** Table twin for the chart, one row per day. */
export function dayTable(days: readonly Day[]): FigureTable {
  return {
    columns: ['Date', 'Prompts', KIND_LABEL, MEAN_LABEL, GENERAL_LABEL],
    rows: sortedDays(days).map((day) => [
      day.date,
      formatInteger(day.prompts),
      formatInteger(day.kind),
      formatInteger(day.mean),
      formatInteger(day.general),
    ]),
  };
}
