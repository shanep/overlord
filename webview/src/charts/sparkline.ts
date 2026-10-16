// Tiny trend line for a table row. No axes, no tooltip: the row already
// shows the current value, the line only shows its shape.

import type { EChartsOption } from 'echarts';

import { AREA_OPACITY } from './base.js';
import type { ChartTheme } from './chart-theme.js';
import { seriesColor } from './chart-theme.js';

export function buildSparkline(values: readonly number[], theme: ChartTheme): EChartsOption {
  const color = seriesColor(theme, 0);
  return {
    animation: false,
    grid: { left: 1, right: 1, top: 2, bottom: 2 },
    xAxis: { type: 'category', show: false, boundaryGap: false, data: values.map(String) },
    yAxis: { type: 'value', show: false, min: 0 },
    series: [
      {
        type: 'line',
        data: [...values],
        silent: true,
        showSymbol: false,
        lineStyle: { width: 1.5, color },
        areaStyle: { color, opacity: AREA_OPACITY * 2 },
      },
    ],
  };
}
