import { fireEvent, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { sessionsState } from '../../test/fixtures-tools.js';
import { expectAccessible, FakeApi, renderView } from '../../test/render.js';

import type { SessionFilter } from './sessions-view.js';
import {
  filterSessions,
  groupByProject,
  HANDOFF_LABELS,
  projectName,
  SessionsView,
} from './sessions-view.js';

/** Session titles in page order, across every project table. */
function titles(root: HTMLElement): string[] {
  return within(root)
    .queryAllByRole('row')
    .filter((row) => row.querySelector('td') !== null)
    .map((row) => row.querySelectorAll('td')[1]?.textContent ?? '');
}

const lexer = {
  ...sessionsState.sessions[0],
  id: 'x4',
  title: 'Add lexer',
  cwd: '/repo',
  updatedAt: 1,
  archived: false,
  surface: 'cli' as const,
  handoffs: [],
};

describe('filterSessions', () => {
  it('hides archived sessions unless asked and sorts newest first', () => {
    const all: SessionFilter = { text: '', surface: 'all', archived: false };
    expect(filterSessions(sessionsState.sessions, all).map((entry) => entry.id)).toStrictEqual([
      'x1',
      'x2',
    ]);
    expect(
      filterSessions(sessionsState.sessions, { ...all, archived: true }).map((entry) => entry.id),
    ).toStrictEqual(['x1', 'x2', 'x3']);
  });

  it('filters by surface and by text in title or folder', () => {
    const base: SessionFilter = { text: '', surface: 'all', archived: true };
    expect(
      filterSessions(sessionsState.sessions, { ...base, surface: 'cloud' }).map(
        (entry) => entry.id,
      ),
    ).toStrictEqual(['x2']);
    expect(
      filterSessions(sessionsState.sessions, { ...base, text: ' CHAT ' }).map((entry) => entry.id),
    ).toStrictEqual(['x3']);
    expect(
      filterSessions(sessionsState.sessions, { ...base, text: '/repo' }).map((entry) => entry.id),
    ).toStrictEqual(['x1']);
  });
});

describe('groupByProject', () => {
  it('names a project by its last folder', () => {
    expect(projectName('/Users/me/repos/app')).toBe('app');
    expect(projectName('/Users/me/repos/app/')).toBe('app');
    expect(projectName(String.raw`C:\work\api`)).toBe('api');
    expect(projectName('/')).toBe('/');
    expect(projectName(null)).toBe('No folder');
  });

  it('groups by folder in the order each folder first shows up', () => {
    const [x1, x2, x3] = sessionsState.sessions;
    const groups = groupByProject(
      [x2, x1, lexer, x3].filter((entry) => entry !== undefined),
      {},
    );
    expect(
      groups.map((group) => [group.cwd, group.name, group.sessions.map((entry) => entry.id)]),
    ).toStrictEqual([
      [null, 'No folder', ['x2', 'x3']],
      ['/repo', 'repo', ['x1', 'x4']],
    ]);
  });

  it('folds worktree folders into the repository they came from', () => {
    const [x1] = sessionsState.sessions;
    const worktree = { ...lexer, id: 'x5', cwd: '/wt/repo-1/w1' };
    const groups = groupByProject(
      [worktree, x1].filter((entry) => entry !== undefined),
      {
        '/wt/repo-1/w1': '/repo',
      },
    );
    expect(
      groups.map((group) => [group.cwd, group.sessions.map((entry) => entry.id)]),
    ).toStrictEqual([['/repo', ['x5', 'x1']]]);
  });
});

describe('SessionsView', () => {
  it('lists sessions under their project with surface badges and passes axe', async () => {
    const { getByRole, getByText, container } = renderView(<SessionsView state={sessionsState} />);
    const repo = getByRole('table', { name: 'Sessions in /repo' });
    const loose = getByRole('table', { name: 'Sessions in no folder' });
    expect(titles(repo)).toStrictEqual(['Refactor parser']);
    expect(titles(loose)).toStrictEqual(['Cloud fix']);
    expect(within(repo).getByText('CLI')).toBeDefined();
    expect(within(loose).getByText('Cloud')).toBeDefined();
    expect(getByText('repo')).toBeDefined();
    expect(getByText('No folder')).toBeDefined();
    expect(getByText('/repo').className).toBe('muted mono');
    expect(getByText('2 of 3')).toBeDefined();
    expect(getByText('claude.ai import: 1d ago')).toBeDefined();
    await expectAccessible(container);
  });

  it('posts a handoff for the chosen session', async () => {
    const { getByRole, api } = renderView(<SessionsView state={sessionsState} />);
    await userEvent.click(getByRole('button', { name: 'Start in cloud: Refactor parser' }));
    await userEvent.click(getByRole('button', { name: 'Pull to local: Cloud fix' }));
    expect(api.actions()).toStrictEqual([
      { type: 'handoff', sessionId: 'x1', kind: 'start-cloud' },
      { type: 'handoff', sessionId: 'x2', kind: 'teleport-local' },
    ]);
    expect(HANDOFF_LABELS['open-desktop']).toBe('Open in Desktop');
  });

  it('continues a local session from its Continue button', async () => {
    const { getByRole, api } = renderView(<SessionsView state={sessionsState} />);
    const button = getByRole('button', { name: 'Continue: Refactor parser' });
    expect(button.className).toBe('primary');
    expect(getByRole('button', { name: 'Start in cloud: Refactor parser' }).className).toBe('');
    await userEvent.click(button);
    expect(api.actions()).toStrictEqual([
      { type: 'handoff', sessionId: 'x1', kind: 'resume-local' },
    ]);
    expect(HANDOFF_LABELS['resume-local']).toBe('Continue');
  });

  it('opens the agent view from a local session title only', async () => {
    const { getByRole, queryByRole, api } = renderView(<SessionsView state={sessionsState} />);
    const title = getByRole('button', { name: 'Refactor parser' });
    expect(title.getAttribute('title')).toBe('Open the agent view for this session');
    await userEvent.click(title);
    expect(api.actions()).toStrictEqual([{ type: 'openAgent', sessionId: 'x1', agentId: 'x1' }]);
    expect(queryByRole('button', { name: 'Cloud fix' })).toBeNull();
  });

  it('imports the claude.ai export and says never when not imported', async () => {
    const { getByRole, getByText, api } = renderView(
      <SessionsView state={{ ...sessionsState, claudeAiImportedAt: null }} />,
    );
    expect(getByText('claude.ai import: never')).toBeDefined();
    await userEvent.click(getByRole('button', { name: 'Import claude.ai export' }));
    expect(api.actions()).toStrictEqual([{ type: 'importClaudeAi' }]);
  });

  it('filters by text, surface and archived, and saves the filters', async () => {
    const { getByRole, getByText, api, container } = renderView(
      <SessionsView state={sessionsState} />,
    );
    const table = container;
    await userEvent.click(getByRole('checkbox', { name: 'Show archived' }));
    expect(titles(table)).toStrictEqual([
      'Refactor parser',
      'Cloud fix',
      'Chat about tests archived',
    ]);
    await userEvent.selectOptions(getByRole('combobox', { name: 'Surface' }), 'claude-ai');
    expect(titles(table)).toStrictEqual(['Chat about tests archived']);
    await userEvent.selectOptions(getByRole('combobox', { name: 'Surface' }), 'all');
    await userEvent.type(getByRole('searchbox', { name: 'Filter' }), 'zzz');
    expect(getByText('No sessions match.')).toBeDefined();
    expect(api.saved).toStrictEqual({
      'sessions.archived': true,
      'sessions.surface': 'all',
      'sessions.text': 'zzz',
    });
  });

  it('falls back to all surfaces for a value that is not a surface', () => {
    const { getByRole, api } = renderView(<SessionsView state={sessionsState} />);
    fireEvent.change(getByRole('combobox', { name: 'Surface' }), { target: { value: 'bogus' } });
    expect(api.saved).toStrictEqual({ 'sessions.surface': 'all' });
  });

  it('restores saved filters', () => {
    const api = new FakeApi({ 'sessions.surface': 'cloud', 'sessions.text': 'fix' });
    const { getByRole, container } = renderView(<SessionsView state={sessionsState} />, api);
    expect(titles(container)).toStrictEqual(['Cloud fix']);
    expect(getByRole('combobox', { name: 'Surface' })).toHaveProperty('value', 'cloud');
  });

  it('sorts within a project by a column header', async () => {
    const state = { ...sessionsState, sessions: [...sessionsState.sessions, lexer] };
    const { getByRole } = renderView(<SessionsView state={state} />);
    const table = getByRole('table', { name: 'Sessions in /repo' });
    expect(titles(table)).toStrictEqual(['Refactor parser', 'Add lexer']);
    await userEvent.click(within(table).getByRole('button', { name: 'Title' }));
    expect(titles(table)).toStrictEqual(['Add lexer', 'Refactor parser']);
    await userEvent.click(within(table).getByRole('button', { name: 'Updated' }));
    expect(titles(table)).toStrictEqual(['Add lexer', 'Refactor parser']);
    await userEvent.click(within(table).getByRole('button', { name: 'Updated' }));
    expect(titles(table)).toStrictEqual(['Refactor parser', 'Add lexer']);
    await userEvent.click(within(table).getByRole('button', { name: 'Surface' }));
    expect(titles(table)).toHaveLength(2);
  });
});
