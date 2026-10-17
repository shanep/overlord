// Your trophies, from the rules in src/shared/achievements.ts. Locked ones
// show what it takes to earn them.

import type { ReactElement } from 'react';

import { ACHIEVEMENTS } from '../../../src/shared/achievements.js';
import type { ReputationState } from '../../../src/shared/reputation.js';

export interface Achievement {
  readonly name: string;
  readonly icon: string;
  /** What it takes, shown whether it is unlocked or not. */
  readonly how: string;
  readonly unlocked: boolean;
}

export function achievementsFor(state: ReputationState): Achievement[] {
  return ACHIEVEMENTS.map((rule) => ({
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
