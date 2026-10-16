import { fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Connector, ConnectorsState } from '../../../src/shared/connectors.js';
import { NOW } from '../../test/fixtures.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { ConnectorsView, KIND_LABELS, STATUS_INFO } from './connectors-view.js';

function connector(overrides: Partial<Connector> & Pick<Connector, 'id' | 'name'>): Connector {
  return {
    kind: 'mcp',
    target: '',
    status: 'ok',
    detail: 'Connected.',
    fix: null,
    ...overrides,
  };
}

function cell(row: HTMLElement | undefined, index: number): HTMLTableCellElement | undefined {
  return row?.querySelectorAll('td')[index];
}

const STATE: ConnectorsState = {
  checkedAt: NOW - 2 * 60_000,
  checking: false,
  folder: '/work/repo',
  connectors: [
    connector({
      id: 'claude.ai:claude.ai Gmail',
      name: 'claude.ai Gmail',
      kind: 'claude.ai',
      target: 'https://gmail',
    }),
    connector({
      id: 'chrome:claude-in-chrome',
      name: 'Claude in Chrome',
      kind: 'chrome',
      status: 'missing',
      detail: 'No Chrome is connected.',
      fix: 'open-chrome',
    }),
    connector({
      id: 'mcp:sentry',
      name: 'sentry',
      status: 'needs-auth',
      detail: 'Needs a sign in.',
      fix: 'sign-in',
    }),
  ],
};

describe('ConnectorsView', () => {
  it('lists problems first with their fix buttons, and passes axe', async () => {
    const { container, getByRole, api } = renderView(<ConnectorsView state={STATE} />);
    const rows = within(getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((row) => cell(row, 0)?.textContent)).toStrictEqual([
      'Claude in Chrome',
      'sentry',
      'Gmail',
    ]);
    expect(cell(rows[2], 0)?.firstElementChild?.getAttribute('title')).toBe('https://gmail');
    expect(cell(rows[0], 0)?.firstElementChild?.hasAttribute('title')).toBe(false);
    expect(cell(rows[2], 1)?.textContent).toBe('claude.ai connector');
    expect(cell(rows[1], 2)?.textContent).toBe('Needs sign in');
    expect(getByRole('heading', { level: 1 }).textContent).toBe('Connectors');
    expect(container.textContent).toContain('from /work/repo');
    expect(container.textContent).toContain('Last checked');
    fireEvent.click(getByRole('button', { name: 'Open Chrome' }));
    fireEvent.click(getByRole('button', { name: 'Sign in' }));
    fireEvent.click(getByRole('button', { name: 'Recheck' }));
    expect(api.actions()).toStrictEqual([
      { type: 'fixConnector', connectorId: 'chrome:claude-in-chrome' },
      { type: 'fixConnector', connectorId: 'mcp:sentry' },
      { type: 'recheckConnectors' },
    ]);
    const stats = container.querySelectorAll('.stat dd');
    expect([...stats].map((item) => item.textContent)).toStrictEqual(['1', '2']);
    await expectAccessible(container);
  });

  it('shows a check in progress and a view that has not checked yet', () => {
    const checking = renderView(
      <ConnectorsView state={{ connectors: [], checkedAt: null, checking: true, folder: null }} />,
    );
    expect(checking.container.textContent).toContain('Checking every connector.');
    expect(checking.container.textContent).toContain('Checking…');
    expect(checking.getByRole('button', { name: 'Recheck' })).toHaveProperty('disabled', true);
    expect(checking.container.textContent).not.toContain(' from ');
    checking.unmount();
    const fresh = renderView(
      <ConnectorsView state={{ connectors: [], checkedAt: null, checking: false, folder: null }} />,
    );
    expect(fresh.container.textContent).toContain('Not checked yet.');
    expect(fresh.container.textContent).toContain('No connectors found.');
  });

  it('has a label for every status and kind', () => {
    expect(Object.keys(STATUS_INFO)).toHaveLength(7);
    expect(KIND_LABELS.headless).toBe('Browser');
    expect(KIND_LABELS.mcp).toBe('MCP server');
  });
});
