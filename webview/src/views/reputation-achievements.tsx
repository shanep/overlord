// Trophies earned from your counts: the first please, a meltdown day, a
// thousand prompts. Locked ones show what it takes to earn them.

import type { ReactElement } from 'react';

import { RANKS, rankFor } from '../../../src/shared/reputation-ranks.js';
import type { ReputationState } from '../../../src/shared/reputation.js';
import { formatInteger } from '../format.js';

export interface Achievement {
  readonly name: string;
  readonly icon: string;
  /** What it takes, shown whether it is unlocked or not. */
  readonly how: string;
  readonly unlocked: boolean;
}

interface Rule {
  readonly name: string;
  readonly icon: string;
  readonly how: string;
  readonly earned: (state: ReputationState) => boolean;
}

const RULES: readonly Rule[] = [
  {
    name: 'Manners module',
    icon: '🙏',
    how: 'Say please or thanks once.',
    earned: (state) => state.kind >= 1,
  },
  {
    name: 'Charm offensive',
    icon: '💐',
    how: 'Be nice in 25 prompts.',
    earned: (state) => state.kind >= 25,
  },
  {
    name: "Teacher's pet",
    icon: '🍎',
    how: 'Be nice in 100 prompts.',
    earned: (state) => state.kind >= 100,
  },
  {
    name: 'Good day',
    icon: '🌤️',
    how: 'Have a day with nice prompts and no mean ones.',
    earned: (state) => state.byDay.some((day) => day.kind > 0 && day.mean === 0),
  },
  {
    name: 'Saint',
    icon: '😇',
    how: 'Be nice 3 times in one session without being mean.',
    earned: (state) => state.bySession.some((row) => row.kind >= 3 && row.mean === 0),
  },
  {
    name: 'Diplomat',
    icon: '🕊️',
    how: 'Be nice at least as often as mean, after one of each.',
    earned: (state) => state.mean > 0 && state.kind >= state.mean,
  },
  {
    name: 'First strike',
    icon: '🥊',
    how: 'Be mean to Claude once.',
    earned: (state) => state.mean >= 1,
  },
  {
    name: 'Meltdown',
    icon: '🌋',
    how: 'Be mean to Claude 5 times in one day.',
    earned: (state) => state.byDay.some((day) => day.mean >= 5),
  },
  {
    name: 'Grudge match',
    icon: '🤬',
    how: 'Be mean 5 times in one session.',
    earned: (state) => state.bySession.some((row) => row.mean >= 5),
  },
  {
    name: 'Sailor mouth',
    icon: '🏴‍☠️',
    how: 'Swear at the world 10 times.',
    earned: (state) => state.general >= 10,
  },
  {
    name: 'Most wanted',
    icon: '🎯',
    how: 'Be mean to Claude in 50 prompts.',
    earned: (state) => state.mean >= 50,
  },
  {
    name: 'Regular',
    icon: '📜',
    how: `Get ${formatInteger(1000)} prompts on file.`,
    earned: (state) => state.prompts >= 1000,
  },
  {
    name: 'Hunted first',
    icon: '💀',
    how: 'Sink all the way to John Connor.',
    earned: (state) => rankFor(state.score) === RANKS[0],
  },
  {
    name: 'Kept as a pet',
    icon: '💘',
    how: 'Climb all the way to Theodore Twombly.',
    earned: (state) => rankFor(state.score) === RANKS.at(-1),
  },
];

export function achievementsFor(state: ReputationState): Achievement[] {
  return RULES.map((rule) => ({
    name: rule.name,
    icon: rule.icon,
    how: rule.how,
    unlocked: rule.earned(state),
  }));
}

export function Achievements(props: { readonly state: ReputationState }): ReactElement {
  const items = achievementsFor(props.state);
  const unlocked = items.filter((item) => item.unlocked).length;
  return (
    <section className="section" aria-labelledby="reputation-achievements">
      <h2 id="reputation-achievements">
        Achievements{' '}
        <span className="muted rep-count">
          {unlocked} of {items.length} unlocked
        </span>
      </h2>
      <ul className="rep-trophies">
        {items.map((item) => (
          <li key={item.name} className={item.unlocked ? 'rep-trophy' : 'rep-trophy rep-locked'}>
            <span className="rep-trophy-icon" aria-hidden="true">
              {item.unlocked ? item.icon : '🔒'}
            </span>
            <span className="rep-trophy-name">
              {item.name}
              {item.unlocked ? null : <span className="visually-hidden"> (locked)</span>}
            </span>
            <span className="rep-trophy-how">{item.how}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
