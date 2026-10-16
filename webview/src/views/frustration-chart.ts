// The frustration chart: prompts with a hit per day, stacked by whether the
// language was aimed at Claude or general.

import type { BarSeriesOption, EChartsOption } from 'echarts';

import type { FrustrationState } from '../../../src/shared/protocol.js';
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

type Day = FrustrationState['byDay'][number];

export const AIMED_LABEL = 'Aimed at Claude';
export const GENERAL_LABEL = 'General';

interface Stack {
  readonly name: string;
  readonly value: (day: Day) => number;
}

const STACKS: readonly Stack[] = [
  { name: AIMED_LABEL, value: (day) => day.atClaude },
  { name: GENERAL_LABEL, value: (day) => day.general },
];

/** Hits as a share of prompts with one decimal, since the shares are often small. */
export function formatShare(hits: number, prompts: number): string {
  return prompts > 0 ? `${((hits / prompts) * 100).toFixed(1)}%` : 'n/a';
}

/** Whole numbers only on the count axis. */
export function countLabel(value: number): string {
  return Number.isInteger(value) ? formatInteger(value) : '';
}

function sortedDays(days: readonly Day[]): Day[] {
  return days.toSorted((left, right) => left.date.localeCompare(right.date));
}

export function buildFrustrationChart(days: readonly Day[], theme: ChartTheme): EChartsOption {
  const sorted = sortedDays(days);
  const series = STACKS.map((stack, index): BarSeriesOption => ({
    type: 'bar',
    name: stack.name,
    stack: 'hits',
    barMaxWidth: BAR_MAX_WIDTH,
    itemStyle: {
      color: seriesColor(theme, index),
      // A 2px gap in the surface color keeps the stacked segments apart.
      borderColor: theme.surface,
      borderWidth: 2,
      borderRadius: index === STACKS.length - 1 ? [4, 4, 0, 0] : 0,
    },
    data: sorted.map((day) => stack.value(day)),
  }));
  return {
    animation: false,
    textStyle: textStyle(theme),
    grid: grid(true),
    legend: legend(
      theme,
      STACKS.map((stack) => stack.name),
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
    columns: ['Date', 'Prompts', AIMED_LABEL, GENERAL_LABEL, 'Share'],
    rows: sortedDays(days).map((day) => [
      day.date,
      formatInteger(day.prompts),
      formatInteger(day.atClaude),
      formatInteger(day.general),
      formatShare(day.atClaude + day.general, day.prompts),
    ]),
  };
}
