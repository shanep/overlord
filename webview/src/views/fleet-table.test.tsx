import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';

import { fleetState, NOW } from '../../test/fixtures.js';
import { readChartTheme } from '../charts/chart-theme.js';

import { buildFleetTree, DEFAULT_SORT, flattenTree } from './fleet-rows.js';
import { FleetSparkline, FleetTable } from './fleet-table.js';

const theme = readChartTheme(document.body);

function noop(): void {
  // Handlers are not exercised here.
}

describe('FleetTable', () => {
  it('renders rows with no history yet and no selection', () => {
    const rows = flattenTree(buildFleetTree(fleetState), new Set());
    render(
      <FleetTable
        rows={rows}
        selectedKey={null}
        historyByKey={new Map()}
        selectedRef={createRef()}
        sort={DEFAULT_SORT}
        onSort={noop}
        now={NOW}
        theme={theme}
        onSelect={noop}
        onActivate={noop}
        onKey={noop}
        onToggle={noop}
        onAction={noop}
      />,
    );
    const grid = screen.getByRole('treegrid', { name: 'Sessions' });
    expect(grid.querySelectorAll('tr[aria-selected="true"]')).toHaveLength(0);
    expect(grid.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(screen.getByRole('columnheader', { name: 'State' }).getAttribute('aria-sort')).toBe(
      'ascending',
    );
    expect(grid.querySelectorAll('.sparkline [role="img"]')).toHaveLength(0);
    const vscode = screen.getByRole('img', { name: 'VS Code' });
    expect(vscode.getAttribute('title')).toBe('VS Code: Open in a terminal in this VS Code window');
    expect(vscode.className).toBe('place place-good');
    expect(vscode.closest('td')?.className).toBe('col-title');
    expect(screen.getByRole('img', { name: 'Background' }).className).toBe('place place-neutral');
    expect(screen.queryByRole('img', { name: 'Terminal' })).toBeNull();
  });
});

describe('FleetSparkline', () => {
  it('waits for three samples, then draws growth', () => {
    const { rerender, container } = render(
      <FleetSparkline history={[1, 2]} theme={theme} label="Trend" />,
    );
    expect(container.querySelector('.sparkline')?.childElementCount).toBe(0);
    rerender(<FleetSparkline history={[1, 2, 5]} theme={theme} label="Trend" />);
    const chart = screen.getByRole('img', { name: 'Trend' });
    expect(chart.style.width).toBe('80px');
    expect(chart.style.height).toBe('18px');
  });
});
