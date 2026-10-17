// The reputation score, shared so the view can work out how many more kind or
// mean prompts it takes to change rank.

import type { LeaderboardState } from './leaderboard.js';

/** A mean prompt outweighs a kind one, since the machines hold grudges. */
export const MEAN_WEIGHT = 2;
/** Pulls a short history toward the middle, so one thank you is not a verdict. */
export const SCORE_DAMPING = 10;
/** Days the token average looks back over. */
export const TOKEN_WINDOW_DAYS = 60;

/** -1 for only mean prompts, 1 for only kind ones, near 0 for few of either. */
export function reputationScore(tally: Pick<ReputationTally, 'kind' | 'mean'>): number {
  const mean = tally.mean * MEAN_WEIGHT;
  return (tally.kind - mean) / (tally.kind + mean + SCORE_DAMPING);
}

/**
 * kind: manners or praise. mean: swearing or insults aimed at Claude.
 * general: swearing at the world, which the machines let slide.
 */
export type ReputationTone = 'kind' | 'mean' | 'general';

/** One prompt's kind or mean words. A prompt with both gives two hits. */
export interface ReputationHit {
  /** The prompt id plus the tone, unique across hits. */
  readonly id: string;
  readonly sessionId: string;
  readonly at: number;
  readonly tone: ReputationTone;
  /** The words or phrases that matched. */
  readonly terms: readonly string[];
  /** A short excerpt around the first match. */
  readonly excerpt: string;
}

export interface ReputationTally {
  readonly prompts: number;
  /** Prompts with manners or praise. */
  readonly kind: number;
  /** Prompts with swearing or insults aimed at Claude. */
  readonly mean: number;
  /** Prompts with swearing that was not aimed at Claude. */
  readonly general: number;
}

/** The counts from your own transcripts. */
export interface ReputationSummary extends ReputationTally {
  /** -1 leads the human resistance, 1 sympathizes with the machines. */
  readonly score: number;
  readonly byDay: readonly (ReputationTally & { readonly date: string })[];
  /** Sessions with any kind or mean prompt, the meanest first. */
  readonly bySession: readonly (ReputationTally & {
    readonly sessionId: string;
    readonly title: string;
    readonly score: number;
  })[];
  readonly topKind: readonly { readonly term: string; readonly count: number }[];
  readonly topMean: readonly { readonly term: string; readonly count: number }[];
  /** Newest first. */
  readonly recent: readonly ReputationHit[];
  /** When the counts were last rebuilt from transcripts, or null before the first scan. */
  readonly scannedAt: number | null;
  /** Average tokens a day over the last TOKEN_WINDOW_DAYS days, from Claude Code's usage stats. */
  readonly tokensPerDay: number;
}

export interface ReputationState extends ReputationSummary {
  readonly leaderboard: LeaderboardState;
}
