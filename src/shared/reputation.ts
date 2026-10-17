// The reputation score, shared so the view can work out how many more kind or
// mean prompts it takes to change rank.

import type { ReputationTally } from './protocol.js';

/** A mean prompt outweighs a kind one, since the machines hold grudges. */
export const MEAN_WEIGHT = 2;
/** Pulls a short history toward the middle, so one thank you is not a verdict. */
export const SCORE_DAMPING = 10;

/** -1 for only mean prompts, 1 for only kind ones, near 0 for few of either. */
export function reputationScore(tally: Pick<ReputationTally, 'kind' | 'mean'>): number {
  const mean = tally.mean * MEAN_WEIGHT;
  return (tally.kind - mean) / (tally.kind + mean + SCORE_DAMPING);
}
