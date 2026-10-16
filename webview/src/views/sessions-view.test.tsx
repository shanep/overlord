import { fireEvent, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { sessionsState } from '../../test/fixtures-tools.js';
import { expectAccessible, FakeApi, renderView } from '../../test/render.js';

import type { SessionFilter } from './sessions-view.js';
import { filterSessions, HANDOFF_LABELS, SessionsView } from './sessions-view.js';

function titles(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelectorAll('td')[1]?.textContent ?? '');
}

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

describe('SessionsView', () => {
  it('lists sessions with surface badges and passes axe', async () => {
    const { getByRole, getByText, container } = renderView(<SessionsView state={sessionsState} />);
    const table = getByRole('table', { name: 'Sessions' });
    expect(titles(table)).toStrictEqual(['Refactor parser', 'Cloud fix']);
    expect(within(table).getByText('CLI')).toBeDefined();
    expect(within(table).getByText('Cloud')).toBeDefined();
    expect(getByText('2 of 3')).toBeDefined();
    expect(getByText('claude.ai import: 1d ago')).toBeDefined();
    expect(within(table).getAllByText('none')).toHaveLength(1);
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
    const { getByRole, getByText, api } = renderView(<SessionsView state={sessionsState} />);
    const table = getByRole('table', { name: 'Sessions' });
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
    const { getByRole } = renderView(<SessionsView state={sessionsState} />, api);
    expect(titles(getByRole('table', { name: 'Sessions' }))).toStrictEqual(['Cloud fix']);
    expect(getByRole('combobox', { name: 'Surface' })).toHaveProperty('value', 'cloud');
  });

  it('sorts by a column header', async () => {
    const { getByRole } = renderView(<SessionsView state={sessionsState} />);
    const table = getByRole('table', { name: 'Sessions' });
    await userEvent.click(getByRole('button', { name: 'Title' }));
    expect(titles(table)).toStrictEqual(['Cloud fix', 'Refactor parser']);
    await userEvent.click(getByRole('button', { name: 'Surface' }));
    expect(titles(table)).toStrictEqual(['Refactor parser', 'Cloud fix']);
    await userEvent.click(getByRole('button', { name: 'Folder' }));
    expect(titles(table)).toStrictEqual(['Cloud fix', 'Refactor parser']);
    await userEvent.click(getByRole('button', { name: 'Updated' }));
    expect(titles(table)).toStrictEqual(['Cloud fix', 'Refactor parser']);
  });
});
