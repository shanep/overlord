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
  defaultFolder: '/work',
  folders: [{ name: 'work', folder: '/work', source: 'window' }],
  browsed: null,
  worktrees: [],
};

describe('LauncherView', () => {
  it('renders every section and passes axe', async () => {
    const { container } = renderView(<LauncherView state={launcherState} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Launcher' })).toBeDefined();
    // A waiting request goes above the runs it holds up.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toStrictEqual([
      'New run',
      'Permission inbox 1',
      'Runs',
      'Worktrees',
      'Auto-approve rules',
    ]);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toStrictEqual([
      'What should it do?',
      'Which profiles?',
      'Where?',
      'Name and limit (optional)',
    ]);
    expect(screen.getByText(/use the sparkle button/u)).toBeDefined();
    await expectAccessible(container);
  });

  it('renders an empty state for every section and passes axe', async () => {
    const { container } = renderView(<LauncherView state={empty} />);
    expect(screen.queryByRole('combobox', { name: 'Load draft' })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toStrictEqual([
      'New run',
      'Runs',
      'Worktrees',
      'Permission inbox 0',
      'Auto-approve rules',
    ]);
    expect(screen.getByText(/No profiles yet/u)).toBeDefined();
    expect(screen.getByText('No runs yet. Launch one above and it shows up here.')).toBeDefined();
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
    expect(launch.getAttribute('aria-describedby')).toBe('launch-summary');
    expect(screen.getByText('Write a prompt to launch.')).toBeDefined();
    await userEvent.type(screen.getByRole('textbox', { name: 'Prompt' }), ' '.repeat(3));
    expect(launch).toHaveProperty('disabled', true);
  });

  it('says what Launch will do and which folder it runs in', async () => {
    renderView(<LauncherView state={launcherState} />);
    const folder = screen.getByRole('combobox', { name: 'Folder' });
    expect(folder).toHaveProperty('value', '/work');
    expect(screen.getByText('/work', { selector: '.launch-path' })).toBeDefined();
    await userEvent.type(screen.getByRole('textbox', { name: 'Prompt' }), 'Go');
    expect(
      screen.getByText(
        'Starts 1 run with your usual settings, in its own copy of /work, with no spending limit.',
      ),
    ).toBeDefined();
    await userEvent.selectOptions(folder, '/repo');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Fast' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Deep' }));
    await userEvent.type(screen.getByRole('spinbutton', { name: 'Budget (USD)' }), '2');
    expect(
      screen.getByText(
        'Starts 2 runs, one each for Fast and Deep, each in its own copy of /repo, stopping each one at $2.00.',
      ),
    ).toBeDefined();
  });

  it('sends you to Knobs to make a profile when there are none', async () => {
    const { api } = renderView(<LauncherView state={empty} />);
    await userEvent.click(screen.getByRole('button', { name: 'Make a profile' }));
    expect(api.actions()).toStrictEqual([{ type: 'openView', view: 'knobs' }]);
  });

  it('launches a matrix run across the checked profiles', async () => {
    const { api } = renderView(<LauncherView state={launcherState} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Prompt' }), 'Fix it');
    await userEvent.type(screen.getByRole('textbox', { name: 'Label' }), 'Fixer');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Folder' }), '/repo');
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
    expect(screen.getByRole('combobox', { name: 'Folder' })).toHaveProperty('value', '/saved');
    expect(screen.getByRole('group', { name: 'Used before' })).toBeDefined();
    expect(screen.getByRole('checkbox', { name: 'Deep' })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'Fast' })).toHaveProperty('checked', false);
  });
});

describe('folder picker', () => {
  it('groups this window and the open projects, and ends with Browse', () => {
    renderView(<LauncherView state={launcherState} />);
    const folder = screen.getByRole('combobox', { name: 'Folder' });
    expect(
      within(folder)
        .getAllByRole('group')
        .map((group) => group.getAttribute('label')),
    ).toStrictEqual(['This window', 'Open projects']);
    expect(
      within(folder)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toStrictEqual(['work', 'repo', 'Browse…']);
  });

  it('asks the host to browse and keeps the folder until one comes back', async () => {
    const { api } = renderView(<LauncherView state={launcherState} />);
    const folder = screen.getByRole('combobox', { name: 'Folder' });
    await userEvent.selectOptions(folder, 'Browse…');
    expect(api.actions()).toStrictEqual([{ type: 'browseLaunchFolder' }]);
    expect(folder).toHaveProperty('value', '/work');
  });

  it('selects a folder picked with Browse once, and not again after you change it', async () => {
    const browsed: LauncherState = {
      ...launcherState,
      folders: [...launcherState.folders, { name: 'other', folder: '/other', source: 'browsed' }],
      browsed: { folder: '/other', at: 5 },
    };
    const { api } = renderView(<LauncherView state={browsed} />);
    const folder = screen.getByRole('combobox', { name: 'Folder' });
    expect(folder).toHaveProperty('value', '/other');
    expect(screen.getByRole('group', { name: 'Picked with Browse' })).toBeDefined();
    await userEvent.selectOptions(folder, '/repo');
    expect(folder).toHaveProperty('value', '/repo');
    expect(api.saved).toMatchObject({ 'launcher.cwd': '/repo', 'launcher.browsedAt': 5 });
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
      'Flaky testFastrunning$0.30 est.41m 35sn/ar1Agent viewStop',
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

  it('opens the agent view of a run that has a session, and shows its whole result on hover', async () => {
    const { api } = renderView(<LauncherView state={launcherState} />);
    expect(screen.getAllByRole('button', { name: /^Agent view for Flaky test$/u })).toHaveLength(1);
    expect(screen.getByText('Fixed by adding a wait.')).toHaveProperty(
      'title',
      'Fixed by adding a wait.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Agent view for Flaky test' }));
    expect(api.actions()).toStrictEqual([{ type: 'openAgent', sessionId: 's9', agentId: 's9' }]);
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
    const inbox = within(region('Permission inbox 1'));
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
    expect(rules.getByText(/Deny rules always win/u)).toBeDefined();
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
