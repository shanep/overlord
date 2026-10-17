import { within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RateLimitWindow } from '../../../src/shared/agents.js';
import { twoAgents } from '../../test/fixtures-agents.js';
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

const MONTH: RateLimitWindow = { ...CODEX_WINDOW, id: 'monthly', label: '30 day', usedPct: 92 };

describe('otherWindows', () => {
  it('leaves Claude Code out and names the rest by agent', () => {
    expect(otherWindows([CLAUDE_WINDOW, CODEX_WINDOW], twoAgents)).toStrictEqual([
      { key: 'codex:primary', label: 'Codex 5 hour limit', window: CODEX_WINDOW },
    ]);
    expect(otherWindows(undefined, twoAgents)).toStrictEqual([]);
  });
});

describe('agent limit windows in the views', () => {
  it("adds a tile per window to the Fleet header and keeps Claude Code's tiles", () => {
    const rateLimits = { ...fleetState.rateLimits, windows: [CLAUDE_WINDOW, CODEX_WINDOW, MONTH] };
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
    expect(view.getByText('Codex 5 hour limit')).toBeDefined();
    expect(view.getByText('Resets in 2h 00m')).toBeDefined();
    view.unmount();
    const plain = renderView(<UsageView state={usageState} />);
    expect(within(plain.container).queryByRole('heading', { name: 'Agent limits' })).toBeNull();
  });
});
