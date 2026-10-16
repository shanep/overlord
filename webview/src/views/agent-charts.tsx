// Charts for one agent: tool call timeline, tokens, cost, context fill and
// cache hit ratio. Each one has a table twin.

import type { ReactElement } from 'react';
import { useMemo } from 'react';

import type { ApiRequest, ToolCall } from '../../../src/shared/model.js';
import type { ChartTheme } from '../charts/chart-theme.js';
import { useChartTheme } from '../charts/chart-theme.js';
import {
  buildCacheHitRatio,
  buildContextFill,
  buildCostOverTime,
  buildTokensOverTime,
} from '../charts/time-series.js';
import type { TimelineRow } from '../charts/tool-timeline.js';
import { buildToolTimeline, timelineRows } from '../charts/tool-timeline.js';
import { useNow } from '../clock.js';
import type { FigureTable } from '../components/chart-figure.js';
import { ChartFigure } from '../components/chart-figure.js';
import { formatClock, formatCompact, formatCost, formatPercent } from '../format.js';
import { cacheHitRatio, promptTokens } from '../metrics.js';

/** Calls shown on the timeline, newest kept. */
const TIMELINE_LIMIT = 60;

/** Context window size for a model id, when we can tell. */
export function windowForModel(model: string | null): number | null {
  if (model === null) {
    return null;
  }
  return model.includes('[1m]') ? 1_000_000 : 200_000;
}

function byTime(requests: readonly ApiRequest[]): readonly ApiRequest[] {
  return requests.toSorted((a, b) => a.timestamp - b.timestamp);
}

function timelineTable(rows: readonly TimelineRow[]): FigureTable {
  return {
    columns: ['Call', 'Status', 'Start (s)', 'Seconds'],
    rows: rows.map((row) => [row.label, row.status, row.offset.toFixed(1), row.seconds.toFixed(1)]),
  };
}

export function tokensTable(requests: readonly ApiRequest[]): FigureTable {
  return {
    columns: ['Time', 'Input', 'Output', 'Cache read', 'Cache write'],
    rows: byTime(requests).map((request) => [
      formatClock(request.timestamp),
      formatCompact(request.usage.input),
      formatCompact(request.usage.output),
      formatCompact(request.usage.cacheRead),
      formatCompact(request.usage.cacheCreation),
    ]),
  };
}

export function costTable(requests: readonly ApiRequest[]): FigureTable {
  return {
    columns: ['Time', 'Cost'],
    rows: byTime(requests).map((request) => [
      formatClock(request.timestamp),
      formatCost(request.costUsd),
    ]),
  };
}

export function contextTable(requests: readonly ApiRequest[]): FigureTable {
  return {
    columns: ['Time', 'Context tokens'],
    rows: byTime(requests).map((request) => [
      formatClock(request.timestamp),
      formatCompact(promptTokens(request.usage)),
    ]),
  };
}

export function cacheTable(requests: readonly ApiRequest[]): FigureTable {
  return {
    columns: ['Time', 'Hit ratio'],
    rows: byTime(requests).map((request) => [
      formatClock(request.timestamp),
      formatPercent(cacheHitRatio(request.usage)),
    ]),
  };
}

function RequestCharts(props: {
  readonly requests: readonly ApiRequest[];
  readonly compactions: readonly number[];
  readonly model: string | null;
  readonly theme: ChartTheme;
}): ReactElement {
  const { requests, compactions, model, theme } = props;
  const options = useMemo(
    () => ({
      tokens: buildTokensOverTime(requests, theme),
      cost: buildCostOverTime(requests, theme),
      context: buildContextFill(
        { requests, compactions, windowTokens: windowForModel(model) },
        theme,
      ),
      cache: buildCacheHitRatio(requests, theme),
    }),
    [requests, compactions, model, theme],
  );
  return (
    <>
      <ChartFigure
        title="Tokens per request"
        option={options.tokens}
        height={180}
        table={tokensTable(requests)}
      />
      <ChartFigure
        title="Cost over time (est.)"
        option={options.cost}
        height={180}
        table={costTable(requests)}
      />
      <ChartFigure
        title="Context window fill"
        option={options.context}
        height={180}
        table={contextTable(requests)}
      />
      <ChartFigure
        title="Cache hit ratio"
        option={options.cache}
        height={180}
        table={cacheTable(requests)}
      />
    </>
  );
}

export function AgentCharts(props: {
  readonly toolCalls: readonly ToolCall[];
  readonly requests: readonly ApiRequest[];
  readonly compactions: readonly number[];
  readonly model: string | null;
}): ReactElement {
  const { toolCalls, requests, compactions, model } = props;
  const theme = useChartTheme();
  const now = useNow();
  const rows = useMemo(() => timelineRows(toolCalls, now, TIMELINE_LIMIT), [toolCalls, now]);
  const timeline = useMemo(() => buildToolTimeline(rows, theme), [rows, theme]);
  return (
    <div className="charts">
      <ChartFigure
        title="Tool call timeline"
        option={timeline}
        height={Math.max(120, 40 + rows.length * 16)}
        table={timelineTable(rows)}
      />
      <RequestCharts requests={requests} compactions={compactions} model={model} theme={theme} />
    </div>
  );
}
