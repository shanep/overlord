import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../../shared/model.js';
import { ZERO_USAGE } from '../../shared/model.js';
import type { FleetProgress, TaskProgress } from '../../shared/progress.js';
import type { FleetState } from '../../shared/protocol.js';

import { checkProgress, ProgressWatch, SET_BUDGET, STOP } from './progress-alerts.js';
import { makeApp, makeEnv, NOW, session, waitFor } from './test-helpers/fixtures.js';

function tasks(done: number, total: number, spent: number, left: number | null): TaskProgress {
  return {
    done,
    inProgress: 0,
    total,
    current: null,
    startedAt: NOW,
    tokensSpent: spent,
    estimate:
      left === null
        ? null
        : {
            tokensLeft: left,
            costLeftUsd: null,
            msLeft: 1000,
            finishAt: NOW + 1000,
            basis: done,
            limitRunsOutAt: null,
          },
  };
}

function fleet(
  progress: Partial<FleetProgress>,
  overrides: Partial<SessionSummary> = {},
): Pick<FleetState, 'sessions' | 'progress'> {
  return {
    sessions: [session('s1', { title: 'Big run', ...overrides })],
    progress: { s1: { tasks: null, subagents: null, budget: null, ...progress } },
  };
}

const NEVER_WARNED = (): boolean => false;

describe('ProgressWatch', () => {
  it('warns about a used up budget until the budget says it warned', () => {
    const watch = new ProgressWatch();
    const state = fleet({ budget: { tokens: 1_000_000, used: 1_200_000 } });
    expect(watch.review(state, NEVER_WARNED)).toStrictEqual([
      {
        sessionId: 's1',
        kind: 'budget',
        message: 'Big run has used its token budget: 1.2M of 1M.',
      },
    ]);
    expect(watch.review(state, () => true)).toStrictEqual([]);
    expect(
      watch.review(fleet({ budget: { tokens: 1_000_000, used: 900_000 } }), NEVER_WARNED),
    ).toStrictEqual([]);
  });

  it('warns once when a task list runs past 1.5 times its first steady estimate', () => {
    const watch = new ProgressWatch();
    // One finished task of nine is not steady yet, so it sets no plan.
    expect(
      watch.review(fleet({ tasks: tasks(1, 9, 100_000_000, 800_000_000) }), NEVER_WARNED),
    ).toStrictEqual([]);
    // Three of nine is: 300M spent and 600M left plans 900M.
    expect(
      watch.review(fleet({ tasks: tasks(3, 9, 300_000_000, 600_000_000) }), NEVER_WARNED),
    ).toStrictEqual([]);
    expect(
      watch.review(fleet({ tasks: tasks(5, 9, 1_350_000_000, 1_000_000_000) }), NEVER_WARNED),
    ).toStrictEqual([]);
    const alerts = watch.review(
      fleet({ tasks: tasks(6, 9, 1_400_000_000, 700_000_000) }),
      NEVER_WARNED,
    );
    expect(alerts).toStrictEqual([
      {
        sessionId: 's1',
        kind: 'overrun',
        message:
          'Big run has used 1400M tokens on its task list, more than 1.5 times the 900M it looked ' +
          'set to need when 3 of 9 tasks were done. It has done 6 of 9.',
      },
    ]);
    expect(
      watch.review(fleet({ tasks: tasks(7, 9, 2_000_000_000, 500_000_000) }), NEVER_WARNED),
    ).toStrictEqual([]);
  });

  it('settles a short list sooner, plans a new list again, and skips finished work', () => {
    const watch = new ProgressWatch();
    expect(watch.review(fleet({ tasks: tasks(1, 3, 100, 200) }), NEVER_WARNED)).toStrictEqual([]);
    expect(watch.review(fleet({ tasks: tasks(2, 3, 500, 100) }), NEVER_WARNED)).toHaveLength(1);
    const fresh = { ...tasks(1, 3, 100, 200), startedAt: NOW + 1 };
    expect(watch.review(fleet({ tasks: fresh }), NEVER_WARNED)).toStrictEqual([]);
    const allDone = { ...tasks(3, 3, 5000, null), startedAt: NOW + 1 };
    expect(watch.review(fleet({ tasks: allDone }), NEVER_WARNED)).toStrictEqual([]);
    const over = fleet({ budget: { tokens: 1, used: 2 } }, { state: 'done' });
    expect(watch.review(over, NEVER_WARNED)).toStrictEqual([]);
  });
});

describe('checkProgress', () => {
  it('warns once about a used up budget and offers to stop the session or set its budget', async () => {
    const env = await makeEnv();
    const test = makeApp(env);
    test.bus.emit(
      'session.upserted',
      session('s1', { title: 'Big run', usage: { ...ZERO_USAGE, input: 5_000_000 } }),
    );
    await test.app.runtime.budgets.set('s1', 1_000_000);
    env.host.askAnswers.push(SET_BUDGET);
    env.host.inputAnswers.push('10M');
    const watch = new ProgressWatch();
    void checkProgress(test.app.runtime, watch);
    await waitFor(() => test.app.runtime.budgets.get('s1') === 10_000_000);
    expect(env.host.asks).toStrictEqual([
      { message: 'Big run has used its token budget: 5M of 1M.', actions: [STOP, SET_BUDGET] },
    ]);
    await checkProgress(test.app.runtime, watch);
    expect(env.host.asks).toHaveLength(1);
  });
});
