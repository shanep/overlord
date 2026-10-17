import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { FleetState } from '../../../src/shared/protocol.js';
import { twoAgents } from '../../test/fixtures-agents.js';
import { fleetState, NOW, session, usage } from '../../test/fixtures.js';
import { expectAccessible, FakeApi, renderView } from '../../test/render.js';

import { FleetView } from './fleet-view.js';

const mixed: FleetState = {
  ...fleetState,
  sessions: [
    ...fleetState.sessions,
    session({
      id: 'c1',
      agent: 'codex',
      title: 'Port the parser',
      startedAt: NOW - 30 * 60_000,
      usage: usage(4000, 300, 2000),
      costUsd: null,
      effort: 'high',
    }),
  ],
};

function flatApi(): FakeApi {
  return new FakeApi({ 'fleet.groupByProject': false });
}

function rowFor(title: string): HTMLElement {
  const row = screen.getByText(title, { selector: '.row-title' }).closest('tr');
  if (row === null) {
    throw new Error(`no row for ${title}`);
  }
  return row;
}

function cell(row: HTMLElement, column: string): HTMLElement {
  const found = row.querySelector<HTMLElement>(`.col-${column}`);
  if (found === null) {
    throw new Error(`no ${column} cell`);
  }
  return found;
}

describe('FleetView with more than one agent', () => {
  it('looks as it did with Claude Code alone', async () => {
    renderView(<FleetView state={fleetState} />, flatApi());
    expect(document.querySelector('.agent-mark')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'View' }));
    expect(screen.queryByRole('radiogroup', { name: 'Agent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull();
  });

  it('names each row its agent and shows a dash for what the agent does not report', async () => {
    const { container } = renderView(<FleetView state={mixed} />, flatApi(), twoAgents);
    const codex = rowFor('Port the parser');
    expect(within(codex).getByText('Codex')).toBeDefined();
    expect(within(rowFor('Refactor parser')).getByText('Claude')).toBeDefined();
    expect(cell(codex, 'cache').textContent).toBe('-');
    expect(cell(codex, 'cost').textContent).toBe('-');
    expect(cell(codex, 'effort').textContent).toBe('');
    expect(within(codex).getByRole('button', { name: /^Interrupt/ })).toHaveProperty(
      'disabled',
      true,
    );
    await expectAccessible(container);
  });

  it('filters to one agent from the View menu', async () => {
    const user = userEvent.setup();
    renderView(<FleetView state={mixed} />, flatApi(), twoAgents);
    await user.click(screen.getByRole('button', { name: 'View' }));
    await user.click(screen.getByRole('radio', { name: 'Codex only' }));
    expect(screen.queryByText('Refactor parser', { selector: '.row-title' })).toBeNull();
    expect(rowFor('Port the parser')).toBeDefined();
    await user.click(screen.getByRole('radio', { name: 'All agents' }));
    expect(rowFor('Refactor parser')).toBeDefined();
  });

  it('starts a session with the agent picked from New session', async () => {
    const user = userEvent.setup();
    const { api } = renderView(<FleetView state={fleetState} />, flatApi(), twoAgents);
    await user.click(screen.getByRole('button', { name: 'New session' }));
    await user.click(screen.getByRole('button', { name: 'Codex CLI' }));
    expect(api.actions()).toStrictEqual([{ type: 'newSession', agent: 'codex' }]);
    expect(screen.queryByRole('button', { name: 'Codex CLI' })).toBeNull();
  });
});
