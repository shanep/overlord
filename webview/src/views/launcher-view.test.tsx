// Cell text is concatenated in assertions. cspell:ignore Fastrunning testnonedone Orphangonefailed
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { LaunchRun, LauncherState } from '../../../src/shared/protocol.js';
import { launcherState } from '../../test/fixtures-tools.js';
import { expectAccessible, FakeApi, renderView } from '../../test/render.js';

import { LauncherView } from './launcher-view.js';

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

const empty: LauncherState = {
  runs: [],
  profiles: [],
  drafts: [],
  pendingPermissions: [],
  rules: [],
  maxConcurrency: 2,
  worktrees: [],
};

describe('LauncherView', () => {
  it('renders every section and passes axe', async () => {
    const { container } = renderView(<LauncherView state={launcherState} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Launcher' })).toBeDefined();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toStrictEqual([
      'New run',
      'Runs',
      'Worktrees',
      'Permission inbox (1)',
      'Auto-approve rules',
    ]);
    await expectAccessible(container);
  });

  it('renders an empty state for every section and passes axe', async () => {
    const { container } = renderView(<LauncherView state={empty} />);
    expect(screen.queryByRole('combobox', { name: 'Load draft' })).toBeNull();
    expect(screen.getByText('No profiles yet.')).toBeDefined();
    expect(screen.getByText('No runs yet.')).toBeDefined();
    expect(screen.getByText('No worktrees. Each new session and run gets its own.')).toBeDefined();
    expect(screen.getByText('No pending requests.')).toBeDefined();
    expect(screen.getByText('No rules. Nothing is approved without asking.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Stop all' })).toHaveProperty('disabled', true);
    expect(screen.getByText('0 active, max 2 at once')).toBeDefined();
    await expectAccessible(container);
  });
});

describe('launch form', () => {
  it('needs a prompt before it can launch', async () => {
    renderView(<LauncherView state={launcherState} />);
    const launch = screen.getByRole('button', { name: 'Launch 1 run' });
    expect(launch).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Prompt' }), ' '.repeat(3));
    expect(launch).toHaveProperty('disabled', true);
  });

  it('launches a matrix run across the checked profiles', async () => {
    const { api } = renderView(<LauncherView state={launcherState} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Prompt' }), 'Fix it');
    await userEvent.type(screen.getByRole('textbox', { name: 'Label' }), 'Fixer');
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder' }), '/repo');
    await userEvent.type(screen.getByRole('spinbutton', { name: 'Budget (USD)' }), '3');
    expect(screen.getByRole('checkbox', { name: 'Own git worktree' })).toHaveProperty(
      'checked',
      true,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Fast' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Deep' }));
    await userEvent.click(screen.getByRole('button', { name: 'Launch 2 runs' }));
    const shared = { prompt: 'Fix it', cwd: '/repo', worktree: true, maxBudgetUsd: 3 };
    expect(api.actions()).toStrictEqual([
      {
        type: 'launch',
        specs: [
          { ...shared, profileId: 'p1', label: 'Fixer (Fast)' },
          { ...shared, profileId: 'p2', label: 'Fixer (Deep)' },
        ],
      },
    ]);
  });

  it('unchecks a profile and the worktree and launches with neither', async () => {
    const { api } = renderView(<LauncherView state={launcherState} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Prompt' }), 'Go');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Own git worktree' }));
    const fast = screen.getByRole('checkbox', { name: 'Fast' });
    await userEvent.click(fast);
    expect(screen.getByRole('button', { name: 'Launch 1 run' })).toBeDefined();
    await userEvent.click(fast);
    await userEvent.click(screen.getByRole('button', { name: 'Launch 1 run' }));
    expect(api.actions()).toStrictEqual([
      {
        type: 'launch',
        specs: [
          {
            prompt: 'Go',
            cwd: '',
            worktree: false,
            maxBudgetUsd: null,
            profileId: null,
            label: 'Go',
          },
        ],
      },
    ]);
  });

  it('blocks launch on a bad budget', async () => {
    renderView(<LauncherView state={launcherState} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Prompt' }), 'Go');
    await userEvent.type(screen.getByRole('spinbutton', { name: 'Budget (USD)' }), '0');
    expect(screen.getByRole('alert').textContent).toBe('Budget must be a positive number.');
    expect(screen.getByRole('button', { name: 'Launch 1 run' })).toHaveProperty('disabled', true);
  });

  it('loads a draft into the editor and keeps the prompt as local state', async () => {
    const { api } = renderView(<LauncherView state={launcherState} />);
    const picker = screen.getByRole('combobox', { name: 'Load draft' });
    fireEvent.change(picker, { target: { value: '' } });
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveProperty('value', '');
    await userEvent.selectOptions(picker, 'd1');
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveProperty(
      'value',
      'Review the last commit.',
    );
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveProperty('value', 'Review');
    expect(picker).toHaveProperty('value', '');
    expect(api.saved).toStrictEqual({
      'launcher.prompt': 'Review the last commit.',
      'launcher.label': 'Review',
    });
  });

  it('restores the saved prompt, label, folder and profiles', () => {
    const api = new FakeApi({
      'launcher.prompt': 'Saved prompt',
      'launcher.label': 'Saved',
      'launcher.cwd': '/saved',
      'launcher.profiles': ['p2'],
    });
    renderView(<LauncherView state={launcherState} />, api);
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveProperty('value', 'Saved prompt');
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveProperty('value', 'Saved');
    expect(screen.getByRole('textbox', { name: 'Folder' })).toHaveProperty('value', '/saved');
    expect(screen.getByRole('checkbox', { name: 'Deep' })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'Fast' })).toHaveProperty('checked', false);
  });
});

describe('runs', () => {
  it('lists runs with profile, state, cost, time and result', () => {
    const [running, done] = launcherState.runs;
    if (running === undefined || done === undefined) {
      throw new Error('fixture runs missing');
    }
    const orphan: LaunchRun = {
      ...done,
      id: 'r3',
      spec: { ...running.spec, profileId: 'gone', label: 'Orphan' },
      state: 'failed',
    };
    const state: LauncherState = { ...launcherState, runs: [...launcherState.runs, orphan] };
    renderView(<LauncherView state={state} />);
    const table = within(region('Runs')).getByRole('table', { name: 'Runs' });
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent);
    expect(rows).toStrictEqual([
      'Flaky testFastrunning$0.30 est.41m 35sn/a/repo/.worktrees/r1Stop',
      'Flaky testnonedone$0.80 est.95m 00sFixed by adding a wait.',
      'Orphangonefailed$0.80 est.95m 00sFixed by adding a wait.',
    ]);
    expect(screen.getByText('1 active, max 4 at once')).toBeDefined();
  });

  it('sorts runs by any column', async () => {
    const [running, done] = launcherState.runs;
    if (running === undefined || done === undefined) {
      throw new Error('fixture runs missing');
    }
    const state: LauncherState = {
      ...launcherState,
      runs: [running, { ...done, spec: { ...done.spec, label: 'Another' } }],
    };
    renderView(<LauncherView state={state} />);
    const table = within(region('Runs')).getByRole('table', { name: 'Runs' });
    const firstCells = (): (string | null)[] =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.firstChild?.textContent ?? null);
    const expected: Record<string, readonly string[]> = {
      Label: ['Another', 'Flaky test'],
      Profile: ['Flaky test', 'Another'],
      State: ['Another', 'Flaky test'],
      Cost: ['Flaky test', 'Another'],
      Turns: ['Flaky test', 'Another'],
      Time: ['Flaky test', 'Another'],
    };
    for (const [header, order] of Object.entries(expected)) {
      await userEvent.click(within(table).getByRole('button', { name: header }));
      expect(firstCells()).toStrictEqual(order);
    }
  });

  it('stops one run', async () => {
    const { api } = renderView(<LauncherView state={launcherState} />);
    expect(screen.getAllByRole('button', { name: /^Stop Flaky test$/u })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Stop Flaky test' }));
    expect(api.actions()).toStrictEqual([{ type: 'stopRun', runId: 'r1' }]);
  });

  it('asks inline before stopping all runs', async () => {
    const { api } = renderView(<LauncherView state={launcherState} />);
    const runs = within(region('Runs'));
    await userEvent.click(runs.getByRole('button', { name: 'Stop all' }));
    expect(runs.getByText('Stop 1 active runs?')).toBeDefined();
    await userEvent.click(runs.getByRole('button', { name: 'Cancel' }));
    expect(runs.queryByText('Stop 1 active runs?')).toBeNull();
    expect(api.actions()).toStrictEqual([]);
    await userEvent.click(runs.getByRole('button', { name: 'Stop all' }));
    const confirm = within(runs.getByRole('group', { name: 'Confirm' }));
    await userEvent.click(confirm.getByRole('button', { name: 'Stop all' }));
    expect(api.actions()).toStrictEqual([{ type: 'stopAll' }]);
    expect(runs.queryByRole('group', { name: 'Confirm' })).toBeNull();
  });
});

describe('permission inbox', () => {
  it('allows and denies pending requests', async () => {
    const { api } = renderView(<LauncherView state={launcherState} />);
    const inbox = within(region('Permission inbox (1)'));
    expect(inbox.getByText('Bash')).toBeDefined();
    expect(inbox.getByText('session s1')).toBeDefined();
    expect(inbox.getByText('just now')).toBeDefined();
    expect(inbox.getByText(/rm -rf build/u)).toBeDefined();
    await userEvent.click(inbox.getByRole('button', { name: 'Allow Bash for s1' }));
    await userEvent.click(inbox.getByRole('button', { name: 'Deny Bash for s1' }));
    await userEvent.click(inbox.getByRole('button', { name: 'Always allow Bash for s1' }));
    expect(api.actions()).toStrictEqual([
      {
        type: 'resolvePermission',
        requestId: 'perm-1',
        decision: { behavior: 'allow', ruleId: null },
      },
      {
        type: 'resolvePermission',
        requestId: 'perm-1',
        decision: { behavior: 'deny', message: 'Denied from Overlord', ruleId: null },
      },
      { type: 'alwaysAllowPermission', requestId: 'perm-1' },
    ]);
  });
});

describe('auto-approve rules', () => {
  it('lists rules and toggles and deletes them', async () => {
    const { api } = renderView(<LauncherView state={launcherState} />);
    const rules = within(region('Auto-approve rules'));
    expect(rules.getByText('Deny rules always win. Every auto-approval is logged.')).toBeDefined();
    expect(rules.getByText('any')).toBeDefined();
    expect(rules.getByText('rm *')).toBeDefined();
    const read = rules.getByRole('checkbox', { name: 'Enable rule for Read' });
    const bash = rules.getByRole('checkbox', { name: 'Enable rule for Bash' });
    expect(read).toHaveProperty('checked', true);
    expect(bash).toHaveProperty('checked', false);
    await userEvent.click(read);
    await userEvent.click(bash);
    await userEvent.click(rules.getByRole('button', { name: 'Delete rule for Bash' }));
    const [first, second] = launcherState.rules;
    expect(api.actions()).toStrictEqual([
      { type: 'saveRule', rule: { ...first, enabled: false } },
      { type: 'saveRule', rule: { ...second, enabled: true } },
      { type: 'deleteRule', ruleId: 'rule-2' },
    ]);
  });

  it('adds a rule and clears the form', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { api } = renderView(<LauncherView state={launcherState} />);
    const rules = within(region('Auto-approve rules'));
    const add = rules.getByRole('button', { name: 'Add rule' });
    expect(add).toHaveProperty('disabled', true);
    const tool = rules.getByRole('textbox', { name: 'Tool' });
    await userEvent.type(tool, ' Grep ');
    const action = rules.getByRole('combobox', { name: 'Action' });
    await userEvent.selectOptions(action, 'deny');
    await userEvent.type(rules.getByRole('textbox', { name: 'Note' }), ' No grep ');
    await userEvent.click(add);
    await userEvent.type(tool, 'Read');
    await userEvent.type(rules.getByRole('textbox', { name: 'Command or path' }), 'src/**');
    await userEvent.selectOptions(action, 'allow');
    await userEvent.click(add);
    expect(api.actions()).toStrictEqual([
      {
        type: 'saveRule',
        rule: {
          id: 'rule-rs',
          enabled: true,
          behavior: 'deny',
          tool: 'Grep',
          pattern: null,
          description: 'No grep',
        },
      },
      {
        type: 'saveRule',
        rule: {
          id: 'rule-rs',
          enabled: true,
          behavior: 'allow',
          tool: 'Read',
          pattern: 'src/**',
          description: '',
        },
      },
    ]);
    expect(tool).toHaveProperty('value', '');
  });
});
