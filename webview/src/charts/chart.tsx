// One React wrapper for every chart. It owns the ECharts instance: init on
// mount, setOption on change, resize with the container, dispose on unmount.
// The SVG renderer keeps it working in jsdom and avoids canvas CSP issues.

import type { EChartsOption } from 'echarts';
import { BarChart, HeatmapChart, LineChart, TreemapChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import type { EChartsType } from 'echarts/core';
import { init, use as registerParts } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

registerParts([
  BarChart,
  HeatmapChart,
  LineChart,
  TreemapChart,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
  SVGRenderer,
]);

export interface EChartProps {
  readonly option: EChartsOption;
  /** Accessible name for the chart image. */
  readonly label: string;
  readonly height: number;
  /** Fixed width in pixels. Omit to fill the container. */
  readonly width?: number;
}

export function EChart(props: EChartProps): ReactElement {
  const { option, label, height, width } = props;
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const optionRef = useRef(option);

  // Runs before the init effect, so a new chart always starts from the
  // latest option.
  useEffect(() => {
    optionRef.current = option;
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  useEffect(() => {
    if (element === null) {
      return;
    }
    const chart = init(element, null, {
      renderer: 'svg',
      height,
      ...(width === undefined ? {} : { width }),
    });
    chart.setOption(optionRef.current);
    chartRef.current = chart;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            chart.resize();
          });
    observer?.observe(element);
    return (): void => {
      observer?.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [element, height, width]);

  return (
    <div
      ref={setElement}
      className="chart"
      role="img"
      aria-label={label}
      style={{ height, ...(width === undefined ? {} : { width }) }}
    />
  );
}
