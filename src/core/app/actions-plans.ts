// Actions for plans in the Launcher: draft one for a goal, approve it, stop
// it, retry a task, and discard it.

import type { ActionHandlers } from './action-types.js';
import { planRunner } from './views/plans.js';

export const planActions: ActionHandlers<
  'draftPlan' | 'approvePlan' | 'discardPlan' | 'stopPlan' | 'retryPlanTask'
> = {
  draftPlan: async ({ rt }, action) => {
    const goal = action.goal.trim();
    if (goal === '') {
      return;
    }
    const runner = await planRunner(rt);
    await runner.draft(goal, action.cwd);
  },
  approvePlan: async ({ rt }, action) => {
    const runner = await planRunner(rt);
    runner.approve(action.planId);
  },
  discardPlan: async ({ rt }, action) => {
    const runner = await planRunner(rt);
    runner.discard(action.planId);
  },
  stopPlan: async ({ rt }, action) => {
    const runner = await planRunner(rt);
    runner.stop(action.planId);
  },
  retryPlanTask: async ({ rt }, action) => {
    const runner = await planRunner(rt);
    runner.retry(action.planId, action.taskId);
  },
};
