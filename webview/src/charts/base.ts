// Shared chart chrome: recessive hairline axes and grid, muted axis text,
// a tooltip on the surface color. Builders spread these into their options.

import type {
  GridComponentOption,
  LegendComponentOption,
  TooltipComponentOption,
  XAXisComponentOption,
  YAXisComponentOption,
} from 'echarts';

import type { ChartTheme } from './chart-theme.js';

export const LINE_WIDTH = 2;
export const AREA_OPACITY = 0.1;
export const BAR_MAX_WIDTH = 24;
export const MARKER_SIZE = 8;

export function textStyle(theme: ChartTheme): {
  color: string;
  fontFamily: string;
  fontSize: number;
} {
  return { color: theme.muted, fontFamily: theme.fontFamily, fontSize: 11 };
}

export function grid(withLegend: boolean): GridComponentOption {
  return { left: 8, right: 16, top: withLegend ? 32 : 12, bottom: 8, containLabel: true };
}

export function tooltip(theme: ChartTheme, trigger: 'axis' | 'item'): TooltipComponentOption {
  return {
    trigger,
    backgroundColor: theme.surface,
    borderColor: theme.grid,
    textStyle: { color: theme.foreground, fontFamily: theme.fontFamily, fontSize: 12 },
    ...(trigger === 'axis'
      ? { axisPointer: { type: 'line', lineStyle: { color: theme.muted, width: 1 } } }
      : {}),
  };
}

export function legend(theme: ChartTheme, names: readonly string[]): LegendComponentOption {
  return {
    data: [...names],
    top: 0,
    left: 0,
    itemWidth: 12,
    itemHeight: 8,
    textStyle: { color: theme.foreground, fontFamily: theme.fontFamily, fontSize: 11 },
  };
}

function axisChrome(theme: ChartTheme): {
  axisLine: { lineStyle: { color: string; width: number } };
  axisTick: { show: boolean };
  axisLabel: { color: string; fontFamily: string; fontSize: number };
  splitLine: { lineStyle: { color: string; width: number; type: 'solid' } };
} {
  return {
    axisLine: { lineStyle: { color: theme.grid, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: theme.muted, fontFamily: theme.fontFamily, fontSize: 11 },
    splitLine: { lineStyle: { color: theme.grid, width: 1, type: 'solid' } },
  };
}

export function timeAxis(theme: ChartTheme): XAXisComponentOption {
  return { type: 'time', ...axisChrome(theme), splitLine: { show: false } };
}

export function categoryAxis(theme: ChartTheme, data: readonly string[]): XAXisComponentOption {
  return { type: 'category', data: [...data], ...axisChrome(theme), splitLine: { show: false } };
}

export function categoryYAxis(
  theme: ChartTheme,
  data: readonly string[],
  inverse: boolean,
): YAXisComponentOption {
  return {
    type: 'category',
    data: [...data],
    inverse,
    ...axisChrome(theme),
    splitLine: { show: false },
  };
}

export interface Bounds {
  readonly min: number;
  readonly max: number;
}

export function valueAxis(
  theme: ChartTheme,
  formatter: (value: number) => string,
  bounds?: Bounds,
): YAXisComponentOption {
  const chrome = axisChrome(theme);
  return {
    type: 'value',
    ...chrome,
    ...(bounds === undefined ? {} : { min: bounds.min, max: bounds.max }),
    axisLine: { show: false },
    axisLabel: { ...chrome.axisLabel, formatter },
  };
}

export function valueXAxis(
  theme: ChartTheme,
  formatter: (value: number) => string,
): XAXisComponentOption {
  const chrome = axisChrome(theme);
  return { type: 'value', ...chrome, axisLabel: { ...chrome.axisLabel, formatter } };
}

/** Tooltip value formatter that accepts whatever ECharts hands it. */
export function valueFormatter(format: (value: number) => string): (value: unknown) => string {
  return (value) => (typeof value === 'number' ? format(value) : String(value));
}
