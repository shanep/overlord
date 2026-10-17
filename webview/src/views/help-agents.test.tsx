import { within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AgentInfo } from '../../../src/shared/agents.js';
import { codexAgent, twoAgents } from '../../test/fixtures-agents.js';
import { expectAccessible, renderView } from '../../test/render.js';
import { CLAUDE_FALLBACK } from '../claude-fallback.js';

import { AgentsSection, FEATURES } from './help-agents.js';
import { HelpView } from './help-view.js';

const codexOnly: readonly AgentInfo[] = [
  { ...CLAUDE_FALLBACK, installed: false, capabilities: codexAgent.capabilities },
  codexAgent,
];

describe('AgentsSection', () => {
  it('gives every known agent a column and every feature a row', () => {
    const { getByRole } = renderView(<AgentsSection />, undefined, twoAgents);
    const table = getByRole('table', { name: 'What works for each agent' });
    const heads = within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(heads).toStrictEqual(['Feature', 'Claude', 'Codex']);
    expect(within(table).getAllByRole('row')).toHaveLength(FEATURES.length + 1);
    const background = within(table).getByRole('row', { name: /Background jobs/u });
    expect(
      within(background)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toStrictEqual(['Background jobs', 'Yes', 'No']);
  });

  it('writes the Claude lifecycle only for an agent that runs background jobs', () => {
    const shown = renderView(<AgentsSection />, undefined, twoAgents);
    expect(shown.getByText('claude --bg')).toBeDefined();
    expect(shown.getByText(/Import claude.ai Export/u)).toBeDefined();
    shown.unmount();
    const hidden = renderView(<AgentsSection />, undefined, codexOnly);
    expect(hidden.queryByText('claude --bg')).toBeNull();
    expect(hidden.getByText(/rollout files in ~\/.codex\/sessions/u)).toBeDefined();
    expect(hidden.getByText(/New session above the Fleet starts Codex/u)).toBeDefined();
    expect(hidden.getByText(/\(not found on PATH\)/u)).toBeDefined();
  });

  it('has no accessibility violations', async () => {
    const { container, getByRole } = renderView(<AgentsSection />, undefined, twoAgents);
    expect(getByRole('heading', { level: 2, name: 'Agents' })).toBeDefined();
    await expectAccessible(container);
  });
});

describe('HelpView with more than one agent', () => {
  it('names every agent and drops the Claude sections no agent needs', () => {
    const { getByText, queryByRole, getByRole } = renderView(<HelpView />, undefined, codexOnly);
    expect(getByText(/sessions of Claude Code and Codex CLI/u)).toBeDefined();
    expect(queryByRole('region', { name: 'How a Claude Code session works' })).toBeNull();
    expect(queryByRole('region', { name: 'Handoff buttons' })).toBeNull();
    const contents = getByRole('navigation', { name: 'On this page' });
    expect(within(contents).queryByRole('link', { name: 'Handoff buttons' })).toBeNull();
    expect(within(contents).getByRole('link', { name: 'Agents' })).toBeDefined();
  });

  it('keeps the Claude sections while Claude Code can use them', () => {
    const { getByRole } = renderView(<HelpView />, undefined, twoAgents);
    expect(getByRole('region', { name: 'How a Claude Code session works' })).toBeDefined();
    expect(getByRole('region', { name: 'Handoff buttons' })).toBeDefined();
  });
});
