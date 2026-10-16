// Option builders for per-request charts in the agent view. All pure: the
// same requests and theme always give the same option.

import type { EChartsOption, LineSeriesOption } from 'echarts';

import type { ApiRequest } from '../../../src/shared/model.js';
import { formatCompact, formatPercent, formatUsd } from '../format.js';
import { cacheHitRatio, promptTokens } from '../metrics.js';

import {
  AREA_OPACITY,
  grid,
  legend,
  LINE_WIDTH,
  MARKER_SIZE,
  textStyle,
  timeAxis,
  tooltip,
  valueAxis,
  valueFormatter,
} from './base.js';
import type { ChartTheme } from './chart-theme.js';
import { seriesColor } from './chart-theme.js';

type Point = [number, number];

function byTime(requests: readonly ApiRequest[]): ApiRequest[] {
  return requests.toSorted((a, b) => a.timestamp - b.timestamp);
}

function line(name: string, color: string, data: Point[]): LineSeriesOption {
  return {
    type: 'line',
    name,
    data,
    showSymbol: false,
    symbolSize: MARKER_SIZE,
    lineStyle: { width: LINE_WIDTH, color, cap: 'round', join: 'round' },
    itemStyle: { color },
    emphasis: { focus: 'series' },
  };
}

const TOKEN_SERIES: readonly {
  readonly name: string;
  readonly pick: (request: ApiRequest) => number;
}[] = [
  { name: 'Input', pick: (request) => request.usage.input },
  { name: 'Output', pick: (request) => request.usage.output },
  { name: 'Cache read', pick: (request) => request.usage.cacheRead },
  { name: 'Cache write', pick: (request) => request.usage.cacheCreation },
];

/** Stacked area of tokens per request, split by kind. */
export function buildTokensOverTime(
  requests: readonly ApiRequest[],
  theme: ChartTheme,
): EChartsOption {
  const sorted = byTime(requests);
  return {
    animation: false,
    textStyle: textStyle(theme),
    grid: grid(true),
    legend: legend(
      theme,
      TOKEN_SERIES.map((entry) => entry.name),
    ),
    tooltip: { ...tooltip(theme, 'axis'), valueFormatter: valueFormatter(formatCompact) },
    xAxis: timeAxis(theme),
    yAxis: valueAxis(theme, formatCompact),
    series: TOKEN_SERIES.map((entry, index) => {
      const color = seriesColor(theme, index);
      return {
        ...line(
          entry.name,
          color,
          sorted.map((request): Point => [request.timestamp, entry.pick(request)]),
        ),
        stack: 'tokens',
        areaStyle: { color, opacity: AREA_OPACITY },
      };
    }),
  };
}

/** Running total of estimated cost. One series, so no legend box. */
export function buildCostOverTime(
  requests: readonly ApiRequest[],
  theme: ChartTheme,
): EChartsOption {
  let total = 0;
  const data = byTime(requests).map((request): Point => {
    total += request.costUsd ?? 0;
    return [request.timestamp, total];
  });
  const color = seriesColor(theme, 0);
  return {
    animation: false,
    textStyle: textStyle(theme),
    grid: grid(false),
    tooltip: { ...tooltip(theme, 'axis'), valueFormatter: valueFormatter(formatUsd) },
    xAxis: timeAxis(theme),
    yAxis: valueAxis(theme, formatUsd),
    series: [{ ...line('Cost (est.)', color, data), areaStyle: { color, opacity: AREA_OPACITY } }],
  };
}

export interface ContextFillInput {
  readonly requests: readonly ApiRequest[];
  /** Compaction times, drawn as vertical marks. */
  readonly compactions: readonly number[];
  /** Context window size in tokens, drawn as a limit line when known. */
  readonly windowTokens: number | null;
}

/** Prompt tokens per request, which is how full the context window was. */
export function buildContextFill(input: ContextFillInput, theme: ChartTheme): EChartsOption {
  const color = seriesColor(theme, 0);
  const marks: NonNullable<LineSeriesOption['markLine']>['data'] = input.compactions.map((at) => ({
    xAxis: at,
    name: 'Compacted',
  }));
  if (input.windowTokens !== null) {
    marks.push({ yAxis: input.windowTokens, name: 'Window' });
  }
  return {
    animation: false,
    textStyle: textStyle(theme),
    grid: grid(false),
    tooltip: { ...tooltip(theme, 'axis'), valueFormatter: valueFormatter(formatCompact) },
    xAxis: timeAxis(theme),
    yAxis: valueAxis(theme, formatCompact),
    series: [
      {
        ...line(
          'Context tokens',
          color,
          byTime(input.requests).map((request): Point => [
            request.timestamp,
            promptTokens(request.usage),
          ]),
        ),
        areaStyle: { color, opacity: AREA_OPACITY },
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: theme.muted, width: 1, type: 'solid' },
          label: { color: theme.muted, formatter: '{b}', fontSize: 10 },
          data: marks,
        },
      },
    ],
  };
}

/** Share of prompt tokens read from cache, per request. */
export function buildCacheHitRatio(
  requests: readonly ApiRequest[],
  theme: ChartTheme,
): EChartsOption {
  const data: Point[] = [];
  for (const request of byTime(requests)) {
    const ratio = cacheHitRatio(request.usage);
    if (ratio !== null) {
      data.push([request.timestamp, ratio]);
    }
  }
  return {
    animation: false,
    textStyle: textStyle(theme),
    grid: grid(false),
    tooltip: { ...tooltip(theme, 'axis'), valueFormatter: valueFormatter(formatPercent) },
    xAxis: timeAxis(theme),
    yAxis: valueAxis(theme, formatPercent, { min: 0, max: 1 }),
    series: [{ ...line('Cache hit ratio', seriesColor(theme, 0), data), showSymbol: true }],
  };
}
