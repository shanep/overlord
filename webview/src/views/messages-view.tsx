// Agent messages: what each session and its subagents said to each other,
// grouped by session, a graph of the messages between sessions, and the
// controls that decide which get through.

import { GraphChart } from 'echarts/charts';
import { use as registerParts } from 'echarts/core';
import type { ReactElement } from 'react';
import { useMemo } from 'react';

import type { MessageRoute, MessagesState } from '../../../src/shared/protocol.js';
import { useChartTheme } from '../charts/chart-theme.js';
import type { FigureTable } from '../components/chart-figure.js';
import { ChartFigure } from '../components/chart-figure.js';
import { formatDateTime, formatInteger } from '../format.js';

import { buildRouteGraph, graphHeight, MAX_GRAPH_ROUTES } from './messages-graph.js';
import { InboundPolicy } from './messages-inbound.js';
import { MessageLog } from './messages-log.js';
import { BlockRules } from './messages-rules.js';

// The shared chart wrapper does not register the graph series; ECharts keeps
// registrations global, so doing it here is enough.
registerParts([GraphChart]);

export function routeTable(routes: readonly MessageRoute[]): FigureTable {
  return {
    columns: ['From session', 'To session', 'Messages', 'Last'],
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
    ? `Messages between sessions (busiest ${String(MAX_GRAPH_ROUTES)} of ${String(routes.length)})`
    : 'Messages between sessions';
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
  const sessions = new Set(state.messages.map((message) => message.sessionId)).size;
  const between = state.routes.reduce((sum, route) => sum + route.count, 0);
  return (
    <section aria-labelledby="messages-title">
      <header className="view-header">
        <h1 id="messages-title">Agent messages</h1>
        <dl className="stats">
          <Stat label="Messages" value={formatInteger(state.messages.length)} />
          <Stat label="Sessions" value={formatInteger(sessions)} />
          <Stat label="Between sessions" value={formatInteger(between)} />
          <Stat label="Blocked" value={formatInteger(blocked)} />
        </dl>
      </header>
      <details className="about">
        <summary>How this works</summary>
        <p>
          These are the messages your sessions and their subagents sent each other, read from the
          transcripts. The report a subagent sends back to the conversation that started it counts
          as a message, and so does a status update such as an agent failing. Agents go by the
          description they were started with and sessions by their title. The graph shows only the
          messages one session sent another, since every subagent talks to its own session.
        </p>
      </details>
      {state.routes.length === 0 ? null : (
        <div className="charts">
          <ChartFigure
            title={graphTitle(state.routes)}
            option={graph}
            height={graphHeight(state.routes)}
            table={routeTable(state.routes)}
          />
        </div>
      )}
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
