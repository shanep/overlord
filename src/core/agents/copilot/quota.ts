// Copilot's monthly premium request quota as a usage limit window. Every
// model call writes the account's quotas to the session file, so the newest
// call in any session has the current numbers.

import { COPILOT, type RateLimitWindow } from '../../../shared/agents.js';
import type { RateLimitReport } from '../types.js';

import { modelCallSchema, type QuotaSnapshot } from './events.js';

/** The quota that runs out. Chat and completions are unlimited on paid plans. */
export const PREMIUM_QUOTA = 'premium_interactions';

/** The premium request window, or null when the plan has no cap on it. */
export function premiumWindow(
  snapshots: Readonly<Record<string, QuotaSnapshot | null>> | null | undefined,
): RateLimitWindow | null {
  const quota = snapshots?.[PREMIUM_QUOTA];
  if (
    quota === null ||
    quota === undefined ||
    quota.isUnlimitedEntitlement === true ||
    quota.remainingPercentage === null ||
    quota.remainingPercentage === undefined
  ) {
    return null;
  }
  const resetsAt =
    quota.resetDate === null || quota.resetDate === undefined
      ? Number.NaN
      : Date.parse(quota.resetDate);
  return {
    agent: COPILOT,
    id: PREMIUM_QUOTA,
    label: 'Monthly',
    // Percent on the bus, like Codex's used_percent.
    usedPct: Math.min(100, Math.max(0, 100 - quota.remainingPercentage)),
    resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
  };
}

/** The premium request quota a model call left, or nothing when the call reports none. */
export function quotaLimits(data: unknown, at: number): { rateLimits?: RateLimitReport } {
  const parsed = modelCallSchema.safeParse(data);
  const window = parsed.success ? premiumWindow(parsed.data.quotaSnapshots) : null;
  return window === null ? {} : { rateLimits: { at, windows: [window] } };
}
