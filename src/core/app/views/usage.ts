// The usage view: history from ~/.claude/stats-cache.json plus the plan
// limits /usage shows, read through the Agent SDK.

import type { PlanLimits, UsageState, UsageStats } from '../../../shared/protocol.js';
import type { ClaudePaths } from '../../paths.js';
import { parsePlanUsage } from '../../surfaces/plan-limits.js';
import { EMPTY_USAGE, readUsageHistory } from '../../surfaces/usage.js';
import type { Runtime } from '../runtime.js';

/** Plan limits older than this are read again the next time the view renders. */
export const PLAN_STALE_MS = 5 * 60_000;

export async function loadUsage(
  paths: ClaudePaths,
  report: (source: string, message: string) => void,
): Promise<UsageStats> {
  const read = await readUsageHistory(paths);
  for (const error of read.errors) {
    report('usage', error.message);
  }
  return read.history?.usage ?? EMPTY_USAGE;
}

export async function loadPlanLimits(
  read: () => Promise<unknown>,
  clock: () => number,
): Promise<PlanLimits | null> {
  return parsePlanUsage(await read(), clock());
}

/** The plan limits, loading them on first use and again once they go stale. */
export function currentPlan(rt: Runtime): PlanLimits | null {
  const { plan } = rt.caches;
  const limits = plan.value;
  if (limits !== null && !plan.loading && rt.clock() - limits.fetchedAt > PLAN_STALE_MS) {
    void plan.refresh();
  }
  return limits;
}

export function buildUsage(rt: Runtime): UsageState {
  return { ...rt.caches.usage.value, plan: currentPlan(rt) };
}
