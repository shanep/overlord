// Projects what a session has left from how much of its task list is done.
// The share done so far cost so many tokens and so much time, so the rest
// should cost about the same per share. Tasks in progress count as half done.
// The guess is rough with few tasks finished, and the Fleet says so.

import type { ProgressEstimate, TaskList, TaskProgress } from '../../shared/progress.js';
import type { PlanLimit } from '../../shared/protocol.js';
import { runsOutAt, SESSION_WINDOW_MS } from '../tuning/limit.js';

export interface EstimateInput {
  readonly list: TaskList;
  /** When the session last wrote anything, so time spent idle at the end does not count. */
  readonly lastActiveAt: number;
  readonly now: number;
  /** Tokens and cost since the task list started. */
  readonly tokensSpent: number;
  readonly costSpentUsd: number | null;
  /** The plan's 5 hour window, when /usage reported it. */
  readonly window: PlanLimit | null;
}

/** When the window runs out before `finishAt`, else null. */
function limitBefore(window: PlanLimit | null, now: number, finishAt: number): number | null {
  const resetsAt = window?.resetsAt ?? null;
  if (window === null || resetsAt === null) {
    return null;
  }
  const out = runsOutAt(window, resetsAt - SESSION_WINDOW_MS, now);
  return out !== null && out < finishAt ? out : null;
}

function projected(input: EstimateInput, done: number, share: number): ProgressEstimate | null {
  const elapsed = input.lastActiveAt - input.list.startedAt;
  if (done === 0 || share >= 1 || elapsed <= 0) {
    return null;
  }
  const rest = (1 - share) / share;
  const msLeft = Math.round(elapsed * rest);
  const finishAt = input.now + msLeft;
  return {
    tokensLeft: Math.round(input.tokensSpent * rest),
    costLeftUsd: input.costSpentUsd === null ? null : input.costSpentUsd * rest,
    msLeft,
    finishAt,
    basis: done,
    limitRunsOutAt: limitBefore(input.window, input.now, finishAt),
  };
}

export function taskProgress(input: EstimateInput): TaskProgress {
  const { items, startedAt } = input.list;
  const done = items.filter((item) => item.status === 'completed').length;
  const active = items.filter((item) => item.status === 'in_progress');
  const total = items.length;
  const share = (done + active.length / 2) / total;
  return {
    done,
    inProgress: active.length,
    total,
    current: active.at(0)?.subject ?? null,
    startedAt,
    tokensSpent: input.tokensSpent,
    estimate: projected(input, done, share),
  };
}
