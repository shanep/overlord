// Usage history: totals, daily tokens by model, and activity by hour.

import type { ReactElement } from 'react';
import { useMemo } from 'react';

import type { UsageState } from '../../../src/shared/protocol.js';
import { useChartTheme } from '../charts/chart-theme.js';
import {
  buildDailyUsage,
  buildHourHeatmap,
  dayTokens,
  hourValues,
  modelSeries,
  OTHER,
} from '../charts/usage-charts.js';
import type { FigureTable } from '../components/chart-figure.js';
import { ChartFigure } from '../components/chart-figure.js';
import { formatCompact, formatInteger } from '../format.js';

/** Table twin for the daily chart: one row per day, one column per series. */
export function dailyTable(state: UsageState): FigureTable {
  const days = state.days.toSorted((a, b) => a.date.localeCompare(b.date));
  const series = modelSeries(days);
  const named = series.filter((name) => name !== OTHER);
  return {
    columns: ['Date', ...series],
    rows: days.map((day) => [
      day.date,
      ...series.map((name) => formatInteger(dayTokens(day, name, named))),
    ]),
  };
}

/** Table twin for the heatmap, hours with no activity left out. */
export function hourTable(state: UsageState): FigureTable {
  const values = hourValues(state.hourCounts);
  return {
    columns: ['Hour', 'Count'],
    rows: values.flatMap((value, hour) =>
      value > 0 ? [[`${hour.toString().padStart(2, '0')}:00`, formatInteger(value)]] : [],
    ),
  };
}

export function totalTokensAll(state: UsageState): number {
  return state.days
    .flatMap((day) => Object.values(day.tokensByModel))
    .reduce((sum, tokens) => sum + tokens, 0);
}

function Stat(props: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="stat">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

export function UsageView(props: { readonly state: UsageState }): ReactElement {
  const { state } = props;
  const theme = useChartTheme();
  const daily = useMemo(() => buildDailyUsage(state.days, theme), [state.days, theme]);
  const heatmap = useMemo(
    () => buildHourHeatmap(state.hourCounts, theme),
    [state.hourCounts, theme],
  );
  const toolCalls = state.days.reduce((sum, day) => sum + day.toolCalls, 0);
  return (
    <section aria-labelledby="usage-title">
      <header className="view-header">
        <h1 id="usage-title">Usage</h1>
        <dl className="stats">
          <Stat label="Sessions" value={formatInteger(state.totalSessions)} />
          <Stat label="Messages" value={formatInteger(state.totalMessages)} />
          <Stat label="Tokens" value={formatCompact(totalTokensAll(state))} />
          <Stat label="Tool calls" value={formatInteger(toolCalls)} />
          <Stat label="Days" value={state.days.length.toString()} />
        </dl>
      </header>
      <div className="charts">
        <ChartFigure
          title="Daily tokens by model"
          option={daily}
          height={220}
          table={dailyTable(state)}
        />
        <ChartFigure
          title="Activity by hour of day"
          option={heatmap}
          height={140}
          table={hourTable(state)}
        />
      </div>
    </section>
  );
}
