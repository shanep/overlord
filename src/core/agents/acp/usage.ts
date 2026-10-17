// Token counts from what session/prompt replies. The spec makes the reply a
// running total for the session, so each turn is the change since the last.

import type { Usage } from '@agentclientprotocol/sdk';

import type { TokenUsage } from '../../../shared/model.js';

/** How an agent reports usage on a session/prompt reply. */
export type UsageReport = 'cumulative' | 'per_turn';

/** ACP counts cached tokens inside input. Overlord's input is the uncached part. */
export function tokenUsage(usage: Usage): TokenUsage {
  const cacheRead = usage.cachedReadTokens ?? 0;
  const cacheCreation = usage.cachedWriteTokens ?? 0;
  return {
    input: Math.max(0, usage.inputTokens - cacheRead - cacheCreation),
    output: usage.outputTokens,
    cacheRead,
    cacheCreation,
    thinking: usage.thoughtTokens ?? 0,
  };
}

function minus(next: Usage, previous: Usage): Usage {
  return {
    totalTokens: next.totalTokens - previous.totalTokens,
    inputTokens: next.inputTokens - previous.inputTokens,
    outputTokens: next.outputTokens - previous.outputTokens,
    thoughtTokens: (next.thoughtTokens ?? 0) - (previous.thoughtTokens ?? 0),
    cachedReadTokens: (next.cachedReadTokens ?? 0) - (previous.cachedReadTokens ?? 0),
    cachedWriteTokens: (next.cachedWriteTokens ?? 0) - (previous.cachedWriteTokens ?? 0),
  };
}

function wentDown(delta: Usage): boolean {
  return Object.values(delta).some((count) => typeof count === 'number' && count < 0);
}

/**
 * Each turn's own usage. A cancelled turn that made no model call repeats the
 * last total and so adds nothing.
 */
export class UsageCounter {
  private readonly report: UsageReport;
  private last: Usage | null = null;
  private skipFirst: boolean;

  /** With skipFirst, the first total only sets the baseline, for a session that ran before. */
  constructor(report: UsageReport, skipFirst: boolean) {
    this.report = report;
    this.skipFirst = skipFirst;
  }

  turn(usage: Usage | null | undefined, cancelled: boolean): TokenUsage | null {
    if (usage === null || usage === undefined) {
      return null;
    }
    if (this.report === 'per_turn') {
      // A cancelled turn repeats the previous turn's numbers.
      return cancelled ? null : tokenUsage(usage);
    }
    const previous = this.last;
    this.last = usage;
    if (this.skipFirst) {
      this.skipFirst = false;
      return null;
    }
    const delta = previous === null ? usage : minus(usage, previous);
    // A total that went down means the agent started counting again.
    const tokens = tokenUsage(wentDown(delta) ? usage : delta);
    const counted = [
      tokens.input,
      tokens.output,
      tokens.cacheRead,
      tokens.cacheCreation,
      tokens.thinking,
    ];
    return counted.every((count) => count === 0) ? null : tokens;
  }
}
