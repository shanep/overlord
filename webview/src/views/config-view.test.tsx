import { fireEvent, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { configState } from '../../test/fixtures-tools.js';
import { expectAccessible, FakeApi, first, renderView } from '../../test/render.js';

import { isConfigStatus, STATUS_INFO, STATUS_ORDER } from './config-labels.js';
import { canAdopt, ConfigView, groupItems } from './config-view.js';

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

  it('posts sync, authoring, open and adopt actions', async () => {
    const { getByRole, api } = renderView(<ConfigView state={configState} />);
    await userEvent.click(getByRole('button', { name: 'Push' }));
    await userEvent.click(getByRole('button', { name: 'Pull' }));
    await userEvent.click(getByRole('button', { name: 'New agent' }));
    await userEvent.click(getByRole('button', { name: 'New skill' }));
    await userEvent.click(getByRole('button', { name: '/Users/dev/.claude/skills/canvas' }));
    await userEvent.click(getByRole('button', { name: 'Adopt memory into repo' }));
    expect(api.actions()).toStrictEqual([
      { type: 'syncPush' },
      { type: 'syncPull' },
      { type: 'newAgent' },
      { type: 'newSkill' },
      { type: 'openFile', path: '/Users/dev/.claude/skills/canvas' },
      { type: 'adoptConfig', itemId: 'memory' },
    ]);
    expect(getByRole('button', { name: /^Adopt/u })).toBeDefined();
  });

  it('disables sync without a connected repo', () => {
    const repo = { ...configState.repo, connected: false, remote: null, path: null };
    const { getByRole, getByText } = renderView(<ConfigView state={{ ...configState, repo }} />);
    expect(getByText('No config repo connected.')).toBeDefined();
    expect(getByRole('button', { name: 'Push' })).toHaveProperty('disabled', true);
    expect(getByRole('button', { name: 'Pull' })).toHaveProperty('disabled', true);
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
