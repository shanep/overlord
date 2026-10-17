// The graph of messages between sessions: one node per session, sized by how
// many messages pass through it, and one arrow per route labeled with its
// count. Subagent traffic stays out, since it only runs between a session and
// its own agents and would draw a star around every session. The figure's
// table twin lists every route.

import type { EChartsOption } from 'echarts';

import type { MessageRoute } from '../../../src/shared/protocol.js';
import { tooltip } from '../charts/base.js';
import type { ChartTheme } from '../charts/chart-theme.js';
import { seriesColor } from '../charts/chart-theme.js';
import { formatInteger } from '../format.js';

/** The busiest routes drawn; the table still lists every one. */
export const MAX_GRAPH_ROUTES = 40;

/** Session titles can be a whole prompt, so node labels stop here. */
export const LABEL_CHARS = 28;

const MIN_HEIGHT = 200;
const MAX_HEIGHT = 480;
const HEIGHT_PER_NODE = 24;

const MIN_NODE = 12;
const MAX_NODE = 40;

export interface GraphNode {
  readonly name: string;
  /** Messages in and out. */
  readonly traffic: number;
}

export function nodeLabel(name: string): string {
  return name.length > LABEL_CHARS ? `${name.slice(0, LABEL_CHARS - 1)}…` : name;
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
  return [...traffic.entries()].map(([name, count]) => ({ name, traffic: count }));
}

/** Taller for more sessions, so a pair does not float in a big empty box. */
export function graphHeight(routes: readonly MessageRoute[]): number {
  return Math.min(
    MAX_HEIGHT,
    MIN_HEIGHT + HEIGHT_PER_NODE * graphNodes(graphRoutes(routes)).length,
  );
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
    series: [
      {
        type: 'graph',
        name: 'Messages between sessions',
        layout: 'force',
        force: { repulsion: 260, edgeLength: [70, 150], gravity: 0.12, layoutAnimation: false },
        // Room for the labels, which sit to the right of each node.
        top: 24,
        bottom: 24,
        left: 24,
        right: 160,
        roam: true,
        draggable: true,
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: [0, 7],
        label: { show: true, position: 'right', ...text },
        edgeLabel: { show: true, ...text, color: theme.muted, formatter: '{c}' },
        itemStyle: { color: seriesColor(theme, 0), borderColor: theme.surface, borderWidth: 2 },
        lineStyle: { color: theme.muted, opacity: 0.7, curveness: 0.15 },
        emphasis: { focus: 'adjacency' },
        data: nodes.map((node) => ({
          id: node.name,
          name: nodeLabel(node.name),
          value: node.traffic,
          symbolSize: nodeSize(node.traffic, busiest),
          tooltip: { formatter: `${node.name}: ${plural(node.traffic)}` },
        })),
        links: routes.map((route) => ({
          source: route.from,
          target: route.to,
          value: route.count,
          lineStyle: { width: 1 + (3 * route.count) / Math.max(heaviest, 1) },
          tooltip: { formatter: `${route.from} to ${route.to}: ${plural(route.count)}` },
        })),
      },
    ],
  };
}
