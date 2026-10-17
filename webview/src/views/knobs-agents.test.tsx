import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import type { KnobDefinition, LaunchProfile } from '../../../src/shared/model.js';
import type { KnobsState } from '../../../src/shared/protocol.js';
import { codexAgent, twoAgents } from '../../test/fixtures-agents.js';
import { knobsState } from '../../test/fixtures-context.js';
import { expectAccessible, FakeApi, renderView } from '../../test/render.js';
import { AgentsProvider } from '../agents.js';
import { CLAUDE_FALLBACK } from '../claude-fallback.js';
import { VsCodeProvider } from '../vscode-context.js';

import { KnobsView } from './knobs-view.js';

const DOCS = 'https://learn.chatgpt.com/docs/config-file/config-reference';

function knob(key: string, kind: KnobDefinition['kind'], area = 'model'): KnobDefinition {
  return {
    key,
    kind,
    area,
    valueType: kind === 'flag' ? 'boolean' : 'string',
    defaultValue: null,
    allowed: [],
    description: `About ${key}.`,
    docUrl: DOCS,
    appliesAt: 'next-launch',
    managedOnly: false,
  };
}

function profile(id: string, agent: string): LaunchProfile {
  return {
    id,
    name: id,
    agent,
    model: null,
    effort: null,
    permissionMode: null,
    env: {},
    extraArgs: [],
  };
}

const codexState: KnobsState = {
  agent: 'codex',
  knobAgents: ['claude-code', 'codex'],
  writableLayers: ['user', 'project'],
  envInSettings: false,
  settingsFile: 'config.toml',
  instructionsFile: 'AGENTS.md',
  catalog: [
    knob('model', 'setting'),
    knob('--search', 'flag'),
    knob('project_doc_max_bytes', 'setting', 'memory'),
  ],
  effective: [
    {
      key: 'model',
      value: 'gpt-5',
      layer: 'user',
      chain: [{ layer: 'user', value: 'gpt-5', file: '/home/me/.codex/config.toml' }],
    },
  ],
  profiles: [profile('Deep', 'claude-code'), profile('Codex fast', 'codex')],
  files: [
    { layer: 'user', file: '/home/me/.codex/config.toml', exists: true, keys: 1, error: null },
  ],
  featureFlags: {},
};

function renderCodex(): ReturnType<typeof renderView> {
  return renderView(
    <KnobsView state={codexState} />,
    new FakeApi({ 'knobs.openAreas': ['model'], 'knobs.tab': 'flags' }),
    twoAgents,
  );
}

function layerIn(area: HTMLElement): HTMLElement {
  return within(area).getByRole('combobox', { name: 'Layer' });
}

describe('KnobsView agent pick', () => {
  it('stays hidden with only one agent that has knobs', () => {
    renderView(<KnobsView state={knobsState} />, new FakeApi(), twoAgents);
    expect(screen.queryByRole('group', { name: 'Agent' })).toBeNull();
  });

  it('names each agent and asks the host for the one picked', async () => {
    const state = { ...knobsState, knobAgents: ['claude-code', 'codex'] };
    const { api } = renderView(<KnobsView state={state} />, new FakeApi(), twoAgents);
    const pick = screen.getByRole('group', { name: 'Agent' });
    const claude = within(pick).getByRole('button', { name: 'Claude Code' });
    expect(claude.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(within(pick).getByRole('button', { name: 'Codex CLI' }));
    expect(api.actions()).toStrictEqual([{ type: 'pickKnobsAgent', agent: 'codex' }]);
  });

  it('shows Codex in its own words, with its layers and no feature flags', async () => {
    const { container } = renderCodex();
    const pick = screen.getByRole('group', { name: 'Agent' });
    const codex = within(pick).getByRole('button', { name: 'Codex CLI' });
    expect(codex.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: /Feature flags/u })).toBeNull();
    expect(screen.getByRole('list', { name: 'Settings files Codex CLI reads' })).toBeDefined();
    expect(screen.getByText(/changes only that key in the config\.toml/u)).toBeDefined();
    expect(screen.getByText(/Codex reads env vars only from the shell/u)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Add env var' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Memory and AGENTS.md' })).toBeDefined();
    expect(screen.getByText('Memory and the AGENTS.md files it reads.')).toBeDefined();
    // Claude Code is named only in the pick.
    expect(container.textContent.replace(/Claude Code/u, '')).not.toMatch(/Claude/u);
    await expectAccessible(container);
  });

  it('saves, removes and opens docs for the agent shown, on its own layers', async () => {
    const { api } = renderCodex();
    await userEvent.click(screen.getByRole('button', { name: 'Details for model' }));
    const layer = screen.getByRole('combobox', { name: 'Layer' });
    expect(
      within(layer)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toStrictEqual(['user', 'project']);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove model from user' }));
    await userEvent.click(screen.getByRole('button', { name: 'Docs for model' }));
    expect(api.actions()).toStrictEqual([
      { type: 'setKnob', key: 'model', value: 'gpt-5', layer: 'user', agent: 'codex' },
      { type: 'setKnob', key: 'model', value: null, layer: 'user', agent: 'codex' },
      { type: 'openKnobDocs', key: 'model', kind: 'setting', agent: 'codex' },
    ]);
  });

  it('starts an open editor over on the layers of the agent switched to', async () => {
    const api = new FakeApi({ 'knobs.openAreas': ['model'] });
    const claude = { ...knobsState, knobAgents: ['claude-code', 'codex'] };
    const wrap = (state: KnobsState): ReactElement => (
      <VsCodeProvider api={api}>
        <AgentsProvider agents={twoAgents}>
          <KnobsView state={state} />
        </AgentsProvider>
      </VsCodeProvider>
    );
    const { rerender } = render(wrap(claude));
    await userEvent.click(screen.getByRole('button', { name: 'Details for model' }));
    await userEvent.selectOptions(
      layerIn(screen.getByRole('region', { name: 'Model and output' })),
      'project-local',
    );
    rerender(wrap(codexState));
    const area = screen.getByRole('region', { name: 'Model and output' });
    await userEvent.click(within(area).getByRole('button', { name: 'Save' }));
    expect(api.actions().at(-1)).toStrictEqual({
      type: 'setKnob',
      key: 'model',
      value: 'gpt-5',
      layer: 'user',
      agent: 'codex',
    });
  });

  it('puts a flag only in the profiles of the agent shown', async () => {
    renderCodex();
    await userEvent.click(screen.getByRole('button', { name: 'Details for --search' }));
    const table = screen.getByRole('table', { name: 'Launch profiles that pass --search' });
    expect(within(table).getByText('Codex fast')).toBeDefined();
    expect(within(table).queryByText('Deep')).toBeNull();
  });

  it('starts a new profile on the agent shown', async () => {
    renderView(<KnobsView state={codexState} />, new FakeApi({ 'knobs.tab': 'profiles' }), [
      CLAUDE_FALLBACK,
      codexAgent,
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'New profile' }));
    const form = screen.getByRole('group', { name: 'New profile' });
    expect(within(form).getByRole('combobox', { name: 'Agent' })).toHaveProperty('value', 'codex');
  });
});
