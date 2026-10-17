import { fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { LimitState } from '../../../src/shared/tuning.js';
import { EMPTY_LIMIT } from '../../../src/shared/tuning.js';
import { NOW } from '../../test/fixtures.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { LimitSection, stretchOf } from './tuning-limit.js';

const HOUR = 60 * 60_000;
const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';

const LIMIT: LimitState = {
  subscription: 'max',
  windows: [
    {
      kind: 'session',
      label: 'Current session',
      percent: 64,
      severity: 'normal',
      startsAt: NOW - 2 * HOUR,
      resetsAt: NOW + 3 * HOUR,
      runsOutAt: NOW + HOUR,
    },
    {
      kind: 'weekly_all',
      label: 'Current week (all models)',
      percent: 20,
      severity: 'normal',
      startsAt: NOW - 2 * 24 * HOUR,
      resetsAt: NOW + 5 * 24 * HOUR,
      runsOutAt: null,
    },
  ],
  windowStart: NOW - 2 * HOUR,
  windowUsd: 40,
  sessions: [{ sessionId: S1, title: 'Vault report', usd: 30, share: 0.75 }],
  weekUsd: 400,
  levers: [
    {
      id: 'routine-model',
      title: 'Run routine work on Sonnet',
      finding: '80% of the last week went to Opus.',
      advice: ['Start routine sessions on Sonnet.'],
      savedUsd: 100,
      saving: 0.25,
      tipId: null,
    },
    {
      id: 'context',
      title: 'Keep context small',
      finding: 'Context past 100K.',
      advice: ['Use /clear between tasks.'],
      savedUsd: 40,
      saving: 0.1,
      tipId: 'huge-context',
    },
  ],
};

const TIPS = new Map([['huge-context', 'Sessions grow huge without compacting']]);

describe('LimitSection', () => {
  it('shows the windows, their pace, the sessions and the levers, and passes axe', async () => {
    const { getByRole, getByText, container, api } = renderView(
      <LimitSection limit={LIMIT} tips={TIPS} />,
    );
    expect(getByRole('heading', { name: 'Session limit (max)' })).toBeDefined();
    const windows = within(getByRole('list', { name: 'Session limit (max)' })).getAllByRole(
      'listitem',
    );
    expect(windows[0]?.textContent).toContain('Runs out early');
    expect(windows[0]?.textContent).toContain('2h 00m before the reset');
    expect(windows[1]?.textContent).toContain('lasts until the reset');
    expect(windows[1]?.textContent).not.toContain('Runs out early');
    const sonnet = getByRole('article', { name: 'Run routine work on Sonnet' });
    expect(sonnet.textContent).toContain('Saves about 25%');
    expect(sonnet.textContent).toContain('last about 1.3x as long');
    const context = getByRole('article', { name: 'Keep context small' });
    expect(context.textContent).toContain('More in the advice below: Sessions grow huge');
    expect(getByText('$400.00 est.', { exact: false })).toBeDefined();
    fireEvent.click(getByRole('button', { name: 'Vault report' }));
    expect(api.actions()).toContainEqual({ type: 'openAgent', sessionId: S1, agentId: S1 });
    await expectAccessible(container);
  });

  it('says when plan limits are unknown and nothing stands out, and passes axe', async () => {
    const { getByText, container } = renderView(<LimitSection limit={EMPTY_LIMIT} tips={TIPS} />);
    expect(getByText(/could not read your plan limits/u)).toBeDefined();
    expect(getByText(/in the last five hours/u)).toBeDefined();
    expect(getByText('Nothing has run in this window yet.')).toBeDefined();
    expect(getByText(/No habit stands out/u)).toBeDefined();
    await expectAccessible(container);
  });

  it('works out how much longer the limit lasts', () => {
    expect(stretchOf(0.25)).toBe('1.3x');
    expect(stretchOf(0.5)).toBe('2.0x');
    expect(stretchOf(1)).toBe('20.0x');
  });
});
