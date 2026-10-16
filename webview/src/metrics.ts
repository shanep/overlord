// Derived numbers shared by several views.

import type { TokenUsage } from '../../src/shared/model.js';

/** Every token the model read or wrote. */
export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
}

/** Tokens sent to the model as input, cached or not. */
export function promptTokens(usage: TokenUsage): number {
  return usage.input + usage.cacheRead + usage.cacheCreation;
}

/** Share of prompt tokens served from cache, or null with no prompt tokens. */
export function cacheHitRatio(usage: TokenUsage): number | null {
  const prompt = promptTokens(usage);
  return prompt === 0 ? null : usage.cacheRead / prompt;
}

/** Average tool calls per minute between `startedAt` and `endedAt` (or now). */
export function callsPerMinute(count: number, startedAt: number, endedAt: number): number {
  const minutes = (endedAt - startedAt) / 60_000;
  return minutes <= 0 ? 0 : count / minutes;
}
