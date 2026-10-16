// Treemap of token weight per piece of context. One series, so every tile
// wears slot one, with surface gaps between tiles and labels on the tiles.

import type { EChartsOption } from 'echarts';

import { formatCompact } from '../format.js';

import { tooltip, valueFormatter } from './base.js';
import type { ChartTheme } from './chart-theme.js';
import { seriesColor } from './chart-theme.js';

export interface WeightEntry {
  readonly label: string;
  readonly tokens: number;
  readonly estimated: boolean;
}

export function weightLabel(entry: WeightEntry): string {
  return `${entry.label}${entry.estimated ? ' (est.)' : ''}`;
}

export function buildContextTreemap(
  weights: readonly WeightEntry[],
  theme: ChartTheme,
): EChartsOption {
  return {
    animation: false,
    tooltip: { ...tooltip(theme, 'item'), valueFormatter: valueFormatter(formatCompact) },
    series: [
      {
        type: 'treemap',
        name: 'Context',
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        itemStyle: { color: seriesColor(theme, 0), borderColor: theme.surface, gapWidth: 2 },
        label: { color: '#ffffff', fontFamily: theme.fontFamily, fontSize: 11 },
        data: weights
          .filter((entry) => entry.tokens > 0)
          .map((entry) => ({ name: weightLabel(entry), value: entry.tokens })),
      },
    ],
  };
}
