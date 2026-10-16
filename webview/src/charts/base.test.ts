import { describe, expect, it } from 'vitest';

import {
  categoryAxis,
  categoryYAxis,
  grid,
  legend,
  textStyle,
  timeAxis,
  tooltip,
  valueAxis,
  valueFormatter,
  valueXAxis,
} from './base.js';
import { readChartTheme } from './chart-theme.js';

const theme = readChartTheme(document.createElement('div'));
const double = (value: number): string => (value * 2).toString();

describe('chart chrome', () => {
  it('uses muted ink for text and leaves room for a legend', () => {
    expect(textStyle(theme)).toStrictEqual({
      color: theme.muted,
      fontFamily: theme.fontFamily,
      fontSize: 11,
    });
    expect(grid(true)).toMatchObject({ top: 32, containLabel: true });
    expect(grid(false)).toMatchObject({ top: 12 });
  });

  it('adds a crosshair only to axis tooltips', () => {
    expect(tooltip(theme, 'axis')).toMatchObject({
      trigger: 'axis',
      backgroundColor: theme.surface,
      axisPointer: { type: 'line' },
    });
    expect(tooltip(theme, 'item')).not.toHaveProperty('axisPointer');
  });

  it('builds a legend from names in text ink', () => {
    expect(legend(theme, ['A', 'B'])).toMatchObject({
      data: ['A', 'B'],
      textStyle: { color: theme.foreground },
    });
  });

  it('draws solid hairline axes', () => {
    expect(timeAxis(theme)).toMatchObject({
      type: 'time',
      axisLine: { lineStyle: { color: theme.grid, width: 1 } },
      splitLine: { show: false },
    });
    expect(categoryAxis(theme, ['x'])).toMatchObject({ type: 'category', data: ['x'] });
    expect(categoryYAxis(theme, ['y'], true)).toMatchObject({
      type: 'category',
      data: ['y'],
      inverse: true,
    });
    expect(valueAxis(theme, double)).toMatchObject({
      type: 'value',
      axisLine: { show: false },
      splitLine: { lineStyle: { type: 'solid', width: 1 } },
      axisLabel: { formatter: double },
    });
    expect(valueAxis(theme, double)).not.toHaveProperty('min');
    expect(valueAxis(theme, double, { min: 0, max: 1 })).toMatchObject({ min: 0, max: 1 });
    expect(valueXAxis(theme, double)).toMatchObject({
      type: 'value',
      axisLabel: { formatter: double },
    });
  });

  it('formats numbers in tooltips and passes other values through', () => {
    const format = valueFormatter(double);
    expect(format(4)).toBe('8');
    expect(format('n/a')).toBe('n/a');
  });
});
