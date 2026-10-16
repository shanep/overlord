// Property text is concatenated in assertions. cspell:ignore Branchmain Modelclaude Efforthigh Permissionsdefault Modelunknown Effortunknown Permissionsunknown Branchunknown Processunknown Bashasked
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { PropertiesState } from '../../../src/shared/protocol.js';
import { agent, NOW, permission, session } from '../../test/fixtures.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { PropertiesView } from './properties-view.js';

const MINUTE = 60_000;

const subagent = agent({
  id: 'a1',
  sessionId: 's1',
  parentAgentId: 's1',
  agentType: 'Explore',
  description: 'Find parser tests',
  currentTool: 'Grep',
});

const full: PropertiesState = {
  sessionId: 's1',
  session: session({ id: 's1', title: 'Refactor parser' }),
  agents: [
    subagent,
    agent({
      id: 'a2',
      sessionId: 's1',
      parentAgentId: 's1',
      agentType: 'Plan',
      description: 'Sketch the fix',
      state: 'done',
    }),
  ],
  pendingPermissions: [{ ...permission, requestedAt: NOW - 2 * MINUTE }],
};

function group(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

describe('PropertiesView', () => {
  it('has no accessibility violations', async () => {
    const { container } = renderView(<PropertiesView state={full} />);
    expect(screen.getAllByRole('region')).toHaveLength(6);
    await expectAccessible(container);
  });

  it('asks for a Claude tab when none is active', () => {
    renderView(
      <PropertiesView
        state={{ sessionId: null, session: null, agents: [], pendingPermissions: [] }}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'No Claude tabFocus a Claude Code tab to see its properties.',
    );
  });

  it('names the session it is waiting for', () => {
    renderView(
      <PropertiesView
        state={{ sessionId: 'new-id', session: null, agents: [], pendingPermissions: [] }}
      />,
    );
    expect(screen.getByText('Waiting for Claude Code')).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain('Session new-id shows up here');
  });

  it('lists the session properties by group', () => {
    renderView(<PropertiesView state={full} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Refactor parser');
    expect(group('Session').textContent).toContain('Ids1');
    expect(group('Session').textContent).toContain('Claude Code2.1.301');
    expect(group('Session').textContent).toContain('Process4242');
    expect(group('Workspace').textContent).toBe('WorkspaceFolder/Users/dev/repos/s1Branchmain');
    expect(group('Model').textContent).toBe(
      'ModelModelclaude-opus-4-7EfforthighPermissionsdefault',
    );
    const usage = group('Usage');
    expect(within(usage).getByRole('meter', { name: 'Context window fill' })).toBeDefined();
    expect(usage.textContent).toContain('Cost$0.42 est.');
  });

  it('says unknown for facts Claude Code has not reported', () => {
    const bare = session({
      id: 's1',
      model: null,
      effort: null,
      permissionMode: null,
      gitBranch: null,
      version: null,
      pid: null,
    });
    renderView(<PropertiesView state={{ ...full, session: bare }} />);
    expect(group('Model').textContent).toBe('ModelModelunknownEffortunknownPermissionsunknown');
    expect(group('Workspace').textContent).toContain('Branchunknown');
    expect(group('Session').textContent).toContain('Processunknown');
  });

  it('shows what the session is waiting on, and nothing when it is not', () => {
    const { unmount } = renderView(<PropertiesView state={full} />);
    expect(group('Waiting on you').textContent).toBe('Waiting on youBashasked 2m ago');
    unmount();
    renderView(<PropertiesView state={{ ...full, pendingPermissions: [] }} />);
    expect(screen.queryByRole('region', { name: 'Waiting on you' })).toBeNull();
  });

  it('opens a subagent, the main thread and the context inspector', async () => {
    const user = userEvent.setup();
    const { api } = renderView(<PropertiesView state={full} />);
    const subagents = group('Subagents');
    expect(
      within(subagents)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toStrictEqual(['Explore: Find parser tests ▶running Grep', 'Plan: Sketch the fix ✓done']);
    await user.click(within(subagents).getByRole('button', { name: 'Explore: Find parser tests' }));
    await user.click(screen.getByRole('button', { name: 'Agent view' }));
    await user.click(screen.getByRole('button', { name: 'Context' }));
    expect(api.actions()).toStrictEqual([
      { type: 'openAgent', sessionId: 's1', agentId: 'a1' },
      { type: 'openAgent', sessionId: 's1', agentId: 's1' },
      { type: 'openContext', sessionId: 's1', agentId: null },
    ]);
  });

  it('says when there are no subagents yet', () => {
    renderView(<PropertiesView state={{ ...full, agents: [] }} />);
    expect(group('Subagents').textContent).toBe('SubagentsNone yet.');
  });
});
