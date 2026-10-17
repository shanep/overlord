// Cell text is concatenated in assertions. cspell:ignore projectclaude userclaude faston deepnot
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { KnobsState } from '../../../src/shared/protocol.js';
import { knobsState } from '../../test/fixtures-context.js';
import { expectAccessible, FakeApi, renderView } from '../../test/render.js';

import { KnobsView } from './knobs-view.js';

const ALL_AREAS = ['model', 'thinking', 'permissions', 'bash', 'sessions', 'ui', 'other'];

function region(name: string | RegExp): HTMLElement {
  return screen.getByRole('region', { name });
}

async function expand(key: string): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: `Details for ${key}` }));
}

function renderOpen(
  state: KnobsState = knobsState,
  saved: Record<string, unknown> = {},
): ReturnType<typeof renderView> {
  return renderView(
    <KnobsView state={state} />,
    new FakeApi({ 'knobs.openAreas': ALL_AREAS, ...saved }),
  );
}

function areaToggles(): (string | null)[] {
  return screen
    .getAllByRole('button', { expanded: false })
    .filter((button) => button.classList.contains('area-toggle'))
    .map((button) => button.textContent);
}

describe('KnobsView', () => {
  it('shows the files, folded areas in area order, and passes axe', async () => {
    const { container } = renderView(<KnobsView state={knobsState} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Knobs' })).toBeDefined();
    expect(screen.getByText('10 keys, 5 set')).toBeDefined();
    expect(areaToggles()).toStrictEqual([
      '▸ Model and output',
      '▸ Thinking and effort',
      '▸ Permissions',
      '▸ Bash and sandbox',
      '▸ Sessions and print mode',
      '▸ Interface',
    ]);
    expect(within(region('Model and output')).getByText('2 keys')).toBeDefined();
    expect(within(region('Model and output')).getByText('2 set')).toBeDefined();
    expect(within(region('Thinking and effort')).queryByText(/set$/u)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Details for model' })).toBeNull();
    await expectAccessible(container);
  });

  it('opens and folds an area and remembers it', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    const toggle = screen.getByRole('button', { name: 'Model and output' });
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Details for model' })).toBeDefined();
    expect(api.saved).toStrictEqual({ 'knobs.openAreas': ['model'] });
    await userEvent.click(toggle);
    expect(screen.queryByRole('button', { name: 'Details for model' })).toBeNull();
  });

  it('shows values, layers, profiles and badges, and composes object settings', async () => {
    const { container } = renderOpen();
    const model = within(region('Model and output'));
    expect(model.getByText('claude-opus-4-7')).toBeDefined();
    expect(model.getByText('project')).toBeDefined();
    expect(model.getAllByText('applies next launch')).toHaveLength(2);
    const bash = within(region('Bash and sandbox'));
    expect(bash.getByText('50000')).toBeDefined();
    expect(bash.getAllByText('env')).toHaveLength(2);
    const permissions = within(region('Permissions'));
    expect(permissions.getByText('{"allow":["Bash(ls)"]}')).toBeDefined();
    expect(permissions.getByText('managed only')).toBeDefined();
    expect(permissions.getByText('applies live')).toBeDefined();
    expect(within(region('Thinking and effort')).getByText('false (default)')).toBeDefined();
    expect(within(region('Interface')).getByText('in Fast')).toBeDefined();
    expect(within(region('Sessions and print mode')).getByText('not in a profile')).toBeDefined();
    await expectAccessible(container);
  });

  it('filters by search text, opens every match and saves the query', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    const search = screen.getByRole('searchbox', { name: 'Search' });
    await userEvent.type(search, 'shell output');
    expect(
      screen.getByRole('button', { name: 'Details for BASH_MAX_OUTPUT_LENGTH' }),
    ).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Model and output' })).toBeNull();
    expect(api.saved).toStrictEqual({ 'knobs.query': 'shell output' });
    await userEvent.clear(search);
    await userEvent.type(search, 'zzz');
    expect(screen.getByText('No knobs match.')).toBeDefined();
    expect(within(region('Not in the docs')).getByText('0 keys')).toBeDefined();
  });

  it('narrows to one kind and keeps the choice', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    const flags = screen.getByRole('button', { name: 'CLI flags' });
    await userEvent.click(flags);
    expect(flags.getAttribute('aria-pressed')).toBe('true');
    expect(areaToggles()).toStrictEqual(['▸ Sessions and print mode', '▸ Interface']);
    expect(screen.queryByRole('region', { name: 'Not in the docs' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Env vars' }));
    expect(areaToggles()).toStrictEqual(['▸ Bash and sandbox']);
    expect(within(region('Not in the docs')).getByText('1 key')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(within(region('Not in the docs')).getByText('0 keys')).toBeDefined();
    expect(api.saved).toMatchObject({ 'knobs.kind': 'setting' });
  });

  it('shows only what is set, and removed keys on request', async () => {
    renderView(<KnobsView state={knobsState} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only what is set' }));
    const listed = screen
      .getAllByRole('button', { name: /^Details for / })
      .map((button) => button.getAttribute('aria-label'));
    expect(listed).toStrictEqual([
      'Details for env',
      'Details for model',
      'Details for permissions',
      'Details for BASH_MAX_OUTPUT_LENGTH',
      'Details for --verbose',
      'Details for env.MY_VAR',
    ]);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only what is set' }));
    expect(screen.queryByRole('region', { name: 'Other' })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include removed keys' }));
    await userEvent.click(screen.getByRole('button', { name: 'Other' }));
    expect(within(region('Other')).getByText('removed')).toBeDefined();
  });

  it('restores the saved filters and expanded keys', () => {
    renderOpen(knobsState, {
      'knobs.query': 'think',
      'knobs.expanded': ['alwaysThinkingEnabled'],
    });
    const toggle = screen.getByRole('button', { name: 'Details for alwaysThinkingEnabled' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('No layer sets this key. The default applies.')).toBeDefined();
  });

  it('shows the full chain, opens a layer file and removes a key from a layer', async () => {
    const { api } = renderOpen();
    await expand('model');
    const chain = screen.getByRole('table', { name: 'Layers that set this key' });
    const rows = within(chain)
      .getAllByRole('row')
      .map((row) => row.textContent);
    expect(rows).toStrictEqual([
      'LayerValueFileActions',
      'projectclaude-opus-4-7/repo/.claude/settings.jsonRemove',
      'userclaude-sonnet-4-6/Users/dev/.claude/settings.jsonRemove',
    ]);
    await userEvent.click(
      within(chain).getByRole('button', { name: '/repo/.claude/settings.json' }),
    );
    await userEvent.click(within(chain).getByRole('button', { name: 'Remove model from user' }));
    expect(api.actions()).toStrictEqual([
      { type: 'openFile', path: '/repo/.claude/settings.json' },
      { type: 'setKnob', key: 'model', value: null, layer: 'user', agent: 'claude-code' },
    ]);
    await expand('model');
    expect(screen.queryByRole('table', { name: 'Layers that set this key' })).toBeNull();
  });

  it('shows none and no remove button for the process env layer', async () => {
    renderOpen();
    await expand('BASH_MAX_OUTPUT_LENGTH');
    const chain = screen.getByRole('table', { name: 'Layers that set this key' });
    expect(within(chain).getByText('none')).toBeDefined();
    expect(within(chain).queryByRole('button', { name: /^Remove/u })).toBeNull();
  });

  it('edits the layer that sets the value and loads each layer value', async () => {
    const { api } = renderOpen();
    await expand('model');
    const model = within(region('Model and output'));
    const layer = model.getByRole('combobox', { name: 'Layer' });
    const input = model.getByRole('textbox', { name: 'Value for model' });
    expect(layer).toHaveProperty('value', 'project');
    expect(input).toHaveProperty('value', 'claude-opus-4-7');
    await userEvent.selectOptions(layer, 'user');
    expect(input).toHaveProperty('value', 'claude-sonnet-4-6');
    await userEvent.selectOptions(layer, 'project-local');
    expect(input).toHaveProperty('value', 'claude-opus-4-7');
    fireEvent.change(layer, { target: { value: 'bogus' } });
    expect(layer).toHaveProperty('value', 'project-local');
    await userEvent.clear(input);
    await userEvent.type(input, 'claude-haiku-4-5');
    await userEvent.click(model.getByRole('button', { name: 'Save' }));
    expect(api.actions()).toStrictEqual([
      {
        type: 'setKnob',
        key: 'model',
        value: 'claude-haiku-4-5',
        layer: 'project-local',
        agent: 'claude-code',
      },
    ]);
  });

  it('sets a boolean from a select', async () => {
    const { api } = renderOpen();
    await expand('alwaysThinkingEnabled');
    const select = screen.getByRole('combobox', { name: 'Value for alwaysThinkingEnabled' });
    expect(select).toHaveProperty('value', 'false');
    await userEvent.selectOptions(select, 'true');
    await userEvent.click(
      within(region('Thinking and effort')).getByRole('button', { name: 'Save' }),
    );
    expect(api.actions()).toStrictEqual([
      {
        type: 'setKnob',
        key: 'alwaysThinkingEnabled',
        value: true,
        layer: 'user',
        agent: 'claude-code',
      },
    ]);
  });

  it('writes env vars as strings and blocks a bad number', async () => {
    const { api } = renderOpen();
    await expand('BASH_MAX_OUTPUT_LENGTH');
    const input = screen.getByRole('spinbutton', { name: 'Value for BASH_MAX_OUTPUT_LENGTH' });
    expect(input).toHaveProperty('value', '50000');
    await userEvent.clear(input);
    expect(screen.getByRole('alert').textContent).toBe('Enter a number.');
    const bash = within(region('Bash and sandbox'));
    expect(bash.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    await userEvent.type(input, '1234');
    await userEvent.click(bash.getByRole('button', { name: 'Save' }));
    expect(api.actions()).toStrictEqual([
      {
        type: 'setKnob',
        key: 'BASH_MAX_OUTPUT_LENGTH',
        value: '1234',
        layer: 'user',
        agent: 'claude-code',
      },
    ]);
  });

  it('picks an enum value', async () => {
    const { api } = renderOpen();
    await expand('permissions.defaultMode');
    const select = screen.getByRole('combobox', { name: 'Value for permissions.defaultMode' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toStrictEqual(['default', 'acceptEdits', 'plan']);
    await userEvent.selectOptions(select, 'plan');
    await userEvent.click(within(region('Permissions')).getByRole('button', { name: 'Save' }));
    expect(api.actions()).toStrictEqual([
      {
        type: 'setKnob',
        key: 'permissions.defaultMode',
        value: 'plan',
        layer: 'user',
        agent: 'claude-code',
      },
    ]);
  });

  it('edits the env object the env vars make up, and shows a JSON error inline', async () => {
    const { api } = renderOpen();
    await expand('env');
    const area = screen.getByRole('textbox', { name: 'Value for env' });
    expect(JSON.parse((area as HTMLTextAreaElement).value)).toStrictEqual({ MY_VAR: 'hello' });
    await userEvent.clear(area);
    expect(screen.getByRole('alert').textContent).toBe('Not valid JSON.');
    await userEvent.click(area);
    await userEvent.paste('{"DEBUG":"1"}');
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(within(region('Model and output')).getByRole('button', { name: 'Save' }));
    expect(api.actions()).toStrictEqual([
      { type: 'setKnob', key: 'env', value: { DEBUG: '1' }, layer: 'user', agent: 'claude-code' },
    ]);
  });

  it('keeps managed only knobs read only', async () => {
    const { api } = renderOpen();
    await expand('additionalDirectories');
    expect(screen.getByText('Read only. Only managed policy can set this key.')).toBeDefined();
    expect(api.posted).toStrictEqual([]);
  });

  it('saves a comma separated list as an array', async () => {
    const state: KnobsState = {
      ...knobsState,
      catalog: knobsState.catalog.map((knob) =>
        knob.key === 'additionalDirectories' ? { ...knob, managedOnly: false } : knob,
      ),
    };
    const { api } = renderOpen(state);
    await expand('additionalDirectories');
    const input = screen.getByRole('textbox', { name: 'Value for additionalDirectories' });
    expect(input.getAttribute('placeholder')).toBe('a, b, c');
    await userEvent.type(input, '/tmp, /data');
    await userEvent.click(within(region('Permissions')).getByRole('button', { name: 'Save' }));
    expect(api.actions()).toStrictEqual([
      {
        type: 'setKnob',
        key: 'additionalDirectories',
        value: ['/tmp', '/data'],
        layer: 'user',
        agent: 'claude-code',
      },
    ]);
  });

  it('opens the docs page for a knob', async () => {
    const { api } = renderOpen();
    await expand('model');
    await userEvent.click(screen.getByRole('button', { name: 'Docs for model' }));
    expect(api.actions()).toStrictEqual([
      { type: 'openKnobDocs', key: 'model', kind: 'setting', agent: 'claude-code' },
    ]);
  });

  it('adds a bare CLI flag to a profile and removes it from another', async () => {
    const { api } = renderOpen();
    await expand('--verbose');
    const table = screen.getByRole('table', { name: 'Launch profiles that pass --verbose' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toStrictEqual(['ProfileValueActions', 'FastonUpdate Remove', 'Deepnot passedAdd']);
    expect(screen.queryByRole('checkbox', { name: 'Value for --verbose' })).toBeNull();
    await userEvent.click(within(table).getByRole('button', { name: 'Add --verbose in Deep' }));
    await userEvent.click(
      within(table).getByRole('button', { name: 'Remove --verbose from Fast' }),
    );
    const [fast, deep] = knobsState.profiles;
    expect(api.actions()).toStrictEqual([
      { type: 'saveProfile', profile: { ...deep, extraArgs: ['--verbose'] } },
      { type: 'saveProfile', profile: { ...fast, extraArgs: [] } },
    ]);
  });

  it('adds a CLI flag with a value', async () => {
    const { api } = renderOpen();
    await expand('--max-turns');
    await userEvent.type(screen.getByRole('spinbutton', { name: 'Value for --max-turns' }), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Add --max-turns in Fast' }));
    const [fast] = knobsState.profiles;
    expect(api.actions()).toStrictEqual([
      { type: 'saveProfile', profile: { ...fast, extraArgs: ['--verbose', '--max-turns=5'] } },
    ]);
  });

  it('points to the profiles tab when there are no profiles for a flag', async () => {
    renderOpen({ ...knobsState, profiles: [] });
    await expand('--verbose');
    expect(screen.getByText(/Make a launch profile in the Launch profiles tab/u)).toBeDefined();
  });

  it('lists keys the docs do not cover and adds an env var', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    const unlisted = within(region('Not in the docs'));
    expect(unlisted.getByText('env.MY_VAR')).toBeDefined();
    expect(unlisted.getByText('hello')).toBeDefined();
    const name = unlisted.getByRole('textbox', { name: 'Name' });
    await userEvent.type(name, '9BAD');
    expect(unlisted.getByRole('alert').textContent).toMatch(/letters, digits and underscores/u);
    expect(unlisted.getByRole('button', { name: 'Add env var' })).toHaveProperty('disabled', true);
    await userEvent.clear(name);
    await userEvent.type(name, 'NEW_VAR');
    await userEvent.type(unlisted.getByRole('textbox', { name: 'Value' }), 'on');
    await userEvent.selectOptions(unlisted.getByRole('combobox', { name: 'Layer' }), 'project');
    fireEvent.change(unlisted.getByRole('combobox', { name: 'Layer' }), {
      target: { value: 'bogus' },
    });
    await userEvent.click(unlisted.getByRole('button', { name: 'Add env var' }));
    expect(api.actions()).toStrictEqual([
      { type: 'setKnob', key: 'env.NEW_VAR', value: 'on', layer: 'project', agent: 'claude-code' },
    ]);
    expect(name).toHaveProperty('value', '');
  });

  it('edits and removes an unlisted key, with no docs link', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    await expand('env.MY_VAR');
    const unlisted = within(region('Not in the docs'));
    expect(unlisted.queryByRole('button', { name: 'Docs for env.MY_VAR' })).toBeNull();
    await userEvent.click(unlisted.getByRole('button', { name: 'Remove env.MY_VAR from user' }));
    expect(api.actions()).toStrictEqual([
      { type: 'setKnob', key: 'env.MY_VAR', value: null, layer: 'user', agent: 'claude-code' },
    ]);
  });

  it('shows an area the shared list does not know by its own name', async () => {
    const state: KnobsState = {
      ...knobsState,
      catalog: [
        {
          key: 'zz',
          kind: 'setting',
          area: 'zeta',
          valueType: 'string',
          defaultValue: null,
          allowed: [],
          description: 'Odd one.',
          docUrl: 'https://example.com',
          appliesAt: 'next-launch',
          managedOnly: false,
        },
      ],
    };
    renderView(<KnobsView state={state} />);
    await userEvent.click(screen.getByRole('button', { name: 'zeta' }));
    expect(within(region('zeta')).getByText('1 key')).toBeDefined();
    // Only the row's own description, since an unknown area has no summary line.
    expect(region('zeta').querySelectorAll('p.card-text')).toHaveLength(1);
  });

  it('lists the settings files and opens one that exists', async () => {
    const state: KnobsState = {
      ...knobsState,
      files: [
        ...knobsState.files,
        { layer: 'managed', file: '/etc/managed.json', exists: false, keys: 0, error: 'Bad JSON' },
      ],
    };
    const { api } = renderView(<KnobsView state={state} />);
    const files = within(region(/^Settings files/u));
    expect(files.getByText('/etc/managed.json (not created yet)')).toBeDefined();
    expect(files.getByRole('alert').textContent).toContain('Bad JSON');
    await userEvent.click(files.getByRole('button', { name: '/Users/dev/.claude/settings.json' }));
    expect(api.actions()).toStrictEqual([
      { type: 'openFile', path: '/Users/dev/.claude/settings.json' },
    ]);
  });

  it('switches to the profiles and feature flags tabs and remembers the tab', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    await userEvent.click(screen.getByRole('button', { name: 'Launch profiles (2)' }));
    expect(screen.getByRole('heading', { name: 'Launch profiles' })).toBeDefined();
    expect(screen.queryByRole('region', { name: /^Settings files/u })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Feature flags (2)' }));
    expect(screen.getByRole('table', { name: 'Cached feature flags, read only' })).toBeDefined();
    expect(api.saved).toStrictEqual({ 'knobs.tab': 'flags' });
    await userEvent.click(screen.getByRole('button', { name: 'Keys' }));
    expect(region(/^Settings files/u)).toBeDefined();
  });
});
