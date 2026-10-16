import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';

import type { FleetState } from '../../../src/shared/protocol.js';
import { fleetState, NOW } from '../../test/fixtures.js';
import { readChartTheme } from '../charts/chart-theme.js';

import { buildFleetTree, DEFAULT_SORT, flattenTree } from './fleet-rows.js';
import { FleetSparkline, FleetTable } from './fleet-table.js';

const theme = readChartTheme(document.body);

function noop(): void {
  // Handlers are not exercised here.
}

function renderTable(state: FleetState, showSummary = true): HTMLElement {
  render(
    <FleetTable
      rows={flattenTree(buildFleetTree(state), new Set())}
      selectedKey={null}
      historyByKey={new Map()}
      selectedRef={createRef()}
      sort={DEFAULT_SORT}
      onSort={noop}
      now={NOW}
      theme={theme}
      showSummary={showSummary}
      onSelect={noop}
      onActivate={noop}
      onKey={noop}
      onToggle={noop}
      onAction={noop}
      onProjectAction={noop}
    />,
  );
  return screen.getByRole('treegrid', { name: 'Sessions' });
}

describe('FleetTable', () => {
  it('renders rows with no history yet and no selection', () => {
    const grid = renderTable(fleetState);
    expect(grid.querySelectorAll('tr[aria-selected="true"]')).toHaveLength(0);
    expect(grid.querySelectorAll('tbody tr')).toHaveLength(5);
    // Start order has no header, so no column claims the sort.
    expect(
      grid.querySelectorAll('th[aria-sort="ascending"], th[aria-sort="descending"]'),
    ).toHaveLength(0);
    expect(grid.querySelectorAll('.sparkline [role="img"]')).toHaveLength(0);
    const vscode = screen.getByRole('img', { name: 'VS Code' });
    expect(vscode.dataset['tip']).toBe('VS Code: Open in a terminal in this VS Code window');
    expect(vscode.className).toBe('place place-good');
    expect(vscode.closest('td')?.className).toBe('col-title');
    expect(screen.getByRole('img', { name: 'Background' }).className).toBe('place place-neutral');
    expect(screen.queryByRole('img', { name: 'Terminal' })).toBeNull();
    expect(grid.querySelectorAll<HTMLElement>('.row-summary')).toHaveLength(0);
    // Only the finished session no terminal shows gets the hourglass.
    const windowless = screen.getAllByRole('img', { name: 'No window' });
    expect(windowless).toHaveLength(1);
    expect(windowless[0]?.closest('tr')?.textContent).toContain('Old run');
  });

  it('shows what a session is working on under its title', () => {
    const recap = { text: 'Split the parser in two.', at: NOW - 60_000 };
    const grid = renderTable({
      ...fleetState,
      sessions: fleetState.sessions.map((item) => (item.id === 's1' ? { ...item, recap } : item)),
    });
    const lines = grid.querySelectorAll<HTMLElement>('.row-summary');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toBe('Split the parser in two.');
    expect(lines[0]?.dataset['tip']).toBe('Split the parser in two.');
    expect(lines[0]?.closest('td')?.className).toBe('col-title');
  });

  it('describes each row button in its tooltip', () => {
    const grid = renderTable(fleetState);
    const stop = grid.querySelector<HTMLElement>('button[aria-label^="Stop "]');
    expect(stop?.dataset['tip']).toBe('Stop: End the session');
    const titles = [...grid.querySelectorAll<HTMLElement>('button.icon-button')].map(
      (button) => button.dataset['tip'] ?? '',
    );
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((title) => /^[^:]+: \S/u.test(title))).toBe(true);
  });

  it('leaves the working on line out when it is turned off', () => {
    const recap = { text: 'Split the parser in two.', at: NOW - 60_000 };
    const grid = renderTable(
      {
        ...fleetState,
        sessions: fleetState.sessions.map((item) => (item.id === 's1' ? { ...item, recap } : item)),
      },
      false,
    );
    expect(grid.querySelectorAll<HTMLElement>('.row-summary')).toHaveLength(0);
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
