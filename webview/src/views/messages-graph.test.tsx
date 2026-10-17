import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { MessageRoute } from '../../../src/shared/protocol.js';
import { readChartTheme } from '../charts/chart-theme.js';
import { EChart } from '../charts/chart.js';

import {
  buildRouteGraph,
  graphHeight,
  graphNodes,
  graphRoutes,
  LABEL_CHARS,
  MAX_GRAPH_ROUTES,
  nodeLabel,
  nodeSize,
  ringPlace,
} from './messages-graph.js';
// Registers the graph series with ECharts.
import './messages-view.js';

const theme = readChartTheme(document.createElement('div'));
const LONG = 'Fix the flaky login test on the build box';

const routes: readonly MessageRoute[] = [
  { from: 'Release prep', to: 'Docs pass', count: 4, lastAt: 10 },
  { from: 'Docs pass', to: 'Release prep', count: 1, lastAt: 11 },
  { from: 'Release prep', to: LONG, count: 2, lastAt: 12 },
];

describe('node labels', () => {
  it('cuts a long session title short', () => {
    expect(LABEL_CHARS).toBe(28);
    expect(nodeLabel('Docs pass')).toBe('Docs pass');
    expect(nodeLabel('x'.repeat(LABEL_CHARS))).toBe('x'.repeat(LABEL_CHARS));
    expect(nodeLabel(LONG)).toBe('Fix the flaky login test on…');
  });
});

describe('graph data', () => {
  it('keeps the busiest routes only', () => {
    const many = Array.from({ length: MAX_GRAPH_ROUTES + 5 }, (_, index) => ({
      from: 'hub',
      to: `peer-${String(index)}`,
      count: index,
      lastAt: 0,
    }));
    const kept = graphRoutes(many);
    expect(MAX_GRAPH_ROUTES).toBe(40);
    expect(kept).toHaveLength(MAX_GRAPH_ROUTES);
    expect(kept[0]?.count).toBe(MAX_GRAPH_ROUTES + 4);
    expect(kept.at(-1)?.count).toBe(5);
  });

  it('adds up traffic in and out of each session', () => {
    expect(graphNodes(routes)).toStrictEqual([
      { name: 'Release prep', traffic: 7 },
      { name: 'Docs pass', traffic: 5 },
      { name: LONG, traffic: 2 },
    ]);
  });

  it('grows the graph with its sessions, up to a limit', () => {
    expect(graphHeight([])).toBe(200);
    expect(graphHeight(routes)).toBe(272);
    const many = Array.from({ length: 30 }, (_, index) => ({
      from: 'hub',
      to: String(index),
      count: 1,
      lastAt: 0,
    }));
    expect(graphHeight(many)).toBe(480);
  });

  it('sizes nodes by the square root of traffic', () => {
    expect(nodeSize(0, 0)).toBe(12);
    expect(nodeSize(9, 9)).toBe(40);
    expect(nodeSize(1, 4)).toBe(26);
  });
});

describe('buildRouteGraph', () => {
  it('draws one node per session and one arrow per route, counted when more than one', () => {
    const option = buildRouteGraph(routes, theme);
    expect(option).not.toHaveProperty('legend');
    expect(option).toMatchObject({
      animation: false,
      series: [
        {
          type: 'graph',
          name: 'Messages between sessions',
          layout: 'none',
          edgeSymbol: ['none', 'arrow'],
          edgeLabel: { show: true, formatter: '{c}', color: theme.muted },
          label: { show: true, color: theme.foreground },
          itemStyle: { color: theme.series[0], borderColor: theme.surface, borderWidth: 2 },
          data: [
            {
              id: 'Release prep',
              name: 'Release prep',
              value: 7,
              symbolSize: 40,
              x: 0,
              y: -100,
              label: { position: 'top' },
              tooltip: { formatter: 'Release prep: 7 messages' },
            },
            { id: 'Docs pass', name: 'Docs pass', value: 5, label: { position: 'right' } },
            {
              id: LONG,
              name: 'Fix the flaky login test on…',
              tooltip: { formatter: `${LONG}: 2 messages` },
            },
          ],
          links: [
            {
              source: 'Release prep',
              target: 'Docs pass',
              value: 4,
              lineStyle: { width: 4 },
              label: { show: true },
              tooltip: { formatter: 'Release prep to Docs pass: 4 messages' },
            },
            { source: 'Release prep', target: LONG, value: 2, lineStyle: { width: 2.5 } },
            {
              source: 'Docs pass',
              target: 'Release prep',
              value: 1,
              label: { show: false },
              tooltip: { formatter: 'Docs pass to Release prep: 1 message' },
            },
          ],
        },
      ],
    });
  });

  it('puts sessions on a ring with each label on the outside', () => {
    expect(ringPlace(0, 1)).toStrictEqual({ x: 0, y: 0, side: 'right' });
    expect(ringPlace(0, 2)).toStrictEqual({ x: 0, y: -100, side: 'top' });
    expect(ringPlace(1, 2)).toMatchObject({ y: 100, side: 'bottom' });
    expect(ringPlace(1, 4)).toMatchObject({ x: 100, side: 'right' });
    expect(ringPlace(3, 4)).toMatchObject({ x: -100, side: 'left' });
    expect(ringPlace(1, 6).side).toBe('right');
    expect(ringPlace(4, 6).side).toBe('left');
  });

  it('handles no routes', () => {
    expect(buildRouteGraph([], theme)).toMatchObject({ series: [{ data: [], links: [] }] });
  });

  it('renders node labels', () => {
    const { container } = render(
      <EChart option={buildRouteGraph(routes, theme)} label="Sessions" height={300} width={500} />,
    );
    expect(container.textContent).toContain('Docs pass');
    // Edge labels only render when the links resolve to node ids.
    expect(container.textContent).toContain('Fix the flaky login test on…42');
    expect(container.textContent).not.toContain('421');
  });
});
