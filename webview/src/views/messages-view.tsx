// Agent messages: who sends messages to whom (subagents, the main
// conversation, other sessions), a log of them, and the controls that decide
// which get through.

import { GraphChart } from 'echarts/charts';
import { use as registerParts } from 'echarts/core';
import type { ReactElement } from 'react';
import { useMemo } from 'react';

import type { MessageRoute, MessagesState } from '../../../src/shared/protocol.js';
import { useChartTheme } from '../charts/chart-theme.js';
import type { FigureTable } from '../components/chart-figure.js';
import { ChartFigure } from '../components/chart-figure.js';
import { formatDateTime, formatInteger } from '../format.js';

import { buildRouteGraph, MAX_GRAPH_ROUTES } from './messages-graph.js';
import { InboundPolicy } from './messages-inbound.js';
import { MessageLog } from './messages-log.js';
import { BlockRules } from './messages-rules.js';

// The shared chart wrapper does not register the graph series; ECharts keeps
// registrations global, so doing it here is enough.
registerParts([GraphChart]);

export function routeTable(routes: readonly MessageRoute[]): FigureTable {
  return {
    columns: ['From', 'To', 'Messages', 'Last'],
    rows: routes.map((route) => [
      route.from,
      route.to,
      formatInteger(route.count),
      route.lastAt === 0 ? 'unknown' : formatDateTime(route.lastAt),
    ]),
  };
}

export function graphTitle(routes: readonly MessageRoute[]): string {
  return routes.length > MAX_GRAPH_ROUTES
    ? `Message routes (busiest ${String(MAX_GRAPH_ROUTES)} of ${String(routes.length)})`
    : 'Message routes';
}

function Stat(props: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="stat">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

export function MessagesView(props: { readonly state: MessagesState }): ReactElement {
  const { state } = props;
  const theme = useChartTheme();
  const graph = useMemo(() => buildRouteGraph(state.routes, theme), [state.routes, theme]);
  const blocked = state.messages.filter((message) => message.blocked).length;
  return (
    <section aria-labelledby="messages-title">
      <header className="view-header">
        <h1 id="messages-title">Agent messages</h1>
        <dl className="stats">
          <Stat label="Messages" value={formatInteger(state.messages.length)} />
          <Stat label="Routes" value={formatInteger(state.routes.length)} />
          <Stat label="Blocked" value={formatInteger(blocked)} />
        </dl>
      </header>
      <div className="charts">
        <ChartFigure
          title={graphTitle(state.routes)}
          option={graph}
          height={360}
          table={routeTable(state.routes)}
        />
      </div>
      <MessageLog messages={state.messages} />
      <InboundPolicy
        key={state.inboundPolicy ?? ''}
        policy={state.inboundPolicy}
        choices={state.inboundChoices}
      />
      <BlockRules rules={state.rules} />
    </section>
  );
}
