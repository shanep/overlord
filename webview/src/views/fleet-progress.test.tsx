import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FleetProgress, TaskProgress } from '../../../src/shared/progress.js';
import { fleetState, NOW } from '../../test/fixtures.js';

import { formatLeft, LeftCell, ProgressCell, progressTip } from './fleet-progress.js';
import type { FleetRow } from './fleet-rows.js';
import { buildFleetTree } from './fleet-rows.js';

const MINUTE = 60_000;

function sessionRow(id: string): FleetRow {
  const node = buildFleetTree(fleetState).find((item) => item.row.sessionId === id);
  if (node === undefined) {
    throw new Error(`no row for ${id}`);
  }
  return node.row;
}

function withProgress(progress: FleetProgress | null): FleetRow {
  return { ...sessionRow('s1'), progress };
}

const S1 = fleetState.progress['s1'] ?? null;

function tasks(overrides: Partial<TaskProgress>): FleetProgress {
  const base = S1?.tasks ?? null;
  if (base === null) {
    throw new Error('the fixture has no task list');
  }
  return { tasks: { ...base, ...overrides }, subagents: null, budget: null };
}

describe('formatLeft', () => {
  it('rounds to minutes and drops zero minutes on the hour', () => {
    expect(formatLeft(10_000)).toBe('1m');
    expect(formatLeft(22 * MINUTE + 20_000)).toBe('22m');
    expect(formatLeft(190 * MINUTE)).toBe('3h 10m');
    expect(formatLeft(120 * MINUTE)).toBe('2h');
  });
});

describe('progressTip', () => {
  it('says how far along it is, what is left, who spent the tokens and the budget', () => {
    const tip = progressTip(S1);
    expect(tip).toContain('3 of 8 tasks done. 1 in progress. Now: Wire the parser into the CLI.');
    expect(tip).toContain('About 1.5M tokens ($1.60 est.) and 1h 2m left');
    expect(tip).toContain(
      'Subagents: 1 running, 1 finished, 300K tokens. Most: Find parser tests 200K (running), Read fixtures 100K.',
    );
    expect(tip).toContain('Click to set a token budget.');
    expect(tip).not.toContain('Rough');
  });

  it('says when the estimate is rough, the limit runs out first, or there is none yet', () => {
    const estimate = S1?.tasks?.estimate ?? null;
    if (estimate === null) {
      throw new Error('the fixture has no estimate');
    }
    const rough = tasks({ estimate: { ...estimate, basis: 1, limitRunsOutAt: NOW + MINUTE } });
    expect(progressTip(rough)).toContain('Rough: it rests on 1 finished task.');
    expect(progressTip(rough)).toContain('The 5 hour limit runs out at');
    expect(progressTip(tasks({ done: 0, estimate: null }))).toContain(
      'No estimate until a task is done.',
    );
    expect(progressTip(tasks({ done: 8, inProgress: 0, estimate: null }))).toContain(
      'All tasks done.',
    );
    expect(progressTip(fleetState.progress['s2'] ?? null)).toBe(
      'Budget: 1.9M of 2M tokens used. Click to change it.',
    );
  });
});

describe('ProgressCell', () => {
  it('shows tasks done, or else the budget, and sets the budget when clicked', () => {
    const onAction = vi.fn();
    const row = withProgress(S1);
    render(<ProgressCell row={row} tabIndex={0} onAction={onAction} />);
    expect(screen.getByRole('meter', { name: 'Tasks done' }).getAttribute('aria-valuenow')).toBe(
      '38',
    );
    expect(screen.getByText('3/8').textContent).not.toBe('');
    fireEvent.click(
      screen.getByRole('button', { name: /^Progress of .*: set its token budget$/u }),
    );
    expect(onAction).toHaveBeenCalledWith(row, 'budget');
  });

  it('shows the budget used with no task list, and an offer to set one with neither', () => {
    const { unmount } = render(
      <ProgressCell row={sessionRow('s2')} tabIndex={0} onAction={vi.fn()} />,
    );
    expect(screen.getByText('95% budget').textContent).not.toBe('');
    unmount();
    render(<ProgressCell row={withProgress(null)} tabIndex={0} onAction={vi.fn()} />);
    expect(screen.getByText('Budget').textContent).not.toBe('');
  });

  it('shows nothing on a subagent row', () => {
    const node = buildFleetTree(fleetState).find((item) => item.row.sessionId === 's1');
    const child = node?.children[0]?.row;
    if (child === undefined) {
      throw new Error('no subagent row');
    }
    const { container } = render(<ProgressCell row={child} tabIndex={0} onAction={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('LeftCell', () => {
  it('shows time and tokens left, rough and warned when it should', () => {
    const estimate = S1?.tasks?.estimate ?? null;
    if (estimate === null) {
      throw new Error('the fixture has no estimate');
    }
    const { unmount } = render(<LeftCell row={withProgress(S1)} />);
    expect(screen.getByText('1h 2m · 1.5M').textContent).not.toBe('');
    unmount();
    const limited = tasks({ estimate: { ...estimate, basis: 1, limitRunsOutAt: NOW } });
    const second = render(<LeftCell row={withProgress(limited)} />);
    expect(screen.getByText('Limit').textContent).not.toBe('');
    expect(screen.getByText(/^~1h 2m/u).textContent).not.toBe('');
    second.unmount();
    const over = { ...tasks({}), budget: { tokens: 2_000_000, used: 1_000_000 } };
    const third = render(<LeftCell row={withProgress(over)} />);
    expect(screen.getByText('Over budget').textContent).not.toBe('');
    third.unmount();
  });

  it('says done or estimating with no estimate, and nothing with no task list', () => {
    const { unmount } = render(
      <LeftCell row={withProgress(tasks({ done: 8, inProgress: 0, estimate: null }))} />,
    );
    expect(screen.getByText('Done').textContent).not.toBe('');
    unmount();
    const second = render(<LeftCell row={withProgress(tasks({ done: 0, estimate: null }))} />);
    expect(screen.getByText('Estimating').textContent).not.toBe('');
    second.unmount();
    const { container } = render(<LeftCell row={sessionRow('s2')} />);
    expect(container.innerHTML).toBe('');
  });
});
