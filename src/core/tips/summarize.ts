// Turns the session measures into what the tips view shows.

import type { TipsSessionRow, TipsState } from '../../shared/tips.js';

import type { SessionMeasure } from './measure.js';
import { buildTips, cacheReadShare, tipsFor } from './rules.js';
import { buildSuggestions } from './suggestions.js';
import { sessionUsd, totalsOf } from './totals.js';

const MAX_ROWS = 200;

export interface SummaryInputs {
  readonly measures: readonly SessionMeasure[];
  /** Ids of suggestions already saved as a skill or agent. */
  readonly installed: ReadonlySet<string>;
  readonly home: string;
  readonly scannedAt: number | null;
}

export function summarize(inputs: SummaryInputs): TipsState {
  // A session with no requests was opened and left, so it says nothing about habits.
  const measures = inputs.measures.filter((measure) => measure.requests > 0);
  const totals = totalsOf(measures, inputs.home);
  const tips = buildTips(totals, measures);
  const rows: TipsSessionRow[] = measures
    .map((measure) => ({
      sessionId: measure.sessionId,
      title: measure.title,
      updatedAt: measure.updatedAt,
      prompts: measure.prompts,
      requests: measure.requests,
      peakContext: measure.peakContext,
      averageContext: measure.contextTokens / measure.requests,
      costUsd: sessionUsd(measure),
      cacheReadShare: cacheReadShare(measure),
      tips: tipsFor(measure, tips),
    }))
    .toSorted((left, right) => right.costUsd - left.costUsd)
    .slice(0, MAX_ROWS);
  return {
    sessions: totals.sessions,
    totalUsd: totals.totalUsd,
    cacheReadUsd: totals.cacheReadUsd,
    averageContext: totals.requests === 0 ? 0 : totals.contextTokens / totals.requests,
    largestContext: totals.largestContext,
    tips,
    suggestions: buildSuggestions(totals, inputs.installed),
    rows,
    scannedAt: inputs.scannedAt,
  };
}
