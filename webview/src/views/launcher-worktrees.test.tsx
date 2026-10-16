import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { WorktreeSummary } from '../../../src/shared/protocol.js';
import { launcherState } from '../../test/fixtures-tools.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { describeChanges, WORKTREE_INFO, WorktreesTable } from './launcher-worktrees.js';

const [, unlanded] = launcherState.worktrees;

function item(overrides: Partial<WorktreeSummary>): WorktreeSummary {
  if (unlanded === undefined) {
    throw new Error('fixture missing');
  }
  return { ...unlanded, ...overrides };
}

function row(label: string): HTMLElement {
  const cell = screen.getByText(label, { selector: 'span[title] > *, span[title]' });
  const found = cell.closest('tr');
  if (found === null) {
    throw new Error(`No row for ${label}`);
  }
  return found;
}

describe('describeChanges', () => {
  it('counts commits and uncommitted files', () => {
    expect(describeChanges(item({ ahead: 0, dirty: 0 }))).toBe('none');
    expect(describeChanges(item({ ahead: 1, dirty: 0 }))).toBe('1 commit');
    expect(describeChanges(item({ ahead: 2, dirty: 1 }))).toBe('2 commits, 1 file');
    expect(describeChanges(item({ ahead: 0, dirty: 3 }))).toBe('3 files');
  });
});

describe('WorktreesTable', () => {
  it('lists each worktree with its state, changes and overlaps and passes axe', async () => {
    const { container } = renderView(<WorktreesTable worktrees={launcherState.worktrees} />);
    expect(screen.getByText('3 open, 2 touching the same files')).toBeDefined();
    const busy = row('Flaky test');
    expect(within(busy).getByText('active').dataset['tip']).toBe(WORKTREE_INFO.active.description);
    expect(within(busy).getByText('1 file')).toBeDefined();
    expect(within(busy).getByText('Parser cleanup: src/parser.ts', { exact: false })).toBeDefined();
    expect(within(busy).queryByRole('button')).toBeNull();
    expect(
      within(row('Parser cleanup')).getByText('main also changed: src/lexer.ts', { exact: false }),
    ).toBeDefined();
    expect(within(row('Docs pass')).getByText('none')).toBeDefined();
    expect(within(row('Docs pass')).getByText('docs').title).toBe('/docs');
    await expectAccessible(container);
  });

  it('offers land only for unlanded work with somewhere to land', async () => {
    const { api } = renderView(<WorktreesTable worktrees={launcherState.worktrees} />);
    await userEvent.click(screen.getByRole('button', { name: 'Land Parser cleanup on main' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open a session in Parser cleanup' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard Docs pass' }));
    expect(screen.queryByRole('button', { name: /^Land Docs pass/u })).toBeNull();
    expect(api.actions()).toStrictEqual([
      { type: 'landWorktree', id: 'w2' },
      { type: 'openWorktree', id: 'w2' },
      { type: 'discardWorktree', id: 'w3' },
    ]);
  });

  it('sorts by label, repository, state and slot', async () => {
    renderView(<WorktreesTable worktrees={launcherState.worktrees} />);
    const labels = (): string[] =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((tableRow) => tableRow.querySelector('td')?.textContent ?? '');
    await userEvent.click(screen.getByRole('button', { name: 'Label' }));
    expect(labels().map((text) => text.split(' ', 1)[0])).toStrictEqual([
      'Docs',
      'Flaky',
      'Parser',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Repository' }));
    expect(labels()[0]).toMatch(/^Docs/u);
    await userEvent.click(screen.getByRole('button', { name: 'State' }));
    expect(labels()[0]).toMatch(/^Flaky/u);
    await userEvent.click(screen.getByRole('button', { name: 'Slot' }));
    expect(labels()[0]).toMatch(/^Flaky/u);
  });

  it('hides actions for a missing worktree and skips the overlap count when none overlap', () => {
    const missing = item({ id: 'w9', label: 'Gone', state: 'missing', overlaps: [] });
    renderView(<WorktreesTable worktrees={[missing]} />);
    expect(screen.getByText('1 open')).toBeDefined();
    expect(within(row('Gone')).queryByRole('button')).toBeNull();
  });
});
