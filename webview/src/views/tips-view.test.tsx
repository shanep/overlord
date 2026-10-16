import { fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { TipsState } from '../../../src/shared/protocol.js';
import { NOW } from '../../test/fixtures.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { SEVERITY_INFO } from './tips-lists.js';
import { TipsView } from './tips-view.js';

const MINUTE = 60_000;
const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const S2 = 'bbbbbbbb-2222-4222-8222-222222222222';

const EMPTY: TipsState = {
  sessions: 0,
  totalUsd: 0,
  cacheReadUsd: 0,
  averageContext: 0,
  largestContext: 0,
  tips: [],
  suggestions: [],
  rows: [],
  scannedAt: null,
};

const STATE: TipsState = {
  sessions: 2,
  totalUsd: 20,
  cacheReadUsd: 12,
  averageContext: 250_000,
  largestContext: 949_000,
  tips: [
    {
      id: 'huge-context',
      severity: 'high',
      title: 'Sessions grow huge without compacting',
      finding: '1 session went past 200K tokens of context.',
      advice: ['Lower autoCompactWindow in Knobs.', 'Write a handoff note.'],
      sessions: [{ sessionId: S1, title: 'Vault report', detail: '949K peak context' }],
      fixes: ['handoff', 'gone', 'scout'],
    },
    {
      id: 'denials',
      severity: 'medium',
      title: 'Tool calls keep getting denied',
      finding: '10 tool calls were denied.',
      advice: ['Run /fewer-permission-prompts.'],
      sessions: [],
      fixes: [],
    },
  ],
  suggestions: [
    {
      id: 'handoff',
      kind: 'skill',
      name: 'handoff',
      summary: 'Writes a handoff note.',
      reason: '1 session went past 200K tokens.',
      installed: false,
    },
    {
      id: 'scout',
      kind: 'agent',
      name: 'scout',
      summary: 'Searches on Haiku.',
      reason: null,
      installed: true,
    },
  ],
  rows: [
    {
      sessionId: S1,
      title: 'Vault report',
      updatedAt: NOW - MINUTE,
      prompts: 49,
      requests: 512,
      peakContext: 949_000,
      averageContext: 556_000,
      costUsd: 79,
      cacheReadShare: 0.71,
      tips: ['huge-context', 'unknown-tip'],
    },
    {
      sessionId: S2,
      title: 'Small fix',
      updatedAt: NOW - 2 * MINUTE,
      prompts: 3,
      requests: 12,
      peakContext: 40_000,
      averageContext: 30_000,
      costUsd: 0.5,
      cacheReadShare: 0.2,
      tips: [],
    },
  ],
  scannedAt: NOW - 5 * MINUTE,
};

describe('TipsView', () => {
  it('shows the headline numbers, advice, suggestions and sessions, and passes axe', async () => {
    const { getByRole, getByText, container } = renderView(<TipsView state={STATE} />);
    expect(getByText('Sessions', { selector: 'dt' }).nextElementSibling?.textContent).toBe('2');
    expect(getByText('Spend').nextElementSibling?.textContent).toBe('$20.00 est.');
    expect(getByText('Re-reading context').nextElementSibling?.textContent).toBe('60%');
    expect(getByText('Average context', { selector: 'dt' }).nextElementSibling?.textContent).toBe(
      '250K',
    );
    expect(getByText('Largest context').nextElementSibling?.textContent).toBe('949K');
    expect(getByText('5m ago')).toBeDefined();
    const huge = getByRole('article', { name: 'Sessions grow huge without compacting' });
    expect(huge.textContent).toContain(SEVERITY_INFO.high.label);
    expect(huge.textContent).toContain('1 session went past 200K tokens of context.');
    expect(
      within(huge)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toStrictEqual([
      'Lower autoCompactWindow in Knobs.',
      'Write a handoff note.',
      'Vault report 949K peak context',
    ]);
    expect(huge.textContent).toContain('Would help: handoff, scout');
    const denials = getByRole('article', { name: 'Tool calls keep getting denied' });
    expect(denials.textContent).toContain(SEVERITY_INFO.medium.label);
    expect(denials.textContent).not.toContain('Would help');
    expect(denials.textContent).not.toContain('Worst sessions');
    const handoff = getByRole('article', { name: 'handoff' });
    expect(handoff.textContent).toContain('Skill');
    expect(handoff.textContent).toContain('1 session went past 200K tokens.');
    expect(within(handoff).getByRole('button', { name: 'Create' })).toBeDefined();
    const scout = getByRole('article', { name: 'scout' });
    expect(scout.textContent).toContain('Agent');
    expect(scout.textContent).toContain('Installed');
    expect(scout.textContent).toContain('Nothing in your sessions calls for it yet.');
    expect(within(scout).getByRole('button', { name: 'Create again' })).toBeDefined();
    const table = getByRole('table', { name: 'Sessions by cost' });
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent),
    ).toStrictEqual([
      expect.stringContaining('Vault report'),
      expect.stringContaining('Small fix'),
    ]);
    expect(table.querySelector('span[title]')?.getAttribute('title')).toBe(
      'Sessions grow huge without compacting\nunknown-tip',
    );
    await expectAccessible(container);
  });

  it('posts rescan, create and open actions', () => {
    const { getByRole, api } = renderView(<TipsView state={STATE} />);
    fireEvent.click(getByRole('button', { name: 'Rescan' }));
    fireEvent.click(getByRole('button', { name: 'Create' }));
    fireEvent.click(getByRole('button', { name: 'Create again' }));
    const huge = getByRole('article', { name: 'Sessions grow huge without compacting' });
    fireEvent.click(within(huge).getByRole('button', { name: 'Vault report' }));
    const table = getByRole('table', { name: 'Sessions by cost' });
    fireEvent.click(within(table).getByRole('button', { name: 'Small fix' }));
    expect(api.actions()).toStrictEqual([
      { type: 'rescanTips' },
      { type: 'createSuggestion', suggestionId: 'handoff' },
      { type: 'createSuggestion', suggestionId: 'scout' },
      { type: 'openAgent', sessionId: S1, agentId: S1 },
      { type: 'openAgent', sessionId: S2, agentId: S2 },
    ]);
  });

  it('sorts sessions by any column', () => {
    const { getByRole } = renderView(<TipsView state={STATE} />);
    const table = getByRole('table', { name: 'Sessions by cost' });
    const firstRow = (): string | null | undefined =>
      within(table).getAllByRole('row')[1]?.textContent;
    const sortBy = (name: string): void => {
      fireEvent.click(within(table).getByRole('button', { name }));
    };
    for (const column of [
      'Session',
      'Last active',
      'Prompts',
      'Peak context',
      'Average context',
      'Cost',
      'Re-reading',
      'Tips',
    ]) {
      sortBy(column);
      expect([column, firstRow()]).toStrictEqual([column, expect.stringContaining('Small fix')]);
      sortBy(column);
      expect([column, firstRow()]).toStrictEqual([column, expect.stringContaining('Vault report')]);
    }
  });

  it('says so before the first scan and when nothing stands out, and passes axe', async () => {
    const { getByText, container } = renderView(<TipsView state={EMPTY} />);
    expect(getByText(/^Not scanned yet/u)).toBeDefined();
    expect(getByText('Re-reading context').nextElementSibling?.textContent).toBe('n/a');
    expect(getByText('Nothing stands out. Your sessions look lean.')).toBeDefined();
    expect(getByText('No sessions measured yet.')).toBeDefined();
    expect(SEVERITY_INFO.low.tone).toBe('info');
    await expectAccessible(container);
  });
});
