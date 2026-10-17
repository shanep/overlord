// Property text is concatenated in assertions. cspell:ignore Contextn hitsn Branchmain Modelclaude Efforthigh Permissionsdefault Modelunknown Effortunknown Permissionsunknown Branchunknown Processunknown Bashasked
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { HealthSignal, SessionHealth } from '../../../src/shared/health.js';
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

const notJudged: PropertiesState = {
  sessionId: 's1',
  session: session({
    id: 's1',
    title: 'Refactor parser',
    recap: {
      text: 'Split the parser in two.\n\nneeds input: keep the old one?',
      at: NOW - 5 * MINUTE,
    },
    lastPrompt: 'Split the parser',
  }),
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
  health: null,
};

const healthy: SessionHealth = {
  level: 'good',
  score: 0.8,
  metrics: {
    contextTokens: 120_000,
    contextWindow: 1_000_000,
    compactions: 0,
    turns: 42,
    recentToolErrors: 1,
    recentToolCalls: 20,
    recentCacheHit: 0.93,
  },
  signals: [],
};

const full: PropertiesState = { ...notJudged, health: healthy };

const contextSignal: HealthSignal = {
  id: 'context',
  level: 'degraded',
  title: 'The context is very large',
  finding: '450K tokens in context, 45% of a 1M window.',
  why: 'The bigger the context, the more likely the model misses instructions.',
  actions: ['Run /compact with what to keep.', 'Run /clear for a new task.'],
};

const compactionSignal: HealthSignal = {
  id: 'compactions',
  level: 'watch',
  title: 'Compacted once',
  finding: 'Compacted 1 time.',
  why: 'Each compaction swaps the conversation for a summary.',
  actions: ['Ask it to restate the goal.'],
};

function group(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

describe('PropertiesView', () => {
  it('has no accessibility violations', async () => {
    const { container } = renderView(<PropertiesView state={full} />);
    expect(screen.getAllByRole('region')).toHaveLength(8);
    await expectAccessible(container);
  });

  it('asks for a Claude tab when none is active', () => {
    renderView(
      <PropertiesView
        state={{
          sessionId: null,
          session: null,
          agents: [],
          pendingPermissions: [],
          health: null,
        }}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'No Claude tabFocus a Claude Code tab to see its properties.',
    );
  });

  it('names the session it is waiting for', () => {
    renderView(
      <PropertiesView
        state={{
          sessionId: 'new-id',
          session: null,
          agents: [],
          pendingPermissions: [],
          health: null,
        }}
      />,
    );
    expect(screen.getByText('Waiting for Claude Code')).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain('Session new-id shows up here');
  });

  it("shows Claude Code's recap and the last prompt first", () => {
    renderView(<PropertiesView state={full} />);
    expect(screen.getAllByRole('region')[0]).toBe(group('Working on'));
    expect(group('Working on').textContent).toBe(
      'Working onSplit the parser in two.\n\nneeds input: keep the old one?Recap 5m agoLast promptSplit the parser',
    );
  });

  it('shows only the last prompt before Claude Code writes a recap, and nothing before that', () => {
    const base = full.session ?? session({ id: 's1' });
    const { unmount } = renderView(
      <PropertiesView state={{ ...full, session: { ...base, recap: null } }} />,
    );
    expect(group('Working on').textContent).toBe('Working onLast promptSplit the parser');
    unmount();
    renderView(
      <PropertiesView state={{ ...full, session: { ...base, recap: null, lastPrompt: null } }} />,
    );
    expect(screen.queryByRole('region', { name: 'Working on' })).toBeNull();
  });

  it('shows the recap alone when there is no last prompt', () => {
    const base = full.session ?? session({ id: 's1' });
    renderView(<PropertiesView state={{ ...full, session: { ...base, lastPrompt: null } }} />);
    expect(group('Working on').textContent).toBe(
      'Working onSplit the parser in two.\n\nneeds input: keep the old one?Recap 5m ago',
    );
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
    expect(group('Usage').textContent).toContain('Cost$0.42 est.');
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

  it('shows a healthy session with its numbers', () => {
    renderView(<PropertiesView state={full} />);
    const health = group('Health');
    expect(within(health).getByRole('heading', { level: 2 }).textContent).toBe('Health Healthy');
    expect(health.textContent).toContain('No signs of trouble.');
    const meter = within(health).getByRole('meter', { name: 'Context window fill' });
    expect(meter.getAttribute('aria-valuenow')).toBe('12');
    expect(meter.firstElementChild?.className).toBe('meter-fill meter-info');
    expect(health.textContent).toContain('120K of 1M');
    expect(health.textContent).toContain('Compactions0Turns42Recent tool errors1 of 20');
    expect(health.textContent).toContain('Recent cache hits93%');
    expect(within(health).queryAllByRole('article')).toStrictEqual([]);
  });

  it('lists each sign of trouble with why it matters and what to do', async () => {
    const state: PropertiesState = {
      ...full,
      health: { ...healthy, level: 'degraded', signals: [contextSignal, compactionSignal] },
    };
    const { container } = renderView(<PropertiesView state={state} />);
    const health = group('Health');
    expect(within(health).getByRole('heading', { level: 2 }).textContent).toBe('Health Degraded');
    expect(health.textContent).toContain('Likely working worse than it did earlier.');
    const meter = within(health).getByRole('meter', { name: 'Context window fill' });
    expect(meter.firstElementChild?.className).toBe('meter-fill meter-critical');
    const big = within(health).getByRole('article', { name: 'The context is very large' });
    expect(within(big).getByRole('heading', { level: 3 }).textContent).toBe(
      'Degraded The context is very large',
    );
    expect(big.textContent).toContain('450K tokens in context, 45% of a 1M window.');
    expect(
      within(big)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toStrictEqual(['Run /compact with what to keep.', 'Run /clear for a new task.']);
    const compacted = within(health).getByRole('article', { name: 'Compacted once' });
    expect(within(compacted).getByRole('heading', { level: 3 }).textContent).toBe(
      'Watch Compacted once',
    );
    await expectAccessible(container);
  });

  it('warns on the context meter for a watch level and says when there is no context yet', () => {
    const watch: PropertiesState = {
      ...full,
      health: { ...healthy, level: 'watch', signals: [{ ...contextSignal, level: 'watch' }] },
    };
    const { unmount } = renderView(<PropertiesView state={watch} />);
    expect(group('Health').textContent).toContain('Starting to show strain.');
    expect(
      within(group('Health')).getByRole('meter', { name: 'Context window fill' }).firstElementChild
        ?.className,
    ).toBe('meter-fill meter-warning');
    unmount();
    const empty: PropertiesState = {
      ...full,
      health: {
        ...healthy,
        metrics: {
          ...healthy.metrics,
          contextTokens: null,
          contextWindow: null,
          recentCacheHit: null,
        },
      },
    };
    renderView(<PropertiesView state={empty} />);
    expect(group('Health').textContent).toContain('Contextn/a');
    expect(group('Health').textContent).toContain('Recent cache hitsn/a');
  });

  it('leaves out health when it has not been judged', () => {
    renderView(<PropertiesView state={notJudged} />);
    expect(screen.queryByRole('region', { name: 'Health' })).toBeNull();
  });

  it('says when there are no subagents yet', () => {
    renderView(<PropertiesView state={{ ...full, agents: [] }} />);
    expect(group('Subagents').textContent).toBe('SubagentsNone yet.');
  });
});
