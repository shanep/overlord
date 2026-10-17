// The graph of messages between sessions: one node per session, sized by how
// many messages pass through it, and one arrow per route, thicker for more
// messages. The sessions sit on a ring, busiest at the top, with each label on
// the outside of its node, so labels never pile up the way a force layout
// piles them. Subagent traffic stays out, since it only runs between a session
// and its own agents and would draw a star around every session. The figure's
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

/** Room beside the ring for labels of LABEL_CHARS characters at 11 px. */
const LABEL_ROOM = 180;
/** Nodes this close to straight up or down get their label above or below instead. */
const SIDEWAYS = 0.35;

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

export type LabelSide = 'top' | 'bottom' | 'left' | 'right';

export interface RingPlace {
  readonly x: number;
  readonly y: number;
  readonly side: LabelSide;
}

/**
 * Where the node at index sits on a ring of count nodes, starting straight up
 * and going clockwise, and which side of the node its label goes on: always
 * away from the middle.
 */
export function ringPlace(index: number, count: number): RingPlace {
  if (count <= 1) {
    return { x: 0, y: 0, side: 'right' };
  }
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
  const x = Math.round(Math.cos(angle) * 1000) / 10;
  const y = Math.round(Math.sin(angle) * 1000) / 10;
  if (Math.abs(x) < SIDEWAYS * 100) {
    return { x, y, side: y < 0 ? 'top' : 'bottom' };
  }
  return { x, y, side: x > 0 ? 'right' : 'left' };
}

function plural(count: number): string {
  return `${formatInteger(count)} ${count === 1 ? 'message' : 'messages'}`;
}

export function buildRouteGraph(
  allRoutes: readonly MessageRoute[],
  theme: ChartTheme,
): EChartsOption {
  const routes = graphRoutes(allRoutes);
  const nodes = graphNodes(routes).toSorted((left, right) => right.traffic - left.traffic);
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
        layout: 'none',
        // Without this a wide panel stretches the ring, and the nodes with it, into ovals.
        preserveAspect: 'contain',
        // Room for the labels, which sit outside the ring.
        top: 40,
        bottom: 40,
        left: LABEL_ROOM,
        right: LABEL_ROOM,
        roam: true,
        draggable: true,
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: [0, 7],
        label: { show: true, position: 'right', ...text },
        edgeLabel: { show: true, ...text, color: theme.muted, formatter: '{c}' },
        itemStyle: { color: seriesColor(theme, 0), borderColor: theme.surface, borderWidth: 2 },
        lineStyle: { color: theme.muted, opacity: 0.7, curveness: 0.15 },
        emphasis: { focus: 'adjacency' },
        data: nodes.map((node, index) => {
          const place = ringPlace(index, nodes.length);
          return {
            id: node.name,
            name: nodeLabel(node.name),
            value: node.traffic,
            x: place.x,
            y: place.y,
            symbolSize: nodeSize(node.traffic, busiest),
            label: { position: place.side },
            tooltip: { formatter: `${node.name}: ${plural(node.traffic)}` },
          };
        }),
        links: routes.map((route) => ({
          source: route.from,
          target: route.to,
          value: route.count,
          lineStyle: { width: 1 + (3 * route.count) / Math.max(heaviest, 1) },
          // A 1 on every arrow is noise; the line width, tooltip and table still say it.
          label: { show: route.count > 1 },
          tooltip: { formatter: `${route.from} to ${route.to}: ${plural(route.count)}` },
        })),
      },
    ],
  };
}
