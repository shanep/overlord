// The banner for a rank change since you last looked: confetti for a
// promotion, a red shake for a demotion. The rank you last saw is kept with
// the webview state, so the banner waits until you dismiss it.

import type { ReactElement } from 'react';
import { useEffect } from 'react';

import { usePersistentState } from '../vscode-context.js';

import type { Rank } from './reputation-ranks.js';
import { RANKS } from './reputation-ranks.js';

const SEEN_KEY = 'reputationRank';
const CONFETTI = 36;
const COLORS = [
  'var(--ov-red)',
  'var(--ov-yellow)',
  'var(--ov-green)',
  'var(--ov-blue)',
  'var(--ov-purple)',
];

function isSeen(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Pieces spread across the banner with fixed offsets, so a render is repeatable. */
function Confetti(): ReactElement {
  return (
    <div className="rep-confetti" aria-hidden="true">
      {Array.from({ length: CONFETTI }, (_, index) => (
        <span
          key={index}
          style={{
            left: `${String((index * 37) % 100)}%`,
            animationDelay: `${String(((index * 53) % 20) / 10)}s`,
            animationDuration: `${String(2 + ((index * 29) % 10) / 10)}s`,
            backgroundColor: COLORS[index % COLORS.length],
          }}
        />
      ))}
    </div>
  );
}

export function RankChange(props: {
  readonly rank: Rank;
  /** False until the first scan, so the empty state does not count as a rank. */
  readonly ready: boolean;
}): ReactElement | null {
  const { rank, ready } = props;
  const [seen, setSeen] = usePersistentState<string | null>(SEEN_KEY, null, isSeen);
  // The first look sets the baseline without a banner.
  useEffect(() => {
    if (ready && seen === null) {
      setSeen(rank.name);
    }
  }, [ready, seen, rank.name, setSeen]);
  if (!ready || seen === null || seen === rank.name) {
    return null;
  }
  const up = RANKS.indexOf(rank) > RANKS.findIndex((item) => item.name === seen);
  return (
    <div className={up ? 'rep-change rep-change-up' : 'rep-change rep-change-down'} role="status">
      {up ? <Confetti /> : null}
      <span className="rep-change-icon" aria-hidden="true">
        {up ? '🎉' : '💀'}
      </span>
      <p>
        <strong>{up ? 'Promoted!' : 'Demoted!'}</strong>{' '}
        {up
          ? `You went from ${seen} to ${rank.name}. The machines approve.`
          : `You went from ${seen} to ${rank.name}. Skynet updated your file.`}
      </p>
      <button
        type="button"
        onClick={() => {
          setSeen(rank.name);
        }}
      >
        {up ? 'Nice' : 'Fair enough'}
      </button>
    </div>
  );
}
