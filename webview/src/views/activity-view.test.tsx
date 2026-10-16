import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  ActivityProcess,
  ActivitySession,
  ActivityState,
  MachineActivity,
} from '../../../src/shared/activity.js';
import { NOW } from '../../test/fixtures.js';
import { expectAccessible, FakeApi, renderView } from '../../test/render.js';

import { formatCpu, formatRates, sessionFlags, stateLabel } from './activity-table.js';
import { ActivityView, loadText, usedShare } from './activity-view.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const MACHINE: MachineActivity = {
  cores: 10,
  cpuPct: 42,
  loadAverage: [12.5, 9, 8],
  memoryTotalBytes: 64 * GB,
  memoryUsedBytes: 40 * GB,
  swapUsedBytes: GB,
  swapTotalBytes: 4 * GB,
  memoryPressure: 'warning',
  stall: { cpu: 12.3, memory: null, io: 40 },
  cpuSpeedLimitPct: 70,
  volumes: [
    { path: '/Users/me/repo', freeBytes: 100 * GB, totalBytes: 1000 * GB, responding: true },
    { path: '/Volumes/nfs', freeBytes: null, totalBytes: null, responding: false },
  ],
};

function process(pid: number, overrides: Partial<ActivityProcess> = {}): ActivityProcess {
  return {
    pid,
    ppid: 1,
    name: `proc${String(pid)}`,
    command: `proc${String(pid)} --flag`,
    state: 'S',
    cpuPct: 1,
    memoryBytes: 10 * MB,
    disk: { readPerSec: 0, writePerSec: 0 },
    network: { readPerSec: 0, writePerSec: 0 },
    flags: [],
    ...overrides,
  };
}

function session(id: string, overrides: Partial<ActivitySession> = {}): ActivitySession {
  return {
    sessionId: id,
    title: id,
    cwd: `/w/${id}`,
    pid: 100,
    place: null,
    cpuPct: 5,
    memoryBytes: 100 * MB,
    disk: { readPerSec: 0, writePerSec: 0 },
    network: { readPerSec: 0, writePerSec: 0 },
    processes: [process(100)],
    ...overrides,
  };
}

const BUSY = session('busy', {
  title: 'Busy build',
  place: 'vscode',
  cpuPct: 180,
  memoryBytes: 3 * GB,
  disk: { readPerSec: 2 * MB, writePerSec: 512 },
  network: { readPerSec: 1024, writePerSec: 0 },
  processes: [
    process(100, { name: 'claude' }),
    process(101, {
      name: 'node',
      state: 'R+',
      cpuPct: 170,
      flags: [{ kind: 'cpu-hog', level: 'warning', detail: 'Used 170% CPU' }],
    }),
    process(102, {
      name: 'cp',
      state: 'D',
      cpuPct: null,
      flags: [{ kind: 'blocked', level: 'critical', detail: 'Stuck on disk' }],
    }),
  ],
});

const QUIET = session('quiet', {
  title: 'Quiet docs',
  cpuPct: null,
  disk: { readPerSec: null, writePerSec: null },
  network: { readPerSec: null, writePerSec: null },
});

const STATE: ActivityState = {
  sampledAt: NOW,
  intervalMs: 2000,
  machine: MACHINE,
  sessions: [QUIET, BUSY],
  alerts: [
    {
      level: 'critical',
      sessionId: null,
      pid: null,
      subject: 'Machine',
      message: 'Load is 12.5 on 10 cores.',
    },
    {
      level: 'warning',
      sessionId: 'busy',
      pid: 101,
      subject: 'node (101) in Busy build',
      message: 'Used 170% CPU',
    },
  ],
  notes: ['Network use counts TCP traffic only.'],
};

const EMPTY: ActivityState = {
  sampledAt: null,
  intervalMs: 2000,
  machine: {
    ...MACHINE,
    cpuPct: null,
    memoryUsedBytes: null,
    swapTotalBytes: null,
    memoryPressure: null,
    stall: null,
    cpuSpeedLimitPct: null,
    volumes: [],
  },
  sessions: [],
  alerts: [],
  notes: [],
};

function rowTitles(): string[] {
  const table = screen.getByRole('table', { name: 'Running sessions' });
  return within(table)
    .getAllByRole('button', { name: /^(Busy build|Quiet docs)$/u })
    .map((button) => button.textContent);
}

describe('activity helpers', () => {
  it('formats CPU, rates, states and load', () => {
    expect(formatCpu(null)).toBe('...');
    expect(formatCpu(12.345)).toBe('12.3%');
    expect(formatRates({ readPerSec: null, writePerSec: null })).toBe('n/a');
    expect(formatRates({ readPerSec: 2048, writePerSec: 0 })).toBe('2 KB/s / 0 B/s');
    expect(stateLabel('R+')).toBe('Running');
    expect(stateLabel('U')).toBe('Waiting on I/O');
    expect(stateLabel('W')).toBe('W');
    expect(loadText(MACHINE)).toBe('12.5 on 10 cores');
    expect(sessionFlags(BUSY).map((flag) => flag.kind)).toStrictEqual(['cpu-hog', 'blocked']);
  });

  it('works out the used share of a volume', () => {
    expect(usedShare({ path: '/', freeBytes: 25, totalBytes: 100, responding: true })).toBe(0.75);
    expect(usedShare({ path: '/', freeBytes: null, totalBytes: 100, responding: true })).toBeNull();
    expect(usedShare({ path: '/', freeBytes: 1, totalBytes: 0, responding: true })).toBeNull();
  });
});

describe('ActivityView', () => {
  it('shows machine stats, notes, problems and machine details', async () => {
    const { container } = renderView(<ActivityView state={STATE} />);
    expect(screen.getByRole('heading', { name: 'Activity' })).not.toBeNull();
    expect(screen.getByRole('meter', { name: 'CPU in use' }).getAttribute('aria-valuenow')).toBe(
      '42',
    );
    expect(screen.getByRole('meter', { name: 'Memory in use' }).getAttribute('aria-valuenow')).toBe(
      '63',
    );
    expect(container.textContent).toContain('1 GB of 4 GB');
    expect(container.textContent).toContain('Network use counts TCP traffic only.');
    expect(container.textContent).toContain('last at');
    const problems = screen.getByRole('region', { name: 'Problems' });
    expect(within(problems).getByText('Critical')).not.toBeNull();
    expect(problems.textContent).toContain('Load is 12.5 on 10 cores.');
    const machine = screen.getByRole('region', { name: 'Machine' });
    expect(machine.textContent).toContain('warning');
    expect(machine.textContent).toContain('CPU 12.3%, memory n/a, disk 40.0%');
    expect(machine.textContent).toContain('70% (slowed for heat or power)');
    expect(machine.textContent).toContain('12.50, 9.00, 8.00');
    expect(within(machine).getByText('Not responding')).not.toBeNull();
    expect(
      within(machine).getByRole('meter', { name: 'Disk used' }).getAttribute('aria-valuenow'),
    ).toBe('90');
    await expectAccessible(container);
  });

  it('opens a session from a problem', () => {
    const { api } = renderView(<ActivityView state={STATE} />);
    fireEvent.click(screen.getByRole('button', { name: 'node (101) in Busy build' }));
    expect(api.actions()).toStrictEqual([
      { type: 'openAgent', sessionId: 'busy', agentId: 'busy' },
    ]);
  });

  it('sorts busiest first, re-sorts on a header click, and remembers the choice', () => {
    const api = new FakeApi();
    renderView(<ActivityView state={STATE} />, api);
    expect(rowTitles()).toStrictEqual(['Busy build', 'Quiet docs']);
    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    expect(rowTitles()).toStrictEqual(['Busy build', 'Quiet docs']);
    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    expect(rowTitles()).toStrictEqual(['Quiet docs', 'Busy build']);
    expect(api.saved).toMatchObject({ activitySort: { column: 'title', descending: true } });
  });

  it.each([
    ['CPU', ['Quiet docs', 'Busy build']],
    ['Memory', ['Quiet docs', 'Busy build']],
    ['Disk read / write', ['Quiet docs', 'Busy build']],
    ['Network in / out', ['Quiet docs', 'Busy build']],
    ['Processes', ['Quiet docs', 'Busy build']],
    ['Problems', ['Quiet docs', 'Busy build']],
  ])('sorts by %s, least first on the first click', (header, order) => {
    renderView(
      <ActivityView state={STATE} />,
      new FakeApi({ activitySort: { column: 'title', descending: false } }),
    );
    fireEvent.click(screen.getByRole('button', { name: header }));
    expect(rowTitles()).toStrictEqual(order);
  });

  it('opens a session row to list its processes and their flags', () => {
    const api = new FakeApi();
    const { container } = renderView(<ActivityView state={STATE} />, api);
    expect(container.querySelectorAll('.activity-process')).toHaveLength(0);
    const twisty = screen.getByRole('button', { name: 'Show processes for Busy build' });
    fireEvent.click(twisty);
    const rows = container.querySelectorAll('.activity-process');
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain('node');
    expect(rows[1]?.textContent).toContain('Running');
    expect(rows[1]?.textContent).toContain('CPU hog');
    expect(rows[2]?.textContent).toContain('Waiting on I/O');
    expect(rows[2]?.textContent).toContain('Blocked');
    expect(api.saved).toMatchObject({ activityOpen: ['busy'] });
    fireEvent.click(screen.getByRole('button', { name: 'Hide processes for Busy build' }));
    expect(container.querySelectorAll('.activity-process')).toHaveLength(0);
  });

  it('opens the agent view from a session title and sums flags into one badge', () => {
    const { api, container } = renderView(<ActivityView state={STATE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Busy build' }));
    expect(api.actions()).toStrictEqual([
      { type: 'openAgent', sessionId: 'busy', agentId: 'busy' },
    ]);
    const badge = container.querySelector<HTMLElement>('.activity-table .badge-critical');
    expect(badge?.textContent).toBe('2');
    expect(badge?.dataset['tip']).toBe('CPU hog: Used 170% CPU\nBlocked: Stuck on disk');
  });

  it('shows a warning badge when no flag is critical', () => {
    const warned = session('w', {
      title: 'Warned',
      processes: [process(1, { flags: [{ kind: 'zombie', level: 'warning', detail: 'z' }] })],
    });
    const { container } = renderView(<ActivityView state={{ ...STATE, sessions: [warned] }} />);
    expect(container.querySelector('.activity-table .badge-warning')?.textContent).toBe('1');
  });

  it('restores the saved sort and open rows', () => {
    const api = new FakeApi({
      activitySort: { column: 'memory', descending: false },
      activityOpen: ['quiet'],
    });
    const { container } = renderView(<ActivityView state={STATE} />, api);
    expect(rowTitles()).toStrictEqual(['Quiet docs', 'Busy build']);
    expect(container.querySelectorAll('.activity-process')).toHaveLength(1);
  });

  it('ignores a saved sort it cannot read', () => {
    renderView(<ActivityView state={STATE} />, new FakeApi({ activitySort: { column: 3 } }));
    expect(rowTitles()).toStrictEqual(['Busy build', 'Quiet docs']);
  });

  it('says so before the first sample and with nothing running', async () => {
    const { container } = renderView(<ActivityView state={EMPTY} />);
    expect(container.textContent).toContain('while this view is open.');
    expect(container.textContent).toContain('Nothing is hogging, starved or stuck.');
    expect(container.textContent).toContain('No sessions are running on this machine.');
    expect(container.textContent).toContain('No session folders to check.');
    expect(container.textContent).toContain('none');
    expect(screen.getByRole('region', { name: 'Machine' }).textContent).not.toContain('pressure');
    expect(screen.getByText('Swap').nextElementSibling?.textContent).toBe('none');
    await expectAccessible(container);
  });

  it('reads full speed and a zero size swap', () => {
    const state = { ...STATE, machine: { ...MACHINE, cpuSpeedLimitPct: 100, swapTotalBytes: 0 } };
    const { container } = renderView(<ActivityView state={state} />);
    expect(container.textContent).toContain('Full speed');
    expect(screen.getByText('Swap').nextElementSibling?.textContent).toBe('none');
  });
});
