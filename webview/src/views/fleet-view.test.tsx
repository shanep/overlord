import { act, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { FleetState } from '../../../src/shared/protocol.js';
import { fleetState, NOW, permission, session, usage } from '../../test/fixtures.js';
import { expectAccessible, FakeApi } from '../../test/render.js';
import { NowProvider } from '../clock.js';
import { VsCodeProvider } from '../vscode-context.js';

import { alwaysAllowScope } from './fleet-header.js';
import { FleetView } from './fleet-view.js';

function ui(state: FleetState, api: FakeApi): ReactElement {
  return (
    <VsCodeProvider api={api}>
      <NowProvider now={NOW}>
        <main>
          <FleetView state={state} />
        </main>
      </NowProvider>
    </VsCodeProvider>
  );
}

function setup(
  state: FleetState = fleetState,
  api: FakeApi = new FakeApi(),
): ReturnType<typeof render> & { api: FakeApi } {
  return { ...render(ui(state, api)), api };
}

function rowFor(text: string): HTMLElement {
  const row = screen.getByText(text, { selector: '.row-title' }).closest('tr');
  if (row === null) {
    throw new Error(`no row for ${text}`);
  }
  return row;
}

function bodyRowTitles(): string[] {
  const grid = screen.getByRole('treegrid', { name: 'Sessions' });
  return within(grid)
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('.row-title')?.textContent ?? '');
}

function grow(tokens: number): FleetState {
  return {
    ...fleetState,
    sessions: [session({ id: 's1', title: 'Grow', usage: usage(tokens, 10) })],
    agents: [],
  };
}

describe('FleetView', () => {
  it('shows the header stats, the tree and passes axe', async () => {
    const { container } = setup();
    expect(screen.getByRole('heading', { name: 'Fleet' })).toBeDefined();
    expect(screen.getByText('1 of 3')).toBeDefined();
    expect(screen.getByText('$3.50 est.')).toBeDefined();
    expect(screen.getByText('1h 30m')).toBeDefined();
    expect(
      screen.getByRole('meter', { name: '5 hour limit used' }).getAttribute('aria-valuenow'),
    ).toBe('64');
    expect(
      screen.getByRole('meter', { name: '7 day limit used' }).getAttribute('aria-valuenow'),
    ).toBe('20');
    expect(bodyRowTitles()).toStrictEqual([
      'Old run',
      'Write docs',
      'Refactor parser',
      'Explore',
      'general-purpose',
    ]);
    const s1 = rowFor('Refactor parser');
    expect(s1.getAttribute('aria-level')).toBe('1');
    expect(s1.getAttribute('aria-expanded')).toBe('true');
    expect(rowFor('general-purpose').getAttribute('aria-level')).toBe('3');
    expect(rowFor('general-purpose').hasAttribute('aria-expanded')).toBe(false);
    expect(within(s1).getByText('$1.25 est.')).toBeDefined();
    expect(within(s1).getByText('Edit')).toBeDefined();
    expect(within(s1).getByText('10m 00s')).toBeDefined();
    expect(within(s1).getByText('98K / 3.4K')).toBeDefined();
    expect(within(s1).getByText('4.6')).toBeDefined();
    expect(
      within(s1).getByRole('meter', { name: 'Context used by Refactor parser' }),
    ).toBeDefined();
    expect(within(rowFor('Old run')).getAllByText('n/a')).toHaveLength(3);
    expect(rowFor('Old run').getAttribute('aria-selected')).toBe('true');
    expect(rowFor('Old run').tabIndex).toBe(0);
    expect(s1.tabIndex).toBe(-1);
    await expectAccessible(container);
  });

  it('hides the 7 day limit and reset time when unknown', () => {
    setup({
      ...fleetState,
      pendingPermissions: [],
      rateLimits: { fiveHourPct: 40, sevenDayPct: null, resetsAt: null },
    });
    expect(screen.queryByRole('meter', { name: '7 day limit used' })).toBeNull();
    expect(screen.queryByText('Resets in')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Pending permissions' })).toBeNull();
    expect(
      screen.getByRole('meter', { name: '5 hour limit used' }).getAttribute('aria-valuenow'),
    ).toBe('40');
  });

  it('allows and denies pending permissions', async () => {
    const user = userEvent.setup();
    const other = { ...permission, id: 'perm-2', sessionId: 'gone' };
    const { api } = setup({ ...fleetState, pendingPermissions: [permission, other] });
    const banner = screen.getByRole('region', { name: 'Pending permissions' });
    expect(within(banner).getByText('2 pending permissions')).toBeDefined();
    expect(within(banner).getAllByText('{"command":"rm -rf build"}')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Allow Bash for Refactor parser' }));
    await user.click(screen.getByRole('button', { name: 'Deny Bash for gone' }));
    await user.click(screen.getByRole('button', { name: 'Always allow Bash for gone' }));
    expect(
      screen.getByRole('button', { name: 'Always allow Bash for gone' }).getAttribute('title'),
    ).toBe('Allow this exact command from now on, in every session');
    expect(api.actions()).toStrictEqual([
      {
        type: 'resolvePermission',
        requestId: 'perm-1',
        decision: { behavior: 'allow', ruleId: null },
      },
      {
        type: 'resolvePermission',
        requestId: 'perm-2',
        decision: { behavior: 'deny', message: 'Denied from Overlord', ruleId: null },
      },
      { type: 'alwaysAllowPermission', requestId: 'perm-2' },
    ]);
  });

  it('says what always allow covers for shells and for other tools', () => {
    expect(alwaysAllowScope('PowerShell')).toBe(
      'Allow this exact command from now on, in every session',
    );
    expect(alwaysAllowScope('Edit')).toBe('Allow every Edit request from now on, in every session');
  });

  it('says ready is not its job and posts row actions', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    expect(screen.getByText('1 pending permission')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Agent view Refactor parser' }));
    await user.click(screen.getByRole('button', { name: 'Agent view Explore' }));
    expect(api.posted.every((message) => message.type === 'action')).toBe(true);
    expect(api.actions()).toStrictEqual([
      { type: 'openAgent', sessionId: 's1', agentId: 's1' },
      { type: 'openAgent', sessionId: 's1', agentId: 'a1' },
    ]);
    expect(within(rowFor('Explore')).queryByRole('button', { name: 'Stop Explore' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Attach/u })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop Old run' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Interrupt Old run' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('confirms interrupt and stop inline before posting', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await user.click(screen.getByRole('button', { name: 'Interrupt Refactor parser' }));
    const bar = screen.getByRole('group', { name: 'Confirm' });
    expect(within(bar).getByText('Interrupt "Refactor parser"?')).toBeDefined();
    expect(document.activeElement).toBe(within(bar).getByRole('button', { name: 'Interrupt' }));
    expect(api.actions()).toStrictEqual([]);
    await user.click(within(bar).getByRole('button', { name: 'Interrupt' }));
    expect(screen.queryByRole('group', { name: 'Confirm' })).toBeNull();
    expect(document.activeElement).toBe(rowFor('Refactor parser'));

    await user.click(screen.getByRole('button', { name: 'Stop Write docs' }));
    expect(screen.getByText('Stop "Write docs"?')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Stop "Write docs"?')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Stop Write docs' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Confirm' })).getByRole('button', { name: 'Stop' }),
    );
    expect(api.actions()).toStrictEqual([
      { type: 'interrupt', sessionId: 's1' },
      { type: 'stop', sessionId: 's2' },
    ]);
  });

  it('moves, expands, collapses, opens and interrupts from the keyboard', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await user.click(rowFor('Write docs'));
    expect(document.activeElement).toBe(rowFor('Write docs'));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowFor('Refactor parser'));
    expect(rowFor('Refactor parser').getAttribute('aria-selected')).toBe('true');
    expect(rowFor('Write docs').getAttribute('aria-selected')).toBe('false');
    await user.keyboard('{ArrowLeft}');
    expect(rowFor('Refactor parser').getAttribute('aria-expanded')).toBe('false');
    expect(bodyRowTitles()).toStrictEqual(['Old run', 'Write docs', 'Refactor parser']);
    await user.keyboard('{ArrowRight}');
    expect(bodyRowTitles()).toHaveLength(5);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(rowFor('Explore'));
    await user.keyboard('{Enter}');
    await user.keyboard('x');
    await user.keyboard('k');
    expect(screen.getByText('Interrupt "Refactor parser"?')).toBeDefined();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Interrupt "Refactor parser"?')).toBeNull();
    expect(document.activeElement).toBe(rowFor('Explore'));
    expect(api.actions()).toStrictEqual([
      { type: 'openSession', sessionId: 's2' },
      { type: 'openAgent', sessionId: 's1', agentId: 'a1' },
    ]);
  });

  it('opens a session where it runs and a subagent in its view on a row click', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await user.click(rowFor('Refactor parser'));
    await user.click(within(rowFor('Explore')).getByText('Find parser tests'));
    expect(api.actions()).toStrictEqual([
      { type: 'openSession', sessionId: 's1' },
      { type: 'openAgent', sessionId: 's1', agentId: 'a1' },
    ]);
    expect(rowFor('Explore').getAttribute('aria-selected')).toBe('true');
  });

  it('ignores row keys pressed on a button inside the row', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    screen.getByRole('button', { name: 'Agent view Write docs' }).focus();
    await user.keyboard('k');
    expect(screen.queryByRole('group', { name: 'Confirm' })).toBeNull();
    expect(api.actions()).toStrictEqual([]);
  });

  it('follows the focused terminal without taking focus', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const api = new FakeApi();
    const { rerender } = render(ui({ ...fleetState, activeSessionId: 's1' }, api));
    expect(rowFor('Refactor parser').getAttribute('aria-selected')).toBe('true');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(rowFor('Refactor parser'));
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    expect(document.activeElement).toBe(document.body);

    rerender(ui({ ...fleetState, activeSessionId: 's2' }, api));
    expect(rowFor('Write docs').getAttribute('aria-selected')).toBe('true');
    expect(scroll).toHaveBeenCalledTimes(2);

    rerender(ui({ ...fleetState, activeSessionId: null }, api));
    expect(rowFor('Write docs').getAttribute('aria-selected')).toBe('true');
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(api.actions()).toStrictEqual([]);
  });

  it('expands and collapses with the twisty button', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Collapse Explore' }));
    expect(bodyRowTitles()).toStrictEqual(['Old run', 'Write docs', 'Refactor parser', 'Explore']);
    await user.click(screen.getByRole('button', { name: 'Expand Explore' }));
    expect(bodyRowTitles()).toHaveLength(5);
  });

  it('sorts by clicking headers and saves the choice', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await user.click(screen.getByRole('button', { name: 'Cost' }));
    expect(bodyRowTitles()[0]).toBe('Old run');
    expect(screen.getByRole('columnheader', { name: 'Cost' }).getAttribute('aria-sort')).toBe(
      'ascending',
    );
    await user.click(screen.getByRole('button', { name: 'Cost' }));
    expect(bodyRowTitles()[0]).toBe('Refactor parser');
    expect(screen.getByRole('columnheader', { name: 'Cost' }).getAttribute('aria-sort')).toBe(
      'descending',
    );
    expect(api.saved).toStrictEqual({ 'fleet.sort': { column: 'cost', descending: true } });
    await user.click(screen.getByRole('button', { name: 'Cost' }));
    expect(bodyRowTitles()[0]).toBe('Old run');
    expect(screen.getByRole('columnheader', { name: 'Cost' }).getAttribute('aria-sort')).toBe(
      'none',
    );
    expect(api.saved).toStrictEqual({ 'fleet.sort': { column: 'started', descending: false } });
  });

  it('filters by text and hides done rows', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await user.type(screen.getByRole('searchbox', { name: 'Filter' }), 'docs');
    expect(bodyRowTitles()).toStrictEqual(['Write docs']);
    await user.clear(screen.getByRole('searchbox', { name: 'Filter' }));
    await user.click(screen.getByRole('checkbox', { name: 'Hide done' }));
    expect(bodyRowTitles()).toStrictEqual(['Write docs', 'Refactor parser', 'Explore']);
    await user.type(screen.getByRole('searchbox', { name: 'Filter' }), 'nothing matches');
    expect(screen.queryByRole('treegrid')).toBeNull();
    expect(screen.getByText('No sessions')).toBeDefined();
    expect(api.saved).toMatchObject({ 'fleet.hideDone': true, 'fleet.filter': 'nothing matches' });
  });

  it('restores saved sort, filter and collapsed rows', () => {
    const api = new FakeApi({
      'fleet.sort': { column: 'title', descending: false },
      'fleet.filter': 'r',
      'fleet.hideDone': false,
      'fleet.collapsed': ['s:s1'],
    });
    setup(fleetState, api);
    expect(screen.getByRole('searchbox', { name: 'Filter' })).toHaveProperty('value', 'r');
    expect(bodyRowTitles()).toStrictEqual(['Old run', 'Refactor parser', 'Write docs']);
  });

  it('moves the selection to the first row when the selected row goes away', async () => {
    const user = userEvent.setup();
    const api = new FakeApi();
    const { rerender } = setup(fleetState, api);
    await user.click(rowFor('Old run'));
    expect(rowFor('Old run').getAttribute('aria-selected')).toBe('true');
    rerender(ui({ ...fleetState, sessions: fleetState.sessions.slice(0, 2) }, api));
    expect(rowFor('Write docs').getAttribute('aria-selected')).toBe('true');
  });

  it('draws a token sparkline once a row has three samples', () => {
    const api = new FakeApi();
    const { rerender } = setup(grow(100), api);
    expect(screen.queryByRole('img', { name: 'Token trend for Grow' })).toBeNull();
    act(() => {
      rerender(ui(grow(200), api));
    });
    expect(screen.queryByRole('img', { name: 'Token trend for Grow' })).toBeNull();
    act(() => {
      rerender(ui(grow(400), api));
    });
    expect(
      screen.getByRole('img', { name: 'Token trend for Grow' }).querySelector('svg'),
    ).not.toBeNull();
  });
});
