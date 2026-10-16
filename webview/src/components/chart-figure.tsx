// A chart with its title and a table twin, so no value is reachable only
// by hovering and color is never the only way to tell series apart.

import type { EChartsOption } from 'echarts';
import type { ReactElement } from 'react';

import { EChart } from '../charts/chart.js';

export interface FigureTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export function ChartFigure(props: {
  readonly title: string;
  readonly option: EChartsOption;
  readonly height: number;
  readonly table: FigureTable;
}): ReactElement {
  const { title, option, height, table } = props;
  return (
    <figure className="figure">
      <figcaption className="figure-title">{title}</figcaption>
      {table.rows.length === 0 ? (
        <p className="muted">No data yet.</p>
      ) : (
        <EChart option={option} label={title} height={height} />
      )}
      <details className="figure-table">
        <summary>Table</summary>
        <table className="grid">
          <caption className="visually-hidden">{title}</caption>
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              // Rows are positional snapshots of chart data with no identity.
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
