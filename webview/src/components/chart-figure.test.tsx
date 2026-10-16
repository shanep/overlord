import { render, within } from '@testing-library/react';
import type { EChartsOption } from 'echarts';
import { describe, expect, it } from 'vitest';

import { expectAccessible } from '../../test/render.js';

import { ChartFigure } from './chart-figure.js';

const option: EChartsOption = {
  xAxis: { type: 'category', data: ['a'] },
};

describe('ChartFigure', () => {
  it('renders the chart with a table twin', async () => {
    const { getByRole, container } = render(
      <main>
        <ChartFigure
          title="Cost"
          option={{
            xAxis: { type: 'category', data: ['a'] },
            yAxis: { type: 'value' },
            series: [{ type: 'bar', data: [1] }],
          }}
          height={120}
          table={{ columns: ['Day', 'Cost'], rows: [['a', '$1.00 est.']] }}
        />
      </main>,
    );
    expect(getByRole('figure').querySelector('figcaption')?.textContent).toBe('Cost');
    expect(getByRole('img', { name: 'Cost' })).toBeDefined();
    const table = getByRole('table', { name: 'Cost' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toStrictEqual(['Day', 'Cost']);
    expect(
      within(table)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toStrictEqual(['a', '$1.00 est.']);
    await expectAccessible(container);
  });

  it('says there is no data instead of drawing an empty chart', () => {
    const { queryByRole, getByText } = render(
      <ChartFigure
        title="Cost"
        option={option}
        height={120}
        table={{ columns: ['Day'], rows: [] }}
      />,
    );
    expect(queryByRole('img')).toBeNull();
    expect(getByText('No data yet.')).toBeDefined();
  });
});
