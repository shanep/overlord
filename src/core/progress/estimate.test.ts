import { describe, expect, it } from 'vitest';

import type { TaskItem, TaskStatus } from '../../shared/progress.js';
import type { PlanLimit } from '../../shared/protocol.js';

import type { EstimateInput } from './estimate.js';
import { taskProgress } from './estimate.js';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function items(...statuses: TaskStatus[]): TaskItem[] {
  return statuses.map((status, index) => ({
    id: String(index + 1),
    subject: `Task ${String(index + 1)}`,
    status,
  }));
}

function input(statuses: TaskStatus[], overrides: Partial<EstimateInput> = {}): EstimateInput {
  return {
    list: { items: items(...statuses), startedAt: T0 },
    lastActiveAt: T0 + HOUR,
    now: T0 + HOUR,
    tokensSpent: 1_000_000,
    costSpentUsd: 10,
    window: null,
    ...overrides,
  };
}

function window(percent: number, resetsAt: number): PlanLimit {
  return { kind: 'session', label: 'Current session', percent, resetsAt, severity: 'normal' };
}

describe('taskProgress', () => {
  it('counts tasks and names the first one in progress', () => {
    const progress = taskProgress(input(['completed', 'in_progress', 'in_progress', 'pending']));
    expect(progress).toMatchObject({ done: 1, inProgress: 2, total: 4, current: 'Task 2' });
  });

  it('projects the rest at the pace of the share done, counting work in progress as half', () => {
    // 1 done and 2 half done of 4 is half the list, so the rest costs as much again.
    const progress = taskProgress(input(['completed', 'in_progress', 'in_progress', 'pending']));
    expect(progress.estimate).toStrictEqual({
      tokensLeft: 1_000_000,
      costLeftUsd: 10,
      msLeft: HOUR,
      finishAt: T0 + 2 * HOUR,
      basis: 1,
      limitRunsOutAt: null,
    });
  });

  it('times from the last activity, so idle time at the end does not stretch the estimate', () => {
    const progress = taskProgress(
      input(['completed', 'pending'], { lastActiveAt: T0 + HOUR, now: T0 + 3 * HOUR }),
    );
    expect(progress.estimate).toMatchObject({ msLeft: HOUR, finishAt: T0 + 4 * HOUR });
  });

  it('has no estimate before a task is done or once all are', () => {
    expect(taskProgress(input(['in_progress', 'pending'])).estimate).toBeNull();
    expect(taskProgress(input(['completed', 'completed'])).estimate).toBeNull();
  });

  it('leaves the cost unknown when the spend is', () => {
    const progress = taskProgress(input(['completed', 'pending'], { costSpentUsd: null }));
    expect(progress.estimate?.costLeftUsd).toBeNull();
  });

  it('says when the 5 hour window runs out before the work finishes', () => {
    // An hour into the window it is 50% used, so it fills an hour from now,
    // well before the reset and before the 3 hours of work left.
    const now = T0 + HOUR;
    const limit = window(50, now + 4 * HOUR);
    const progress = taskProgress(
      input(['completed', 'pending', 'pending', 'pending'], { window: limit }),
    );
    expect(progress.estimate?.finishAt).toBe(now + 3 * HOUR);
    expect(progress.estimate?.limitRunsOutAt).toBe(now + HOUR);
  });

  it('does not warn when the work finishes before the window runs out', () => {
    const now = T0 + HOUR;
    const progress = taskProgress(
      input(['completed', 'completed', 'completed', 'pending'], {
        window: window(50, now + 4 * HOUR),
      }),
    );
    expect(progress.estimate?.limitRunsOutAt).toBeNull();
  });
});
