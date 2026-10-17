// Cell text is concatenated in assertions. cspell:ignore Readok Basherror Editrunning Costn mcharts
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { AgentDetailState } from '../../../src/shared/protocol.js';
import { agent, agentState, NOW, requests, session } from '../../test/fixtures.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { agentCost, costFromRequests } from './agent-header.js';
import { AgentView } from './agent-view.js';

const subagent = agent({
  id: 'a1',
  sessionId: 's1',
  parentAgentId: 's1',
  agentType: 'Explore',
  description: 'Find parser tests',
  model: null,
  endedAt: NOW - 60_000,
  startedAt: NOW - 3 * 60_000,
});

describe('AgentView', () => {
  it('has no accessibility violations', async () => {
    const { container } = renderView(<AgentView state={agentState} />);
    expect(screen.getAllByRole('img')).toHaveLength(5);
    await expectAccessible(container);
  });

  it('shows the header numbers for the main thread', () => {
    renderView(<AgentView state={agentState} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Main thread');
    const stats = screen.getByText('Model').closest('dl');
    expect(stats).not.toBeNull();
    const text = stats?.textContent ?? '';
    expect(text).toContain('claude-opus-4-7');
    expect(text).toContain('Elapsed10m 00s');
    expect(text).toContain('Tokens101K');
    expect(text).toContain('Cost$1.25 est.');
    expect(text).toContain('Tool calls30');
    expect(screen.getByText('Refactor parser')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Open parent' })).toBeNull();
  });

  it('posts openContext for this agent', async () => {
    const user = userEvent.setup();
    const { api } = renderView(<AgentView state={agentState} />);
    await user.click(screen.getByRole('button', { name: 'Context' }));
    expect(api.actions()).toStrictEqual([{ type: 'openContext', sessionId: 's1', agentId: 's1' }]);
  });

  it('continues the main session in Claude Code', async () => {
    const user = userEvent.setup();
    const { api } = renderView(<AgentView state={agentState} />);
    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button.className).toBe('primary');
    expect(button.getAttribute('title')).toBe('Continue this session in Claude Code');
    await user.click(button);
    expect(api.actions()).toStrictEqual([
      { type: 'handoff', sessionId: 's1', kind: 'resume-local' },
    ]);
  });

  it('offers no Continue for a session with no local transcript', () => {
    const cloud =
      agentState.session === null ? null : { ...agentState.session, surface: 'cloud' as const };
    renderView(<AgentView state={{ ...agentState, session: cloud }} />);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('confirms inline before interrupting', async () => {
    const user = userEvent.setup();
    const { api } = renderView(<AgentView state={agentState} />);
    await user.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(api.actions()).toStrictEqual([]);
    const confirm = screen.getByRole('group', { name: 'Confirm' });
    expect(confirm.textContent).toContain('Interrupt this session?');
    await user.click(within(confirm).getByRole('button', { name: 'Interrupt' }));
    expect(api.actions()).toStrictEqual([{ type: 'interrupt', sessionId: 's1' }]);
    expect(screen.queryByRole('group', { name: 'Confirm' })).toBeNull();
  });

  it('confirms before stopping and can cancel', async () => {
    const user = userEvent.setup();
    const { api } = renderView(<AgentView state={agentState} />);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Confirm' })).toBeNull();
    expect(api.actions()).toStrictEqual([]);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    const confirm = screen.getByRole('group', { name: 'Confirm' });
    expect(confirm.textContent).toContain('Stop this session?');
    await user.click(within(confirm).getByRole('button', { name: 'Stop' }));
    expect(api.actions()).toStrictEqual([{ type: 'stop', sessionId: 's1' }]);
  });

  it('renders every chart with a table twin', () => {
    renderView(<AgentView state={agentState} />);
    for (const name of [
      'Tool call timeline',
      'Tokens per request',
      'Cost over time (est.)',
      'Context window fill',
      'Cache hit ratio',
    ]) {
      expect(screen.getByRole('img', { name }).querySelector('svg')).not.toBeNull();
      expect(screen.getByRole('table', { name })).toBeDefined();
    }
    const timeline = screen.getByRole('table', { name: 'Tool call timeline' });
    const rows = within(timeline).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toStrictEqual([
      'CallStatusStart (s)Seconds',
      '1. Readok0.02.0',
      '2. Basherror60.02.0',
      '3. Editrunning120.0420.0',
    ]);
    const cost = screen.getByRole('table', { name: 'Cost over time (est.)' });
    expect(within(cost).getAllByRole('row')[3]?.textContent).toContain('n/a');
    const cache = screen.getByRole('table', { name: 'Cache hit ratio' });
    expect(within(cache).getAllByRole('row')[4]?.textContent).toContain('n/a');
  });

  it('shows the feed oldest first with thinking and tool input collapsed', () => {
    const shuffled = [...agentState.feed.slice(6), ...agentState.feed.slice(0, 6)];
    renderView(<AgentView state={{ ...agentState, feed: shuffled }} />);
    const feed = screen.getByRole('list', { name: 'Feed' });
    const items = within(feed).getAllByRole('listitem');
    expect(items).toHaveLength(7);
    expect(items[0]?.textContent).toContain('Refactor the parser please.');
    expect(items[0]?.className).toBe('feed-user');
    const thinking = screen.getByText('Plan the change in steps.').closest('details');
    expect(thinking?.open).toBe(false);
    const input = screen.getByText(/"file_path": "\/src\/parser.ts"/u).closest('details');
    expect(input?.open).toBe(false);
    expect(items[3]?.className).toBe('feed-tool');
    expect(items[4]?.textContent).toContain('ok');
    expect(items[5]?.className).toBe('feed-error');
    expect(items[5]?.textContent).toContain('errorExit 1');
    expect(items[6]?.className).toBe('feed-system');
    expect(items[2]?.className).toBe('feed-text');
  });

  it('shows colored tool output without its terminal escapes', () => {
    const feed: AgentDetailState['feed'] = [
      {
        kind: 'tool_result',
        id: 'r1',
        at: 1,
        toolUseId: 't1',
        ok: true,
        text: '\u001B[34mcharts\u001B[39;49m\u001B[0m\n10%\r100%',
      },
    ];
    renderView(<AgentView state={{ ...agentState, feed }} />);
    const item = within(screen.getByRole('list', { name: 'Feed' })).getByRole('listitem');
    expect(item.querySelector('.feed-text')?.textContent).toBe('charts\n100%');
  });

  it('opens a child agent from the subagent list', async () => {
    const user = userEvent.setup();
    const { api } = renderView(<AgentView state={agentState} />);
    const list = screen.getByRole('list', { name: 'Subagents' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list.textContent).toContain('running');
    await user.click(within(list).getByRole('button', { name: 'Explore: Find parser tests' }));
    expect(api.actions()).toStrictEqual([{ type: 'openAgent', sessionId: 's1', agentId: 'a1' }]);
  });

  it('shows a subagent with its own cost and a parent link', async () => {
    const user = userEvent.setup();
    const state: AgentDetailState = {
      ...agentState,
      agent: subagent,
      session: null,
      children: [],
      feed: [],
      toolCalls: [],
      requests: [],
      compactions: [],
    };
    const { api, container } = renderView(<AgentView state={state} />);
    const text = screen.getByText('Model').closest('dl')?.textContent ?? '';
    expect(text).toContain('unknown');
    expect(text).toContain('Elapsed2m 00s');
    expect(text).toContain('Costn/a');
    expect(screen.getByText('No subagents.')).toBeDefined();
    expect(screen.getByText('Nothing in the feed yet.')).toBeDefined();
    expect(screen.getAllByText('No data yet.')).toHaveLength(5);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open parent' }));
    expect(api.actions()).toStrictEqual([{ type: 'openAgent', sessionId: 's1', agentId: 's1' }]);
    await expectAccessible(container);
  });

  it('shows an empty state with no agent', () => {
    renderView(<AgentView state={{ ...agentState, agent: null }} />);
    expect(screen.getByRole('status').textContent).toContain('No agent selected');
  });
});

describe('agent cost', () => {
  it('sums known request costs', () => {
    expect(costFromRequests(requests)).toBeCloseTo(0.15, 10);
    expect(costFromRequests([])).toBeNull();
    expect(costFromRequests(requests.map((request) => ({ ...request, costUsd: null })))).toBeNull();
  });

  it('uses the session cost only for the main thread', () => {
    const main = agent({ id: 's1', sessionId: 's1' });
    expect(agentCost(main, session({ id: 's1', costUsd: 2 }), requests)).toBe(2);
    expect(agentCost(main, null, requests)).toBeCloseTo(0.15, 10);
    expect(agentCost(subagent, session({ id: 's1', costUsd: 2 }), requests)).toBeCloseTo(0.15, 10);
  });
});
