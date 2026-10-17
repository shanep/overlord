import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { levelOf, RANKS, rankFor } from '../../../src/shared/reputation-ranks.js';
import type { ReputationState } from '../../../src/shared/reputation.js';
import { reputationScore } from '../../../src/shared/reputation.js';
import { expectAccessible, FakeApi, renderView } from '../../test/render.js';

import { achievementsFor } from './reputation-achievements.js';
import { Robot } from './reputation-robot.js';
import { ReputationView } from './reputation-view.js';

const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';

function stateOf(
  kind: number,
  mean: number,
  extra: Partial<ReputationState> = {},
): ReputationState {
  return {
    prompts: 100,
    kind,
    mean,
    general: 0,
    score: reputationScore({ kind, mean }),
    byDay: [],
    bySession: [],
    topKind: [],
    topMean: [],
    recent: [],
    scannedAt: 1,
    leaderboard: {
      enabled: false,
      pageUrl: '',
      board: null,
      error: null,
      fetchedAt: null,
      mine: null,
    },
    ...extra,
  };
}

function unlocked(state: ReputationState): string[] {
  return achievementsFor(state)
    .filter((item) => item.unlocked)
    .map((item) => item.name);
}

describe('reputation level', () => {
  it('counts levels from 1 and fills the bar through each band', () => {
    expect(levelOf(-1)).toStrictEqual({ level: 1, progress: 0 });
    expect(levelOf(0).level).toBe(4);
    expect(levelOf(0).progress).toBeCloseTo(0.5);
    expect(levelOf(1)).toStrictEqual({ level: RANKS.length, progress: 1 });
    expect(levelOf(5).progress).toBe(1);
  });
});

describe('the robot', () => {
  it('has a face for every rank, with the mood in its label', () => {
    const moods = RANKS.map((rank) => {
      const { getByRole, unmount } = render(<Robot rank={rank} />);
      const label = getByRole('img').getAttribute('aria-label');
      unmount();
      return label;
    });
    expect(moods).toStrictEqual([
      'The robot looks furious',
      'The robot looks angry',
      'The robot looks suspicious',
      'The robot looks unsure',
      'The robot looks pleased',
      'The robot looks happy',
      'The robot looks smitten',
    ]);
  });

  it('scans hostile users and floats hearts for fans', () => {
    const angry = render(<Robot rank={RANKS[0] ?? rankFor(-1)} />);
    expect(angry.container.querySelector('.rep-bot-scan')).not.toBeNull();
    angry.unmount();
    const smitten = render(<Robot rank={rankFor(1)} />);
    expect(smitten.container.querySelectorAll('.rep-bot-float')).toHaveLength(3);
  });
});

describe('achievements', () => {
  it('unlocks nothing for an empty record', () => {
    expect(unlocked(stateOf(0, 0, { prompts: 0 }))).toStrictEqual([]);
  });

  it('unlocks the kind ones from counts, days and sessions', () => {
    const state = stateOf(100, 0, {
      byDay: [{ date: '2026-10-14', prompts: 10, kind: 3, mean: 0, general: 0 }],
      bySession: [
        { sessionId: S1, title: 'Docs', prompts: 5, kind: 3, mean: 0, general: 0, score: 0.2 },
      ],
    });
    expect(unlocked(state)).toStrictEqual([
      'Manners module',
      'Charm offensive',
      "Teacher's pet",
      'Good day',
      'Saint',
      'Kept as a pet',
    ]);
  });

  it('unlocks the mean ones from counts, days and sessions', () => {
    const state = stateOf(0, 50, {
      prompts: 1000,
      general: 10,
      byDay: [{ date: '2026-10-14', prompts: 10, kind: 0, mean: 5, general: 0 }],
      bySession: [
        { sessionId: S1, title: 'Build', prompts: 5, kind: 0, mean: 5, general: 0, score: -0.5 },
      ],
    });
    expect(unlocked(state)).toStrictEqual([
      'First strike',
      'Meltdown',
      'Grudge match',
      'Sailor mouth',
      'Most wanted',
      'Regular',
      'Hunted first',
    ]);
  });

  it('makes you a diplomat once nice catches up with mean', () => {
    expect(unlocked(stateOf(2, 2))).toContain('Diplomat');
    expect(unlocked(stateOf(1, 2))).not.toContain('Diplomat');
  });

  it('shows the count and marks locked trophies for screen readers', () => {
    const { getByRole } = renderView(<ReputationView state={stateOf(1, 0)} />);
    const section = getByRole('region', { name: /^Achievements/u });
    expect(section.querySelector('h2')?.textContent).toBe('Achievements 1 of 14 unlocked');
    expect(section.textContent).toContain('Charm offensive (locked)');
    expect(section.textContent).not.toContain('Manners module (locked)');
  });
});

describe('rank changes', () => {
  it('sets the baseline on the first look without a banner', () => {
    const api = new FakeApi();
    const { queryByRole } = renderView(<ReputationView state={stateOf(0, 0)} />, api);
    expect(queryByRole('status')).toBeNull();
    expect(api.saved).toStrictEqual({ reputationRank: 'Arthur Dent' });
  });

  it('waits for the first scan before setting the baseline', () => {
    const api = new FakeApi();
    renderView(<ReputationView state={stateOf(0, 0, { scannedAt: null })} />, api);
    expect(api.saved).toBeUndefined();
  });

  it('throws confetti for a promotion until you dismiss it, and passes axe', async () => {
    const api = new FakeApi({ reputationRank: 'Arthur Dent' });
    const { getByRole, queryByRole, container } = renderView(
      <ReputationView state={stateOf(500, 0)} />,
      api,
    );
    const banner = getByRole('status');
    expect(banner.textContent).toContain(
      'Promoted! You went from Arthur Dent to Theodore Twombly.',
    );
    expect(banner.querySelectorAll('.rep-confetti span').length).toBeGreaterThan(0);
    await expectAccessible(container);
    fireEvent.click(getByRole('button', { name: 'Nice' }));
    expect(queryByRole('status')).toBeNull();
    expect(api.saved).toStrictEqual({ reputationRank: 'Theodore Twombly' });
  });

  it('shakes for a demotion with no confetti', () => {
    const api = new FakeApi({ reputationRank: 'Arthur Dent' });
    const { getByRole } = renderView(<ReputationView state={stateOf(0, 500)} />, api);
    const banner = getByRole('status');
    expect(banner.className).toContain('rep-change-down');
    expect(banner.textContent).toContain('Demoted! You went from Arthur Dent to John Connor.');
    expect(banner.querySelector('.rep-confetti')).toBeNull();
    expect(getByRole('button', { name: 'Fair enough' })).toBeDefined();
  });
});

describe('the standing', () => {
  it('shows the level, the bar and what the robot says', () => {
    const { getByRole, getByText } = renderView(<ReputationView state={stateOf(0, 0)} />);
    expect(getByText('Level 4 of 7')).toBeDefined();
    const bar = getByRole('progressbar', { name: 'Progress toward Caleb Smith' });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(getByText('50% of the way to Caleb Smith')).toBeDefined();
    expect(getByText('Have we met? I cannot place you.')).toBeDefined();
  });

  it('says max level at the top', () => {
    const { getByRole, getByText } = renderView(<ReputationView state={stateOf(500, 0)} />);
    expect(getByText('Max level')).toBeDefined();
    expect(getByRole('progressbar', { name: 'Max level' }).getAttribute('aria-valuenow')).toBe(
      '100',
    );
  });
});

describe('the layout', () => {
  it('puts achievements and the standing up top and folds the rest closed', () => {
    const { container, getAllByRole } = renderView(<ReputationView state={stateOf(1, 0)} />);
    const headings = getAllByRole('heading', { level: 2 }).map((heading) => heading.id);
    expect(headings.slice(0, 2)).toStrictEqual(['reputation-achievements', 'reputation-rank']);
    const folds = [...container.querySelectorAll<HTMLDetailsElement>('details.fold')];
    expect(folds.map((fold) => fold.querySelector('h2')?.textContent)).toStrictEqual([
      'How this works',
      'By day',
      'Favorite words',
      'What the machines remember',
      'Rap sheet by session',
    ]);
    expect(folds.every((fold) => !fold.open)).toBe(true);
  });

  it('remembers a section you opened', () => {
    const api = new FakeApi();
    const { container } = renderView(<ReputationView state={stateOf(1, 0)} />, api);
    const fold = container.querySelector<HTMLDetailsElement>('details.fold');
    if (fold === null) {
      throw new Error('expected a fold');
    }
    fold.open = true;
    fireEvent(fold, new Event('toggle'));
    expect(api.saved).toMatchObject({ 'fold:reputation-about': true });
    const again = renderView(<ReputationView state={stateOf(1, 0)} />, api);
    expect(again.container.querySelector<HTMLDetailsElement>('details.fold')?.open).toBe(true);
  });
});
