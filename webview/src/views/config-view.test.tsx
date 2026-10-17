import { fireEvent, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { configState } from '../../test/fixtures-tools.js';
import { expectAccessible, FakeApi, first, renderView } from '../../test/render.js';

import { isConfigStatus, STATUS_INFO, STATUS_ORDER } from './config-labels.js';
import { canAdopt, ConfigView, groupItems, syncLine } from './config-view.js';

describe('groupItems', () => {
  it('groups by kind in a fixed order with names sorted', () => {
    const groups = groupItems(configState.items, 'all');
    expect(groups.map((group) => group.kind)).toStrictEqual([
      'claude-md',
      'skill',
      'agent',
      'mcp-server',
      'memory',
    ]);
    expect(groups[1]?.items.map((item) => item.name)).toStrictEqual(['canvas', 'writing-voice']);
  });

  it('filters by status and drops empty groups', () => {
    const groups = groupItems(configState.items, 'secret');
    expect(groups).toHaveLength(1);
    expect(first(groups).items.map((item) => item.id)).toStrictEqual(['github']);
  });
});

describe('syncLine', () => {
  it('says what the sync is doing or did last', () => {
    const minute = 60_000;
    expect(syncLine({ state: 'idle', lastSyncAt: null, message: null }, 0)).toBe('Not synced yet.');
    expect(syncLine({ state: 'idle', lastSyncAt: 0, message: null }, 5 * minute)).toBe(
      'Synced 5m ago.',
    );
    expect(syncLine({ state: 'off', lastSyncAt: null, message: null }, 0)).toBe(
      'Background sync is off (overlord.configSync.auto).',
    );
    expect(syncLine({ state: 'error', lastSyncAt: null, message: 'Boom.' }, 0)).toBe('Boom.');
    expect(syncLine({ state: 'error', lastSyncAt: null, message: null }, 0)).toBe(
      'The last sync failed.',
    );
  });
});

describe('config labels', () => {
  it('has a badge for every status and a guard', () => {
    expect(STATUS_ORDER.map((status) => STATUS_INFO[status].label)).toHaveLength(9);
    expect(isConfigStatus('managed')).toBe(true);
    expect(isConfigStatus('stale')).toBe(false);
    expect(canAdopt(first(configState.items))).toBe(false);
  });
});

describe('ConfigView', () => {
  it('shows the repo state, groups and a legend, and passes axe', async () => {
    const { getByRole, getByText, container } = renderView(<ConfigView state={configState} />);
    expect(getByText('git@github.com:dev/claude-config.git')).toBeDefined();
    expect(getByText('Ahead').nextElementSibling?.textContent).toBe('2');
    expect(getByText('Behind').nextElementSibling?.textContent).toBe('1');
    expect(getByText('Changed files').nextElementSibling?.textContent).toBe('3');
    expect(getByText('6 items')).toBeDefined();
    const skills = getByRole('table', { name: 'Skills' });
    expect(within(skills).getByText('external repo')).toBeDefined();
    expect(within(skills).getByText('links to /Users/dev/repos/edutools/skill')).toBeDefined();
    expect(within(getByRole('table', { name: 'Agents' })).getByText('none')).toBeDefined();
    expect(getByText('Badge legend')).toBeDefined();
    expect(getByText('Value lives in the OS keychain. The repo has a placeholder.')).toBeDefined();
    await expectAccessible(container);
  });

  it('posts sync, view, open and adopt actions', async () => {
    const { getByRole, api } = renderView(<ConfigView state={configState} />);
    await userEvent.click(getByRole('button', { name: 'Sync now' }));
    await userEvent.click(getByRole('button', { name: 'Skills' }));
    await userEvent.click(getByRole('button', { name: 'Agents' }));
    await userEvent.click(getByRole('button', { name: '/Users/dev/.claude/skills/canvas' }));
    await userEvent.click(getByRole('button', { name: 'Adopt memory into repo' }));
    expect(api.actions()).toStrictEqual([
      { type: 'syncNow' },
      { type: 'openView', view: 'skills' },
      { type: 'openView', view: 'agents' },
      { type: 'openFile', path: '/Users/dev/.claude/skills/canvas' },
      { type: 'adoptConfig', itemId: 'memory' },
    ]);
    expect(getByRole('button', { name: /^Adopt/u })).toBeDefined();
  });

  it('offers to turn sync on without a connected repo', async () => {
    const repo = { ...configState.repo, connected: false, remote: null, path: null };
    const { getByRole, getByText, queryByRole, api } = renderView(
      <ConfigView state={{ ...configState, repo }} />,
    );
    expect(getByText(/^Config sync is off\./u)).toBeDefined();
    expect(queryByRole('button', { name: 'Sync now' })).toBeNull();
    await userEvent.click(getByRole('button', { name: 'Turn on sync' }));
    expect(api.actions()).toStrictEqual([{ type: 'turnOnSync' }]);
  });

  it('shows where the background sync is', () => {
    const syncing = { state: 'syncing', lastSyncAt: null, message: null } as const;
    const { getByRole, getByText } = renderView(
      <ConfigView state={{ ...configState, sync: syncing }} />,
    );
    expect(getByText('Syncing now.')).toBeDefined();
    expect(getByRole('button', { name: 'Sync now' })).toHaveProperty('disabled', true);
  });

  it('marks a failed sync as an error', () => {
    const failed = { state: 'error', lastSyncAt: null, message: 'Push failed.' } as const;
    const { getByText } = renderView(<ConfigView state={{ ...configState, sync: failed }} />);
    expect(getByText('Push failed.').className).toBe('error-text');
  });

  it('shows none for a connected repo with no remote or path', () => {
    const repo = { ...configState.repo, remote: null, path: null };
    const { getAllByText } = renderView(<ConfigView state={{ ...configState, repo }} />);
    expect(getAllByText('none').length).toBeGreaterThanOrEqual(2);
  });

  it('filters by status, saves it, and shows an empty state', async () => {
    const { getByRole, queryByRole, api } = renderView(<ConfigView state={configState} />);
    await userEvent.selectOptions(getByRole('combobox', { name: 'Status' }), 'secret');
    expect(getByRole('table', { name: 'MCP servers' })).toBeDefined();
    expect(queryByRole('table', { name: 'Skills' })).toBeNull();
    expect(api.saved).toStrictEqual({ 'config.status': 'secret' });
    await userEvent.selectOptions(getByRole('combobox', { name: 'Status' }), 'managed');
    expect(getByRole('status').textContent).toBe('No config items');
    await userEvent.selectOptions(getByRole('combobox', { name: 'Status' }), 'all');
    expect(getByRole('table', { name: 'Skills' })).toBeDefined();
  });

  it('falls back to all for a value that is not a status', () => {
    const { getByRole, api } = renderView(<ConfigView state={configState} />);
    fireEvent.change(getByRole('combobox', { name: 'Status' }), { target: { value: 'bogus' } });
    expect(api.saved).toStrictEqual({ 'config.status': 'all' });
  });

  it('restores a saved status filter and ignores a bad one', () => {
    const saved = renderView(
      <ConfigView state={configState} />,
      new FakeApi({ 'config.status': 'built-in' }),
    );
    expect(saved.getByRole('table', { name: 'Agents' })).toBeDefined();
    expect(saved.queryByRole('table', { name: 'Skills' })).toBeNull();
    saved.unmount();
    const bad = renderView(<ConfigView state={configState} />, new FakeApi({ 'config.status': 9 }));
    expect(bad.getByRole('table', { name: 'Skills' })).toBeDefined();
  });
});
