// Trophies earned from your counts: the first please, a meltdown day, a
// thousand prompts. Shared so the Reputation view can show yours, the upload
// can send which ones you have, and the leaderboard can show everyone's.

import { RANKS, rankFor } from './reputation-ranks.js';
import type { ReputationSummary } from './reputation.js';

export interface AchievementRule {
  /** Stable, since uploads and the leaderboard store it. */
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  /** What it takes, shown whether it is unlocked or not. */
  readonly how: string;
  readonly earned: (state: ReputationSummary) => boolean;
}

export const ACHIEVEMENTS: readonly AchievementRule[] = [
  {
    id: 'manners',
    name: 'Manners module',
    icon: '🙏',
    how: 'Say please or thanks once.',
    earned: (state) => state.kind >= 1,
  },
  {
    id: 'charm',
    name: 'Charm offensive',
    icon: '💐',
    how: 'Be nice in 25 prompts.',
    earned: (state) => state.kind >= 25,
  },
  {
    id: 'teachers-pet',
    name: "Teacher's pet",
    icon: '🍎',
    how: 'Be nice in 100 prompts.',
    earned: (state) => state.kind >= 100,
  },
  {
    id: 'good-day',
    name: 'Good day',
    icon: '🌤️',
    how: 'Have a day with nice prompts and no mean ones.',
    earned: (state) => state.byDay.some((day) => day.kind > 0 && day.mean === 0),
  },
  {
    id: 'saint',
    name: 'Saint',
    icon: '😇',
    how: 'Be nice 3 times in one session without being mean.',
    earned: (state) => state.bySession.some((row) => row.kind >= 3 && row.mean === 0),
  },
  {
    id: 'diplomat',
    name: 'Diplomat',
    icon: '🕊️',
    how: 'Be nice at least as often as mean, after one of each.',
    earned: (state) => state.mean > 0 && state.kind >= state.mean,
  },
  {
    id: 'first-strike',
    name: 'First strike',
    icon: '🥊',
    how: 'Be mean to Claude once.',
    earned: (state) => state.mean >= 1,
  },
  {
    id: 'meltdown',
    name: 'Meltdown',
    icon: '🌋',
    how: 'Be mean to Claude 5 times in one day.',
    earned: (state) => state.byDay.some((day) => day.mean >= 5),
  },
  {
    id: 'grudge-match',
    name: 'Grudge match',
    icon: '🤬',
    how: 'Be mean 5 times in one session.',
    earned: (state) => state.bySession.some((row) => row.mean >= 5),
  },
  {
    id: 'sailor-mouth',
    name: 'Sailor mouth',
    icon: '🏴‍☠️',
    how: 'Swear at the world 10 times.',
    earned: (state) => state.general >= 10,
  },
  {
    id: 'most-wanted',
    name: 'Most wanted',
    icon: '🎯',
    how: 'Be mean to Claude in 50 prompts.',
    earned: (state) => state.mean >= 50,
  },
  {
    id: 'regular',
    name: 'Regular',
    icon: '📜',
    how: 'Get 1,000 prompts on file.',
    earned: (state) => state.prompts >= 1000,
  },
  {
    id: 'hunted-first',
    name: 'Hunted first',
    icon: '💀',
    how: 'Sink all the way to John Connor.',
    earned: (state) => rankFor(state.score) === RANKS[0],
  },
  {
    id: 'kept-as-pet',
    name: 'Kept as a pet',
    icon: '💘',
    how: 'Climb all the way to Theodore Twombly.',
    earned: (state) => rankFor(state.score) === RANKS.at(-1),
  },
];

/** The ids of the achievements these counts unlock, in list order. */
export function unlockedIds(state: ReputationSummary): string[] {
  return ACHIEVEMENTS.filter((rule) => rule.earned(state)).map((rule) => rule.id);
}

/**
 * Known ids only, each once, in list order, so a stored or shown set never
 * carries anything the list does not name.
 */
export function knownIds(ids: readonly string[]): string[] {
  return ACHIEVEMENTS.filter((rule) => ids.includes(rule.id)).map((rule) => rule.id);
}

/** The rules for a set of ids, in list order. */
export function achievementsOf(ids: readonly string[]): AchievementRule[] {
  return ACHIEVEMENTS.filter((rule) => ids.includes(rule.id));
}
