// The graph of messages between sessions: one node per session, sized by how
// many messages pass through it, and one arrow per route, thicker for more
// messages. The sessions sit still on a ring with each label on the outside of
// its node, so labels never pile up the way a force layout piles them.
// Sessions that talk to each other sit together, with a gap before the next
// group, so arrows stay short instead of crossing the whole ring. Subagent traffic stays out, since it only runs between a session
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
  // Only the node nearest straight up or down labels above or below; two
  // neighbors doing it put their labels on top of each other.
  if (Math.abs(x) < 50 * Math.sin(Math.PI / count)) {
    return { x, y, side: y < 0 ? 'top' : 'bottom' };
  }
  return { x, y, side: x > 0 ? 'right' : 'left' };
}

function neighborsOf(routes: readonly MessageRoute[]): Map<string, Map<string, number>> {
  const neighbors = new Map<string, Map<string, number>>();
  const add = (from: string, to: string, count: number): void => {
    const around = neighbors.get(from) ?? new Map<string, number>();
    around.set(to, (around.get(to) ?? 0) + count);
    neighbors.set(from, around);
  };
  for (const route of routes) {
    add(route.from, route.to, route.count);
    add(route.to, route.from, route.count);
  }
  return neighbors;
}

/**
 * The ring, in order: each group of sessions that talk to each other, the
 * busiest group first, and null for the gap after each group when there is
 * more than one. A group starts at its busiest session and takes in the rest
 * by who it talks to most, so close partners sit side by side.
 */
export function ringSlots(routes: readonly MessageRoute[]): readonly (GraphNode | null)[] {
  const nodes = graphNodes(routes).toSorted((left, right) => right.traffic - left.traffic);
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const neighbors = neighborsOf(routes);
  const placed = new Set<string>();
  const groups: GraphNode[][] = [];
  for (const start of nodes) {
    if (placed.has(start.name)) {
      continue;
    }
    placed.add(start.name);
    const group: GraphNode[] = [];
    const queue = [start];
    for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
      group.push(node);
      const next = [...(neighbors.get(node.name) ?? new Map<string, number>()).entries()]
        .filter(([name]) => !placed.has(name))
        .toSorted((left, right) => right[1] - left[1]);
      for (const [name] of next) {
        const neighbor = byName.get(name);
        if (neighbor !== undefined) {
          placed.add(name);
          queue.push(neighbor);
        }
      }
    }
    groups.push(group);
  }
  const total = (group: readonly GraphNode[]): number =>
    group.reduce((sum, node) => sum + node.traffic, 0);
  const ordered = groups.toSorted((left, right) => total(right) - total(left));
  return ordered.length === 1 ? ordered.flat() : ordered.flatMap((group) => [...group, null]);
}

function plural(count: number): string {
  return `${formatInteger(count)} ${count === 1 ? 'message' : 'messages'}`;
}

export function buildRouteGraph(
  allRoutes: readonly MessageRoute[],
  theme: ChartTheme,
): EChartsOption {
  const routes = graphRoutes(allRoutes);
  const slots = ringSlots(routes);
  const nodes = slots.filter((node) => node !== null);
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
        // A graph that moves under the mouse is hard to read, so it holds still.
        roam: false,
        draggable: false,
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: [0, 7],
        label: { show: true, position: 'right', ...text },
        edgeLabel: { show: true, ...text, color: theme.muted, formatter: '{c}' },
        itemStyle: { color: seriesColor(theme, 0), borderColor: theme.surface, borderWidth: 2 },
        lineStyle: { color: theme.muted, opacity: 0.7, curveness: 0.15 },
        emphasis: { focus: 'adjacency' },
        data: slots.flatMap((node, index) => {
          if (node === null) {
            return [];
          }
          const place = ringPlace(index, slots.length);
          return [
            {
              id: node.name,
              name: nodeLabel(node.name),
              value: node.traffic,
              x: place.x,
              y: place.y,
              symbolSize: nodeSize(node.traffic, busiest),
              label: { position: place.side },
              tooltip: { formatter: `${node.name}: ${plural(node.traffic)}` },
            },
          ];
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
