// Turns the session measures into what the Tuning view shows.

import type { PlanLimits } from '../../shared/protocol.js';
import type { TuningSessionRow, TuningState } from '../../shared/tuning.js';

import { buildTips, tipsFor } from './build.js';
import { buildLimit } from './limit.js';
import type { SessionMeasure } from './measure.js';
import { cacheReadShare } from './rules.js';
import { buildSuggestions } from './suggestions.js';
import { sessionUsd, totalsOf } from './totals.js';

const MAX_ROWS = 200;

export interface SummaryInputs {
  /** Sessions whose transcript is still on disk. */
  readonly measures: readonly SessionMeasure[];
  /** Sessions whose transcript Claude Code has since deleted. */
  readonly history: readonly SessionMeasure[];
  /** When you started following each tracked tip, by tip id. */
  readonly tracked: ReadonlyMap<string, number>;
  readonly now: number;
  /** Ids of suggestions already saved as a skill or agent. */
  readonly installed: ReadonlySet<string>;
  readonly home: string;
  readonly scannedAt: number | null;
  /** The plan limits, or null when they do not apply or could not be read. */
  readonly plan: PlanLimits | null;
}

export function summarize(inputs: SummaryInputs): TuningState {
  // A session with no requests was opened and left, so it says nothing about habits.
  const measures = inputs.measures.filter((measure) => measure.requests > 0);
  const totals = totalsOf(measures, inputs.home);
  const tips = buildTips({
    totals,
    live: measures,
    all: [...measures, ...inputs.history],
    tracked: inputs.tracked,
    now: inputs.now,
  });
  const rows: TuningSessionRow[] = measures
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
    limit: buildLimit({
      plan: inputs.plan,
      measures: [...measures, ...inputs.history],
      now: inputs.now,
    }),
    rows,
    scannedAt: inputs.scannedAt,
  };
}
