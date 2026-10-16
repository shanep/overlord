// Cell text is concatenated in assertions. cspell:ignore projectclaude userclaude
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { KnobsState } from '../../../src/shared/protocol.js';
import { knobsState } from '../../test/fixtures-context.js';
import { expectAccessible, FakeApi, renderView } from '../../test/render.js';

import { KnobsView } from './knobs-view.js';

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

async function expand(key: string): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: `Details for ${key}` }));
}

describe('KnobsView', () => {
  it('groups the catalog by area and passes axe', async () => {
    const { container } = renderView(<KnobsView state={knobsState} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Knobs' })).toBeDefined();
    expect(screen.getByText('6 keys')).toBeDefined();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toStrictEqual([
      'bash',
      'model',
      'permissions',
      'thinking',
      'Launch profiles',
      'Feature flags',
    ]);
    await expectAccessible(container);
  });

  it('shows the value, winning layer, applies at and managed badges', () => {
    renderView(<KnobsView state={knobsState} />);
    const model = within(region('model'));
    expect(model.getByText('claude-opus-4-7')).toBeDefined();
    expect(model.getByText('project')).toBeDefined();
    expect(model.getByText('unset')).toBeDefined();
    expect(model.getAllByText('applies next launch')).toHaveLength(2);
    expect(within(region('bash')).getByText('50000')).toBeDefined();
    expect(within(region('bash')).getAllByText('env')).toHaveLength(2);
    const thinking = within(region('thinking'));
    expect(thinking.getByText('false (default)')).toBeDefined();
    expect(thinking.getByText('applies next turn')).toBeDefined();
    expect(within(region('permissions')).getByText('managed only')).toBeDefined();
    expect(within(region('permissions')).getByText('applies live')).toBeDefined();
  });

  it('filters by search text and saves the query', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    const search = screen.getByRole('searchbox', { name: 'Search' });
    await userEvent.type(search, 'shell');
    expect(screen.getByRole('heading', { name: 'bash' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'model' })).toBeNull();
    expect(api.saved).toStrictEqual({ 'knobs.query': 'shell' });
    await userEvent.clear(search);
    await userEvent.type(search, 'zzz');
    expect(screen.getByText('No knobs match.')).toBeDefined();
  });

  it('restores the saved query and expanded keys', () => {
    const api = new FakeApi({
      'knobs.query': 'think',
      'knobs.expanded': ['alwaysThinkingEnabled'],
    });
    renderView(<KnobsView state={knobsState} />, api);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toStrictEqual([
      'thinking',
      'Launch profiles',
      'Feature flags',
    ]);
    const toggle = screen.getByRole('button', { name: 'Details for alwaysThinkingEnabled' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('No layer sets this key. The default applies.')).toBeDefined();
  });

  it('shows the full chain and opens a layer file', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    const toggle = screen.getByRole('button', { name: 'Details for model' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await expand('model');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const chain = screen.getByRole('table', { name: 'Layers that set this key' });
    const rows = within(chain)
      .getAllByRole('row')
      .map((row) => row.textContent);
    expect(rows).toStrictEqual([
      'LayerValueFile',
      'projectclaude-opus-4-7/repo/.claude/settings.json',
      'userclaude-sonnet-4-6/Users/dev/.claude/settings.json',
    ]);
    await userEvent.click(
      within(chain).getByRole('button', { name: '/repo/.claude/settings.json' }),
    );
    expect(api.actions()).toStrictEqual([
      { type: 'openFile', path: '/repo/.claude/settings.json' },
    ]);
    await expand('model');
    expect(screen.queryByRole('table', { name: 'Layers that set this key' })).toBeNull();
    expect(api.saved).toStrictEqual({ 'knobs.expanded': [] });
  });

  it('shows none for a layer with no file', async () => {
    renderView(<KnobsView state={knobsState} />);
    await expand('BASH_MAX_OUTPUT_LENGTH');
    const chain = screen.getByRole('table', { name: 'Layers that set this key' });
    expect(within(chain).getByText('none')).toBeDefined();
  });

  it('sets a string value at the chosen layer', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    await expand('model');
    const input = screen.getByRole('textbox', { name: 'Value for model' });
    expect(input).toHaveProperty('value', 'claude-opus-4-7');
    await userEvent.clear(input);
    await userEvent.type(input, 'claude-haiku-4-5');
    const layer = within(region('model')).getByRole('combobox', { name: 'Layer' });
    await userEvent.selectOptions(layer, 'project-local');
    fireEvent.change(layer, { target: { value: 'bogus' } });
    expect(layer).toHaveProperty('value', 'project-local');
    await userEvent.click(within(region('model')).getByRole('button', { name: 'Save' }));
    expect(api.actions()).toStrictEqual([
      { type: 'setKnob', key: 'model', value: 'claude-haiku-4-5', layer: 'project-local' },
    ]);
  });

  it('sets a boolean from a select', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    await expand('alwaysThinkingEnabled');
    const select = screen.getByRole('combobox', { name: 'Value for alwaysThinkingEnabled' });
    expect(select).toHaveProperty('value', 'false');
    await userEvent.selectOptions(select, 'true');
    await userEvent.click(within(region('thinking')).getByRole('button', { name: 'Save' }));
    expect(api.actions()).toStrictEqual([
      { type: 'setKnob', key: 'alwaysThinkingEnabled', value: true, layer: 'user' },
    ]);
  });

  it('blocks an invalid number and saves a valid one', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    await expand('BASH_MAX_OUTPUT_LENGTH');
    const input = screen.getByRole('spinbutton', { name: 'Value for BASH_MAX_OUTPUT_LENGTH' });
    expect(input).toHaveProperty('value', '50000');
    await userEvent.clear(input);
    expect(screen.getByRole('alert').textContent).toBe('Enter a number.');
    const save = within(region('bash')).getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    await userEvent.type(input, '1234');
    await userEvent.click(within(region('bash')).getByRole('button', { name: 'Save' }));
    expect(api.actions()).toStrictEqual([
      { type: 'setKnob', key: 'BASH_MAX_OUTPUT_LENGTH', value: 1234, layer: 'user' },
    ]);
  });

  it('picks an enum value and parses a string list', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    await expand('permissions.defaultMode');
    const select = screen.getByRole('combobox', { name: 'Value for permissions.defaultMode' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toStrictEqual(['default', 'acceptEdits', 'plan']);
    await userEvent.selectOptions(select, 'plan');
    await userEvent.click(within(region('permissions')).getByRole('button', { name: 'Save' }));
    expect(api.actions()).toStrictEqual([
      { type: 'setKnob', key: 'permissions.defaultMode', value: 'plan', layer: 'user' },
    ]);
  });

  it('parses JSON and shows an inline error when it is invalid', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    await expand('env');
    const area = screen.getByRole('textbox', { name: 'Value for env' });
    expect(area).toHaveProperty('value', '');
    expect(screen.getByRole('alert').textContent).toBe('Not valid JSON.');
    await userEvent.click(area);
    await userEvent.paste('{"DEBUG":"1"}');
    expect(screen.queryByRole('alert')).toBeNull();
    const model = within(region('model'));
    await userEvent.click(model.getByRole('button', { name: 'Save' }));
    expect(api.actions()).toStrictEqual([
      { type: 'setKnob', key: 'env', value: { DEBUG: '1' }, layer: 'user' },
    ]);
  });

  it('keeps managed only knobs read only', async () => {
    const { api } = renderView(<KnobsView state={knobsState} />);
    await expand('additionalDirectories');
    expect(screen.getByText('Read only. Only managed policy can set this key.')).toBeDefined();
    expect(within(region('permissions')).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(api.posted).toStrictEqual([]);
  });

  it('saves a comma separated list as an array', async () => {
    const state: KnobsState = {
      ...knobsState,
      catalog: knobsState.catalog.map((knob) =>
        knob.key === 'additionalDirectories' ? { ...knob, managedOnly: false } : knob,
      ),
    };
    const { api } = renderView(<KnobsView state={state} />);
    await expand('additionalDirectories');
    const input = screen.getByRole('textbox', { name: 'Value for additionalDirectories' });
    expect(input.getAttribute('placeholder')).toBe('a, b, c');
    await userEvent.type(input, '/tmp, /data');
    await userEvent.click(within(region('permissions')).getByRole('button', { name: 'Save' }));
    expect(api.actions()).toStrictEqual([
      { type: 'setKnob', key: 'additionalDirectories', value: ['/tmp', '/data'], layer: 'user' },
    ]);
  });
});
