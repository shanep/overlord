// What the tips view shows: advice from the session transcripts, each with
// its pros and cons, and the skills and agents Overlord can write.

export type TipSeverity = 'high' | 'medium' | 'low';

/** A session that shows the problem a tip is about. */
export interface TipSession {
  readonly sessionId: string;
  readonly title: string;
  /** The number that put it on the list, for example "949K peak context". */
  readonly detail: string;
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

/** One session's numbers in the tips table. */
export interface TipsSessionRow {
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

export interface TipsState {
  readonly sessions: number;
  readonly totalUsd: number;
  readonly cacheReadUsd: number;
  /** Context tokens per main thread request, averaged over every session. */
  readonly averageContext: number;
  readonly largestContext: number;
  readonly tips: readonly Tip[];
  readonly suggestions: readonly Suggestion[];
  /** Most expensive first. */
  readonly rows: readonly TipsSessionRow[];
  /** When the transcripts were last measured, or null before the first scan. */
  readonly scannedAt: number | null;
}
