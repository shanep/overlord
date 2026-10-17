// The reputation chart: kind prompts and prompts mean to the agent, side by
// side for each day.

import type { BarSeriesOption, EChartsOption } from 'echarts';

import type { AgentInfo } from '../../../src/shared/agents.js';
import type { ReputationState } from '../../../src/shared/reputation.js';
import { soleAgent, useAgents } from '../agents.js';
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
export const GENERAL_LABEL = 'Yelling at the void';

/** Who the mean prompts were aimed at: the one agent on offer, or all of them. */
export function targetName(agents: readonly AgentInfo[]): string {
  return soleAgent(agents)?.short ?? 'your agents';
}

export function meanLabel(target: string): string {
  return `Trash talk at ${target}`;
}

/** The label for mean prompts, naming the agents the host knows. */
export function useMeanLabel(): string {
  return meanLabel(targetName(useAgents()));
}

/** With Claude Code alone, which is how most people run it. */
export const MEAN_LABEL = meanLabel('Claude');

interface Series {
  readonly name: string;
  readonly value: (day: Day) => number;
}

function seriesFor(mean: string): readonly Series[] {
  return [
    { name: KIND_LABEL, value: (day) => day.kind },
    { name: mean, value: (day) => day.mean },
  ];
}

/** Whole numbers only on the count axis. */
export function countLabel(value: number): string {
  return Number.isInteger(value) ? formatInteger(value) : '';
}

function sortedDays(days: readonly Day[]): Day[] {
  return days.toSorted((left, right) => left.date.localeCompare(right.date));
}

export function buildReputationChart(
  days: readonly Day[],
  theme: ChartTheme,
  mean: string = MEAN_LABEL,
): EChartsOption {
  const sorted = sortedDays(days);
  const all = seriesFor(mean);
  const series = all.map((item, index): BarSeriesOption => ({
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
      all.map((item) => item.name),
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
export function dayTable(days: readonly Day[], mean: string = MEAN_LABEL): FigureTable {
  return {
    columns: ['Date', 'Prompts', KIND_LABEL, mean, GENERAL_LABEL],
    rows: sortedDays(days).map((day) => [
      day.date,
      formatInteger(day.prompts),
      formatInteger(day.kind),
      formatInteger(day.mean),
      formatInteger(day.general),
    ]),
  };
}
