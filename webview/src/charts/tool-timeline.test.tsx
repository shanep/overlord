import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NOW, toolCalls } from '../../test/fixtures.js';
import { first } from '../../test/render.js';

import { readChartTheme } from './chart-theme.js';
import { EChart } from './chart.js';
import { buildToolTimeline, callStatus, timelineRows } from './tool-timeline.js';

const theme = readChartTheme(document.createElement('div'));
const MINUTE = 60_000;

describe('callStatus', () => {
  it('maps a call to ok, error or running', () => {
    expect(toolCalls.map((call) => callStatus(call))).toStrictEqual(['ok', 'error', 'running']);
  });
});

describe('timelineRows', () => {
  it('orders calls by start and times running calls against now', () => {
    expect(timelineRows(toolCalls.toReversed(), NOW, 60)).toStrictEqual([
      { label: '1. Read', status: 'ok', offset: 0, seconds: 2 },
      { label: '2. Bash', status: 'error', offset: 60, seconds: 2 },
      { label: '3. Edit', status: 'running', offset: 120, seconds: 7 * 60 },
    ]);
  });

  it('keeps only the last calls and handles none', () => {
    expect(timelineRows(toolCalls, NOW, 1)).toStrictEqual([
      { label: '1. Edit', status: 'running', offset: 0, seconds: 420 },
    ]);
    expect(timelineRows([], NOW, 10)).toStrictEqual([]);
  });

  it('never gives a negative duration', () => {
    const call = first(toolCalls);
    const rows = timelineRows([{ ...call, endedAt: call.startedAt - 5 }], NOW - 9 * MINUTE, 5);
    expect(rows[0]?.seconds).toBe(0);
  });
});

describe('buildToolTimeline', () => {
  it('draws each status as its own stacked series on an invisible offset', () => {
    const rows = timelineRows(toolCalls, NOW, 60);
    const option = buildToolTimeline(rows, theme);
    expect(option).toMatchObject({
      legend: { data: ['Done', 'Error', 'Running'] },
      tooltip: { trigger: 'item' },
      yAxis: { type: 'category', inverse: true, data: ['1. Read', '2. Bash', '3. Edit'] },
      series: [
        {
          name: 'Offset',
          stack: 'call',
          silent: true,
          itemStyle: { color: 'transparent' },
          data: [0, 60, 120],
        },
        {
          name: 'Done',
          stack: 'call',
          itemStyle: { color: theme.good, borderRadius: 4 },
          data: [2, 0, 0],
        },
        { name: 'Error', itemStyle: { color: theme.critical }, data: [0, 2, 0] },
        { name: 'Running', itemStyle: { color: theme.series[0] }, data: [0, 0, 420] },
      ],
    });
  });

  it('formats seconds on the axis', () => {
    const option = buildToolTimeline([], theme);
    expect(option).toMatchObject({ xAxis: { type: 'value' } });
    const { container } = render(
      <EChart
        option={buildToolTimeline(timelineRows(toolCalls, NOW, 60), theme)}
        label="Timeline"
        height={200}
      />,
    );
    expect(container.textContent).toContain('1. Read');
    expect(container.textContent).toMatch(/\ds/u);
  });
});
