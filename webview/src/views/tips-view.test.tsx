import { fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ImpactMetric, TipImpact, TipsState } from '../../../src/shared/tips.js';
import { NOW } from '../../test/fixtures.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { formatChange, formatImpactValue, VERDICT_INFO } from './tips-impact.js';
import { SEVERITY_INFO } from './tips-lists.js';
import { TipsView } from './tips-view.js';

const MINUTE = 60_000;
const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const S2 = 'bbbbbbbb-2222-4222-8222-222222222222';

const WEEK = 7 * 24 * 60 * MINUTE;

const TARGET: ImpactMetric = {
  id: 'largeShare',
  label: 'Sessions past 200K context',
  role: 'target',
  why: '',
  format: 'percent',
  before: 0.5,
  after: 0.1,
  change: -0.8,
  direction: 'better',
};

const IMPACT: TipImpact = {
  trackedSince: NOW - 2 * WEEK,
  verdict: 'mixed',
  summary: 'Sessions past 200K context fell 80% over 6 sessions since you started.',
  sessionsBefore: 9,
  sessionsAfter: 6,
  metrics: [
    TARGET,
    {
      id: 'costPerPrompt',
      label: 'Cost per prompt',
      role: 'cost',
      why: '',
      format: 'usd',
      before: 0.5,
      after: 0.48,
      change: -0.04,
      direction: 'same',
    },
    {
      id: 'extraReads',
      label: 'Rereads per 100 tool calls',
      role: 'side-effect',
      why: 'After a compaction Claude may reread files.',
      format: 'per100',
      before: 2,
      after: 3,
      change: 0.5,
      direction: 'worse',
    },
  ],
  weeks: [
    { start: NOW - 2 * WEEK, sessions: 4, values: [0.25, 0.5, 2.5] },
    { start: NOW - WEEK, sessions: 2, values: [0, 0.4, null] },
  ],
};

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
      pros: ['Compaction happens on its own.'],
      cons: ['The summary can drop details you still needed.'],
      skipWhen: 'Leave it large for big refactors.',
      impact: IMPACT,
    },
    {
      id: 'denials',
      severity: 'medium',
      title: 'Tool calls keep getting denied',
      finding: '10 tool calls were denied.',
      advice: ['Run /fewer-permission-prompts.'],
      sessions: [],
      fixes: [],
      pros: ['Fewer interruptions.'],
      cons: ['A broad rule removes a check.'],
      skipWhen: 'Keep denying pushes.',
      impact: null,
    },
  ],
  suggestions: [
    {
      id: 'handoff',
      kind: 'skill',
      name: 'handoff',
      summary: 'Writes a handoff note.',
      pros: ['You choose what carries over.'],
      cons: ['Detail it leaves out is gone.'],
      reason: '1 session went past 200K tokens.',
      installed: false,
    },
    {
      id: 'scout',
      kind: 'agent',
      name: 'scout',
      summary: 'Searches on Haiku.',
      pros: ['Cheap searches.'],
      cons: ['Haiku can miss subtle code.'],
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
      'Compaction happens on its own.',
      'The summary can drop details you still needed.',
      'Vault report 949K peak context',
    ]);
    expect(within(huge).getByRole('list', { name: 'Pros' }).textContent).toBe(
      'Compaction happens on its own.',
    );
    expect(within(huge).getByRole('list', { name: 'Cons' }).textContent).toBe(
      'The summary can drop details you still needed.',
    );
    expect(huge.textContent).toContain('Skip it when: Leave it large for big refactors.');
    expect(huge.textContent).toContain('Would help: handoff, scout');
    const denials = getByRole('article', { name: 'Tool calls keep getting denied' });
    expect(denials.textContent).toContain(SEVERITY_INFO.medium.label);
    expect(denials.textContent).not.toContain('Would help');
    expect(denials.textContent).not.toContain('Worst sessions');
    const handoff = getByRole('article', { name: 'handoff' });
    expect(handoff.textContent).toContain('Skill');
    expect(handoff.textContent).toContain('1 session went past 200K tokens.');
    expect(within(handoff).getByRole('list', { name: 'Cons' }).textContent).toBe(
      'Detail it leaves out is gone.',
    );
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
    fireEvent.click(getByRole('button', { name: 'Track from now' }));
    fireEvent.click(getByRole('button', { name: 'Stop tracking' }));
    const huge = getByRole('article', { name: 'Sessions grow huge without compacting' });
    fireEvent.click(within(huge).getByRole('button', { name: 'Vault report' }));
    const table = getByRole('table', { name: 'Sessions by cost' });
    fireEvent.click(within(table).getByRole('button', { name: 'Small fix' }));
    expect(api.actions()).toStrictEqual([
      { type: 'rescanTips' },
      { type: 'createSuggestion', suggestionId: 'handoff' },
      { type: 'createSuggestion', suggestionId: 'scout' },
      { type: 'trackTip', tipId: 'denials', on: true },
      { type: 'trackTip', tipId: 'huge-context', on: false },
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

  it('shows how a tracked tip went, overall and week by week, and passes axe', async () => {
    const { getByRole, container } = renderView(<TipsView state={STATE} />);
    const huge = getByRole('article', { name: 'Sessions grow huge without compacting' });
    const results = within(huge).getByRole('region', { name: /^Results since/u });
    expect(results.textContent).toContain(VERDICT_INFO.mixed.label);
    expect(results.textContent).toContain(IMPACT.summary);
    const rows = within(within(results).getByRole('table', { name: 'Before and since' }))
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent);
    expect(rows).toStrictEqual([
      'Sessions past 200K context50%10%-80%, better',
      'Cost per prompt$0.50 est.$0.48 est.-4%, about the same',
      'Rereads per 100 tool calls2.03.0+50%, worse',
    ]);
    const weeks = within(within(results).getByRole('table', { name: 'Week by week' }))
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent);
    expect(weeks).toStrictEqual([
      '30 days before950%$0.50 est.2.0',
      expect.stringContaining('425%$0.50 est.2.5'),
      expect.stringContaining('20%$0.40 est.n/a'),
    ]);
    const denials = getByRole('article', { name: 'Tool calls keep getting denied' });
    expect(within(denials).getByRole('region', { name: 'Results' }).textContent).toContain(
      'Taking this advice?',
    );
    await expectAccessible(container);
  });

  it('shows n/a for a measure with nothing to compare', () => {
    const blank: TipsState = {
      ...STATE,
      tips: STATE.tips.slice(0, 1).map((tip) => ({
        ...tip,
        impact: {
          ...IMPACT,
          verdict: 'same',
          metrics: [{ ...TARGET, before: null, change: null, direction: null }],
          weeks: [],
        },
      })),
    };
    const { getByRole } = renderView(<TipsView state={blank} />);
    const row = within(getByRole('table', { name: 'Before and since' })).getAllByRole('row')[1];
    expect([...(row?.children ?? [])].map((cell) => cell.textContent)).toStrictEqual([
      'Sessions past 200K context',
      'n/a',
      '10%',
      'n/a',
    ]);
  });

  it('leaves the comparison out until there is something to compare', () => {
    const early: TipsState = {
      ...STATE,
      tips: STATE.tips.map((tip) => ({
        ...tip,
        impact: { ...IMPACT, verdict: 'early', sessionsAfter: 0, weeks: [] },
      })),
    };
    const { getAllByRole, queryByRole } = renderView(<TipsView state={early} />);
    expect(getAllByRole('region', { name: /^Results since/u })[0]?.textContent).toContain(
      VERDICT_INFO.early.label,
    );
    expect(queryByRole('table', { name: 'Before and since' })).toBeNull();
    expect(queryByRole('table', { name: 'Week by week' })).toBeNull();
  });
});

describe('impact formatting', () => {
  it('formats each kind of value', () => {
    expect(formatImpactValue(null, 'usd')).toBe('n/a');
    expect(formatImpactValue(250_000, 'tokens')).toBe('250K');
    expect(formatImpactValue(0.25, 'percent')).toBe('25%');
    expect(formatImpactValue(1.25, 'per100')).toBe('1.3');
  });

  it('says which way a change went', () => {
    expect(formatChange({ ...TARGET, direction: null })).toBe('n/a');
    expect(formatChange({ ...TARGET, change: null, direction: 'worse' })).toBe(
      'up from none, worse',
    );
    expect(formatChange(TARGET)).toBe('-80%, better');
  });
});
