import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { MessageRoute } from '../../../src/shared/protocol.js';
import { readChartTheme } from '../charts/chart-theme.js';
import { EChart } from '../charts/chart.js';

import {
  buildRouteGraph,
  graphNodes,
  graphRoutes,
  MAX_GRAPH_ROUTES,
  nodeSize,
  PARTY_LABELS,
  partyKind,
  shortName,
} from './messages-graph.js';
// Registers the graph series with ECharts.
import './messages-view.js';

const theme = readChartTheme(document.createElement('div'));
const AGENT = 'a0123456789abcdef';

const routes: readonly MessageRoute[] = [
  { from: 'main', to: AGENT, count: 4, lastAt: 10 },
  { from: AGENT, to: 'main', count: 1, lastAt: 11 },
  { from: 'main', to: 'uds:/tmp/cc-socks/4242.sock', count: 2, lastAt: 12 },
];

describe('party names', () => {
  it('sorts names into main, agent ids and everything else', () => {
    expect(partyKind('main')).toBe('main');
    expect(partyKind(AGENT)).toBe('agent');
    expect(partyKind('a0123')).toBe('other');
    expect(partyKind('wt-apps-d3')).toBe('other');
    expect(PARTY_LABELS).toStrictEqual({
      main: 'Main conversation',
      agent: 'Subagent',
      other: 'Session or named agent',
    });
  });

  it('shortens agent ids and socket addresses', () => {
    expect(shortName(AGENT)).toBe('a0123456');
    expect(shortName('uds:/tmp/cc-socks/4242.sock')).toBe('session 4242');
    expect(shortName('uds:pipe')).toBe('session uds:pipe');
    expect(shortName('helper')).toBe('helper');
  });
});

describe('graph data', () => {
  it('keeps the busiest routes only', () => {
    const many = Array.from({ length: MAX_GRAPH_ROUTES + 5 }, (_, index) => ({
      from: 'main',
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

  it('adds up traffic in and out of each node', () => {
    expect(graphNodes(routes)).toStrictEqual([
      { name: 'main', kind: 'main', traffic: 7 },
      { name: AGENT, kind: 'agent', traffic: 5 },
      { name: 'uds:/tmp/cc-socks/4242.sock', kind: 'other', traffic: 2 },
    ]);
  });

  it('sizes nodes by the square root of traffic', () => {
    expect(nodeSize(0, 0)).toBe(12);
    expect(nodeSize(9, 9)).toBe(40);
    expect(nodeSize(1, 4)).toBe(26);
  });
});

describe('buildRouteGraph', () => {
  it('draws one colored node per party and one labeled arrow per route', () => {
    const option = buildRouteGraph(routes, theme);
    expect(option).toMatchObject({
      animation: false,
      legend: { data: ['Main conversation', 'Subagent', 'Session or named agent'] },
      series: [
        {
          type: 'graph',
          layout: 'force',
          edgeSymbol: ['none', 'arrow'],
          edgeLabel: { show: true, formatter: '{c}', color: theme.muted },
          label: { show: true, color: theme.foreground },
          itemStyle: { borderColor: theme.surface, borderWidth: 2 },
          categories: [
            { name: 'Main conversation', itemStyle: { color: theme.series[0] } },
            { name: 'Subagent', itemStyle: { color: theme.series[1] } },
            { name: 'Session or named agent', itemStyle: { color: theme.series[2] } },
          ],
          data: [
            {
              id: 'main',
              name: 'main',
              value: 7,
              category: 0,
              symbolSize: 40,
              tooltip: { formatter: 'main: 7 messages' },
            },
            { id: AGENT, name: 'a0123456', value: 5, category: 1 },
            {
              id: 'uds:/tmp/cc-socks/4242.sock',
              name: 'session 4242',
              category: 2,
              tooltip: { formatter: 'uds:/tmp/cc-socks/4242.sock: 2 messages' },
            },
          ],
          links: [
            {
              source: 'main',
              target: AGENT,
              value: 4,
              lineStyle: { width: 4 },
              tooltip: { formatter: 'main to a0123456: 4 messages' },
            },
            {
              source: 'main',
              target: 'uds:/tmp/cc-socks/4242.sock',
              value: 2,
              lineStyle: { width: 2.5 },
            },
            {
              source: AGENT,
              target: 'main',
              value: 1,
              tooltip: { formatter: 'a0123456 to main: 1 message' },
            },
          ],
        },
      ],
    });
  });

  it('handles no routes', () => {
    expect(buildRouteGraph([], theme)).toMatchObject({ series: [{ data: [], links: [] }] });
  });

  it('renders node labels', () => {
    const { container } = render(
      <EChart option={buildRouteGraph(routes, theme)} label="Routes" height={300} width={500} />,
    );
    expect(container.textContent).toContain('session 4242');
    // Edge labels only render when the links resolve to node ids.
    expect(container.textContent).toContain('session 4242421Main conversation');
  });
});
