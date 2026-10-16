// Gantt timeline of tool calls. Each call gets its own row in start order,
// so parallel calls show as overlapping bars on neighboring rows. Bars sit
// on an invisible offset bar, a plain way to draw ranges with bar series.

import type { BarSeriesOption, EChartsOption } from 'echarts';

import type { ToolCall } from '../../../src/shared/model.js';

import {
  BAR_MAX_WIDTH,
  categoryYAxis,
  grid,
  legend,
  textStyle,
  tooltip,
  valueFormatter,
  valueXAxis,
} from './base.js';
import type { ChartTheme } from './chart-theme.js';
import { seriesColor } from './chart-theme.js';

export type CallStatus = 'ok' | 'error' | 'running';

export interface TimelineRow {
  readonly label: string;
  readonly status: CallStatus;
  /** Seconds after the first call started. */
  readonly offset: number;
  readonly seconds: number;
}

const STATUS_NAMES: Readonly<Record<CallStatus, string>> = {
  ok: 'Done',
  error: 'Error',
  running: 'Running',
};

export function callStatus(call: ToolCall): CallStatus {
  if (call.endedAt === null) {
    return 'running';
  }
  return call.ok === false ? 'error' : 'ok';
}

/** The last `limit` calls as rows, timed against `now` when still running. */
export function timelineRows(
  calls: readonly ToolCall[],
  now: number,
  limit: number,
): TimelineRow[] {
  const sorted = calls.toSorted((a, b) => a.startedAt - b.startedAt).slice(-limit);
  const first = sorted[0]?.startedAt ?? now;
  return sorted.map((call, index) => ({
    label: `${(index + 1).toString()}. ${call.name}`,
    status: callStatus(call),
    offset: (call.startedAt - first) / 1000,
    seconds: Math.max(0, ((call.endedAt ?? now) - call.startedAt) / 1000),
  }));
}

function seconds(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)}s`;
}

export function buildToolTimeline(rows: readonly TimelineRow[], theme: ChartTheme): EChartsOption {
  const colors: Readonly<Record<CallStatus, string>> = {
    ok: theme.good,
    error: theme.critical,
    running: seriesColor(theme, 0),
  };
  const statuses: readonly CallStatus[] = ['ok', 'error', 'running'];
  const offset: BarSeriesOption = {
    type: 'bar',
    name: 'Offset',
    stack: 'call',
    silent: true,
    tooltip: { show: false },
    itemStyle: { color: 'transparent' },
    data: rows.map((row) => row.offset),
  };
  const bars = statuses.map((status): BarSeriesOption => ({
    type: 'bar',
    name: STATUS_NAMES[status],
    stack: 'call',
    barMaxWidth: BAR_MAX_WIDTH,
    itemStyle: { color: colors[status], borderRadius: 4 },
    data: rows.map((row) => (row.status === status ? row.seconds : 0)),
  }));
  return {
    animation: false,
    textStyle: textStyle(theme),
    grid: grid(true),
    legend: legend(
      theme,
      statuses.map((status) => STATUS_NAMES[status]),
    ),
    tooltip: { ...tooltip(theme, 'item'), valueFormatter: valueFormatter(seconds) },
    xAxis: valueXAxis(theme, seconds),
    yAxis: categoryYAxis(
      theme,
      rows.map((row) => row.label),
      true,
    ),
    series: [offset, ...bars],
  };
}
