import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { PropertiesState } from '../../../src/shared/protocol.js';
import { codexAgent, twoAgents } from '../../test/fixtures-agents.js';
import { launcherState, sessionsState } from '../../test/fixtures-tools.js';
import { agentState, session } from '../../test/fixtures.js';
import { renderView } from '../../test/render.js';

import { AgentView } from './agent-view.js';
import { LauncherView } from './launcher-view.js';
import { PropertiesView } from './properties-view.js';
import { SessionsView } from './sessions-view.js';

const codexSession = session({ id: 's1', agent: 'codex', title: 'Port the parser' });

describe('views for a session of another agent', () => {
  it('labels the feed, drops subagents and the cache chart, and shows no cost', () => {
    renderView(
      <AgentView state={{ ...agentState, session: codexSession }} />,
      undefined,
      twoAgents,
    );
    expect(screen.queryByRole('heading', { name: /^Subagents/ })).toBeNull();
    expect(screen.queryByText('Cache hit ratio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Interrupt' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.getAllByText('Codex', { selector: '.feed-kind' }).length).toBeGreaterThan(0);
  });

  it('names the agent in Session Properties and leaves out what it lacks', () => {
    const state: PropertiesState = {
      sessionId: 's1',
      session: codexSession,
      agents: [],
      pendingPermissions: [],
      health: null,
    };
    renderView(<PropertiesView state={state} />, undefined, twoAgents);
    expect(screen.getByText('Codex CLI')).toBeDefined();
    expect(screen.queryByText('Effort')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Subagents' })).toBeNull();
  });

  it('says which tab to focus without naming Claude when there is a choice', () => {
    const state: PropertiesState = {
      sessionId: null,
      session: null,
      agents: [],
      pendingPermissions: [],
      health: null,
    };
    renderView(<PropertiesView state={state} />, undefined, twoAgents);
    expect(screen.getByText('No agent tab')).toBeDefined();
  });

  it('hides handoffs the agent does not offer and the claude.ai import without Claude Code', () => {
    const sessions = sessionsState.sessions.map((entry) => ({ ...entry, agent: 'codex' }));
    renderView(<SessionsView state={{ ...sessionsState, sessions }} />, undefined, [codexAgent]);
    expect(screen.queryByRole('button', { name: /^Continue/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import claude.ai export' })).toBeNull();
  });

  it('picks the agent in the Launcher and puts it on the run', async () => {
    const user = userEvent.setup();
    const { api } = renderView(
      <LauncherView state={{ ...launcherState, profiles: [] }} />,
      undefined,
      twoAgents,
    );
    await user.click(screen.getByRole('button', { name: 'Codex CLI' }));
    await user.type(screen.getByRole('textbox', { name: 'Prompt' }), 'Fix the build');
    await user.click(screen.getByRole('button', { name: /^Launch/ }));
    const [action] = api.actions();
    expect(action?.type === 'launch' ? action.specs.map((spec) => spec.agent) : []).toStrictEqual([
      'codex',
    ]);
  });
});
