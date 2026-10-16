import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { readChartTheme } from './chart-theme.js';
import { EChart } from './chart.js';
import { buildContextTreemap, weightLabel } from './context-treemap.js';

const theme = readChartTheme(document.createElement('div'));
const weights = [
  { label: 'System prompt', tokens: 3000, estimated: false },
  { label: 'Memory', tokens: 1200, estimated: true },
  { label: 'Empty', tokens: 0, estimated: false },
];

describe('weightLabel', () => {
  it('marks estimates', () => {
    expect(weightLabel({ label: 'Memory', tokens: 1, estimated: true })).toBe('Memory (est.)');
    expect(weightLabel({ label: 'Tools', tokens: 1, estimated: false })).toBe('Tools');
  });
});

describe('buildContextTreemap', () => {
  it('drops empty pieces and uses one hue with surface gaps', () => {
    expect(buildContextTreemap(weights, theme)).toMatchObject({
      series: [
        {
          type: 'treemap',
          roam: false,
          breadcrumb: { show: false },
          itemStyle: { color: theme.series[0], borderColor: theme.surface, gapWidth: 2 },
          data: [
            { name: 'System prompt', value: 3000 },
            { name: 'Memory (est.)', value: 1200 },
          ],
        },
      ],
    });
  });

  it('renders tile labels', () => {
    const { container } = render(
      <EChart option={buildContextTreemap(weights, theme)} label="Weights" height={200} />,
    );
    expect(container.textContent).toContain('System prompt');
  });
});
