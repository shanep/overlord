// The route graph: one node per agent or session, sized by how many messages
// pass through it, and one arrow per route labeled with its count. Node color
// says what kind of party it is, in fixed slot order with a legend, and the
// figure's table twin lists every route.

import type { EChartsOption } from 'echarts';

import type { MessageRoute } from '../../../src/shared/protocol.js';
import { tooltip } from '../charts/base.js';
import type { ChartTheme } from '../charts/chart-theme.js';
import { seriesColor } from '../charts/chart-theme.js';
import { formatInteger } from '../format.js';

/** The busiest routes drawn; the table still lists every one. */
export const MAX_GRAPH_ROUTES = 40;

export type PartyKind = 'main' | 'agent' | 'other';

export const PARTY_LABELS: Readonly<Record<PartyKind, string>> = {
  main: 'Main conversation',
  agent: 'Subagent',
  other: 'Session or named agent',
};

const PARTY_ORDER: readonly PartyKind[] = ['main', 'agent', 'other'];

const AGENT_ID = /^a[0-9a-f]{15,}$/u;
const SOCKET_PREFIX = 'uds:';

const MIN_NODE = 12;
const MAX_NODE = 40;

export interface GraphNode {
  readonly name: string;
  readonly kind: PartyKind;
  /** Messages in and out. */
  readonly traffic: number;
}

export function partyKind(name: string): PartyKind {
  if (name === 'main') {
    return 'main';
  }
  return AGENT_ID.test(name) ? 'agent' : 'other';
}

/** A short label: agent ids cut to 8 characters, socket addresses to their pid. */
export function shortName(name: string): string {
  if (name.startsWith(SOCKET_PREFIX)) {
    return `session ${name.slice(name.lastIndexOf('/') + 1).replace(/\.sock$/u, '')}`;
  }
  return partyKind(name) === 'agent' ? name.slice(0, 8) : name;
}

/** The routes worth drawing: the busiest ones, at most MAX_GRAPH_ROUTES. */
export function graphRoutes(routes: readonly MessageRoute[]): readonly MessageRoute[] {
  return routes.toSorted((left, right) => right.count - left.count).slice(0, MAX_GRAPH_ROUTES);
}

export function graphNodes(routes: readonly MessageRoute[]): readonly GraphNode[] {
  const traffic = new Map<string, number>();
  for (const route of routes) {
    traffic.set(route.from, (traffic.get(route.from) ?? 0) + route.count);
    traffic.set(route.to, (traffic.get(route.to) ?? 0) + route.count);
  }
  return [...traffic.entries()].map(([name, count]) => ({
    name,
    kind: partyKind(name),
    traffic: count,
  }));
}

export function nodeSize(traffic: number, busiest: number): number {
  return MIN_NODE + (MAX_NODE - MIN_NODE) * Math.sqrt(traffic / Math.max(busiest, 1));
}

function plural(count: number): string {
  return `${formatInteger(count)} ${count === 1 ? 'message' : 'messages'}`;
}

export function buildRouteGraph(
  allRoutes: readonly MessageRoute[],
  theme: ChartTheme,
): EChartsOption {
  const routes = graphRoutes(allRoutes);
  const nodes = graphNodes(routes);
  const busiest = Math.max(0, ...nodes.map((node) => node.traffic));
  const heaviest = Math.max(0, ...routes.map((route) => route.count));
  const text = { color: theme.foreground, fontFamily: theme.fontFamily, fontSize: 11 };
  return {
    animation: false,
    tooltip: tooltip(theme, 'item'),
    legend: {
      data: PARTY_ORDER.map((kind) => PARTY_LABELS[kind]),
      top: 0,
      left: 0,
      itemWidth: 12,
      itemHeight: 8,
      textStyle: text,
    },
    series: [
      {
        type: 'graph',
        name: 'Routes',
        layout: 'force',
        force: { repulsion: 220, edgeLength: [70, 150], gravity: 0.08, layoutAnimation: false },
        top: 32,
        roam: true,
        draggable: true,
        categories: PARTY_ORDER.map((kind, index) => ({
          name: PARTY_LABELS[kind],
          itemStyle: { color: seriesColor(theme, index) },
        })),
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: [0, 7],
        label: { show: true, position: 'right', ...text },
        edgeLabel: { show: true, ...text, color: theme.muted, formatter: '{c}' },
        itemStyle: { borderColor: theme.surface, borderWidth: 2 },
        lineStyle: { color: theme.muted, opacity: 0.7, curveness: 0.15 },
        emphasis: { focus: 'adjacency' },
        data: nodes.map((node) => ({
          id: node.name,
          name: shortName(node.name),
          value: node.traffic,
          category: PARTY_ORDER.indexOf(node.kind),
          symbolSize: nodeSize(node.traffic, busiest),
          tooltip: { formatter: `${node.name}: ${plural(node.traffic)}` },
        })),
        links: routes.map((route) => ({
          source: route.from,
          target: route.to,
          value: route.count,
          lineStyle: { width: 1 + (3 * route.count) / Math.max(heaviest, 1) },
          tooltip: {
            formatter: `${shortName(route.from)} to ${shortName(route.to)}: ${plural(route.count)}`,
          },
        })),
      },
    ],
  };
}
