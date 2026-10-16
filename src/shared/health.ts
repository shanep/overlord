// Session health for the properties panel: signs that a session is starting
// to work worse than it did, and what to do about each one.

export type HealthLevel = 'good' | 'watch' | 'degraded';

type HealthSignalId = 'context' | 'compactions' | 'tool-errors' | 'cache' | 'age';

/** One sign of trouble, with the numbers behind it and what to do. */
export interface HealthSignal {
  readonly id: HealthSignalId;
  readonly level: Exclude<HealthLevel, 'good'>;
  readonly title: string;
  /** What was measured, for example "640K tokens, 64% of a 1M window". */
  readonly finding: string;
  /** Why it hurts the work. */
  readonly why: string;
  /** What to do, most useful first. */
  readonly actions: readonly string[];
}

/** The numbers the signals are built from, shown even when all is well. */
export interface HealthMetrics {
  /** Prompt tokens on the main thread's latest request. */
  readonly contextTokens: number | null;
  readonly contextWindow: number | null;
  readonly compactions: number;
  /** Requests the main thread has made, one per model turn. */
  readonly turns: number;
  /** Failed calls among the main thread's latest finished tool calls. */
  readonly recentToolErrors: number;
  readonly recentToolCalls: number;
  /** Share of the prompt read from the cache over the latest turns. */
  readonly recentCacheHit: number | null;
}

export interface SessionHealth {
  /** The worst level among the signals, or good with none. */
  readonly level: HealthLevel;
  readonly metrics: HealthMetrics;
  /** Worst first. */
  readonly signals: readonly HealthSignal[];
}
