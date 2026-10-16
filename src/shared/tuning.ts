// What the Tuning view shows: advice from the session transcripts, each with
// its pros and cons, and the skills and agents Overlord can write.

export type TipSeverity = 'high' | 'medium' | 'low';

/** A session that shows the problem a tip is about. */
export interface TipSession {
  readonly sessionId: string;
  readonly title: string;
  /** The number that put it on the list, for example "949K peak context". */
  readonly detail: string;
}

/** How a measured number is shown. */
export type ImpactFormat = 'tokens' | 'usd' | 'percent' | 'per100';

/** Which way a number moved, judged by whether lower is better. */
export type ImpactDirection = 'better' | 'worse' | 'same';

/**
 * The overall answer. `early` until enough sessions ran after tracking
 * started, `no-baseline` when nothing ran in the weeks before to compare with.
 */
export type ImpactVerdict = 'better' | 'worse' | 'mixed' | 'same' | 'early' | 'no-baseline';

/** One number compared before and after a tip was taken up. Lower is better for all of them. */
export interface ImpactMetric {
  readonly id: string;
  readonly label: string;
  /** The habit the tip is about, the cost, or a side effect its cons warn about. */
  readonly role: 'target' | 'cost' | 'side-effect';
  /** Why a side effect is worth watching, empty for the others. */
  readonly why: string;
  readonly format: ImpactFormat;
  readonly before: number | null;
  readonly after: number | null;
  /** (after - before) / before, or null when that cannot be worked out. */
  readonly change: number | null;
  /** Null when either side has no data. */
  readonly direction: ImpactDirection | null;
}

/** One week since tracking started. */
export interface ImpactWeek {
  readonly start: number;
  readonly sessions: number;
  /** One value per metric, in the same order as `TipImpact.metrics`. */
  readonly values: readonly (number | null)[];
}

/** What changed since you started following a tip. */
export interface TipImpact {
  readonly trackedSince: number;
  readonly verdict: ImpactVerdict;
  /** One or two sentences that say what moved. */
  readonly summary: string;
  readonly sessionsBefore: number;
  readonly sessionsAfter: number;
  readonly metrics: readonly ImpactMetric[];
  /** Oldest first, at most the last few weeks. */
  readonly weeks: readonly ImpactWeek[];
}

/** One piece of advice, backed by numbers from the session transcripts. */
export interface Tip {
  readonly id: string;
  readonly severity: TipSeverity;
  readonly title: string;
  /** What the transcripts show, with numbers. */
  readonly finding: string;
  /** What to do about it, one step per entry. */
  readonly advice: readonly string[];
  /** The worst sessions, worst first. */
  readonly sessions: readonly TipSession[];
  /** Ids of suggested skills or agents that help with it. */
  readonly fixes: readonly string[];
  /** What following the advice gains. */
  readonly pros: readonly string[];
  /** What it gives up, such as context built up over a long session. */
  readonly cons: readonly string[];
  /** When the advice is not worth following. */
  readonly skipWhen: string;
  /** The measured effect since you started following it, or null when you are not tracking it. */
  readonly impact: TipImpact | null;
}

/** A skill or agent Overlord can write for you, with why it would help. */
export interface Suggestion {
  readonly id: string;
  readonly kind: 'skill' | 'agent';
  /** The file name and the name Claude Code shows. */
  readonly name: string;
  readonly summary: string;
  readonly pros: readonly string[];
  readonly cons: readonly string[];
  /** What in the transcripts points at it, or null when nothing does yet. */
  readonly reason: string | null;
  /** True when a skill or agent with this name is already in ~/.claude. */
  readonly installed: boolean;
}

/** One session's numbers in the Tuning view's session table. */
export interface TuningSessionRow {
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly prompts: number;
  readonly requests: number;
  readonly peakContext: number;
  readonly averageContext: number;
  /** Main thread plus subagents, at list price. */
  readonly costUsd: number;
  /** Share of the cost that went to re-reading cached context. */
  readonly cacheReadShare: number;
  /** Ids of the tips that list this session. */
  readonly tips: readonly string[];
}

export interface TuningState {
  readonly sessions: number;
  readonly totalUsd: number;
  readonly cacheReadUsd: number;
  /** Context tokens per main thread request, averaged over every session. */
  readonly averageContext: number;
  readonly largestContext: number;
  readonly tips: readonly Tip[];
  readonly suggestions: readonly Suggestion[];
  /** Most expensive first. */
  readonly rows: readonly TuningSessionRow[];
  /** When the transcripts were last measured, or null before the first scan. */
  readonly scannedAt: number | null;
}
