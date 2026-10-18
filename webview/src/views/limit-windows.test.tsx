import { within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RateLimitWindow } from '../../../src/shared/agents.js';
import { codexAgent, twoAgents } from '../../test/fixtures-agents.js';
import { usageState } from '../../test/fixtures-tools.js';
import { fleetState, NOW } from '../../test/fixtures.js';
import { renderView } from '../../test/render.js';

import { FleetHeader } from './fleet-header.js';
import { otherWindows } from './limit-windows.js';
import { UsageView } from './usage-view.js';

const CLAUDE_WINDOW: RateLimitWindow = {
  agent: 'claude-code',
  id: 'five_hour',
  label: '5 hour',
  usedPct: 0.64,
  resetsAt: NOW,
};

const CODEX_WINDOW: RateLimitWindow = {
  agent: 'codex',
  id: 'primary',
  label: '5 hour',
  usedPct: 0.3,
  resetsAt: NOW + 2 * 60 * 60_000,
};

const DAY = 24 * 60 * 60_000;

const MONTH: RateLimitWindow = { ...CODEX_WINDOW, id: 'monthly', label: '30 day', usedPct: 0.92 };

describe('otherWindows', () => {
  it('leaves Claude Code out and names the rest by agent', () => {
    expect(otherWindows([CLAUDE_WINDOW, CODEX_WINDOW], twoAgents, NOW)).toStrictEqual([
      {
        key: 'codex:primary',
        label: 'Codex 5 hour limit',
        title: '5 hour limit',
        agent: codexAgent,
        window: CODEX_WINDOW,
      },
    ]);
  });

  it('gives an installed agent empty windows until it reports, and none to one not installed', () => {
    const empty = { agent: 'codex', usedPct: null, resetsAt: null };
    expect(otherWindows(undefined, twoAgents, NOW).map(({ window }) => window)).toStrictEqual([
      { ...empty, id: 'primary', label: 'Plan' },
    ]);
    expect(otherWindows(undefined, [{ ...codexAgent, installed: false }], NOW)).toStrictEqual([]);
  });

  it('starts a window over once its reset time passes', () => {
    const [named] = otherWindows([CODEX_WINDOW], twoAgents, CODEX_WINDOW.resetsAt ?? 0);
    expect(named?.window).toMatchObject({ usedPct: 0, resetsAt: null });
  });
});

describe('agent limit windows in the views', () => {
  it("adds a tile per window to the Fleet header and keeps Claude Code's tiles", () => {
    const week = { ...CLAUDE_WINDOW, id: 'seven_day', label: '7 day', resetsAt: NOW + 3 * DAY };
    const rateLimits = {
      ...fleetState.rateLimits,
      windows: [CLAUDE_WINDOW, week, CODEX_WINDOW, MONTH],
    };
    const view = renderView(
      <FleetHeader state={{ ...fleetState, rateLimits }} now={NOW} />,
      undefined,
      twoAgents,
    );
    expect(view.getByRole('meter', { name: '5 hour limit used' })).toBeDefined();
    expect(
      view.getByRole('meter', { name: 'Codex 5 hour limit used' }).getAttribute('aria-valuenow'),
    ).toBe('30');
    expect(
      view.getByRole('meter', { name: 'Codex 30 day limit used' }).getAttribute('aria-valuenow'),
    ).toBe('92');
    expect(view.getByText('1h 30m')).toBeDefined();
    expect(view.getByText('3d 0h')).toBeDefined();
    // The icon names the agent, so the label is the window alone, like Claude Code's.
    expect(view.getAllByText('5 hour limit').map((label) => label.dataset['tip'])).toStrictEqual([
      'Claude Code 5 hour limit',
      'Codex CLI 5 hour limit',
    ]);
    expect(view.getAllByText('2h 00m')).toHaveLength(2);
    expect(view.container.querySelectorAll('.stat-tiles dt .backend-logo')).toHaveLength(2);
    expect(view.container.querySelectorAll('.stat-tiles dt svg.icon')).toHaveLength(2);
  });

  it('shows the Fleet header as before with no windows', () => {
    const view = renderView(<FleetHeader state={fleetState} now={NOW} />);
    expect(
      view.queryAllByRole('meter').map((meter) => meter.getAttribute('aria-label')),
    ).toStrictEqual(['5 hour limit used', '7 day limit used']);
  });

  it("lists other agents' windows in the Usage view with their reset time", () => {
    const view = renderView(
      <UsageView state={{ ...usageState, windows: [CLAUDE_WINDOW, CODEX_WINDOW] }} />,
      undefined,
      twoAgents,
    );
    expect(view.getByRole('heading', { name: 'Agent limits' })).toBeDefined();
    expect(view.getByText('5 hour limit').dataset['tip']).toBe('Codex CLI 5 hour limit');
    expect(view.getByText('Resets in 2h 00m')).toBeDefined();
    // Codex reported only its 5 hour window, so its 7 day one gets no empty card.
    expect(view.queryByText('7 day limit')).toBeNull();
    view.unmount();
    const plain = renderView(<UsageView state={usageState} />);
    expect(within(plain.container).queryByRole('heading', { name: 'Agent limits' })).toBeNull();
  });
});
