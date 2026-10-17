// Warns once when a session uses up the token budget set on it, and once when
// it runs well past what its task list looked set to need. Each warning
// offers to stop the session or set its budget.

import type { SessionSummary } from '../../shared/model.js';
import { sessionName } from '../../shared/model.js';
import type { TaskProgress } from '../../shared/progress.js';
import { SOLID_BASIS } from '../../shared/progress.js';
import type { FleetState } from '../../shared/protocol.js';
import { tokens } from '../tuning/words.js';

import { askBudget } from './actions-budget.js';
import { dispatch } from './actions.js';
import type { Runtime } from './runtime.js';
import { fleetFor } from './views/fleet.js';

/** How often the Fleet's progress is checked for warnings. */
export const PROGRESS_CHECK_MS = 30_000;
/** Spending this many times the planned tokens counts as running over. */
const OVERRUN_FACTOR = 1.5;

export const STOP = 'Stop session';
export const SET_BUDGET = 'Set budget';

export interface ProgressAlert {
  readonly sessionId: string;
  readonly kind: 'budget' | 'overrun';
  readonly message: string;
}

/** What a task list looked set to need at its first steady estimate. */
interface Plan {
  readonly listStartedAt: number;
  readonly tokens: number;
  readonly done: number;
  readonly total: number;
}

function isFinished(session: SessionSummary): boolean {
  return session.state === 'done' || session.state === 'failed';
}

/**
 * Remembers each task list's first steady estimate and the overrun warnings
 * already given. Budget warnings are remembered with the budget, so they
 * survive a reload; these do not need to.
 */
export class ProgressWatch {
  private readonly plans = new Map<string, Plan>();
  private readonly overrun = new Set<string>();

  /** Warnings due in this fleet state that have not been given yet. */
  review(
    fleet: Pick<FleetState, 'sessions' | 'progress'>,
    budgetWarned: (sessionId: string) => boolean,
  ): ProgressAlert[] {
    const alerts: ProgressAlert[] = [];
    for (const session of fleet.sessions) {
      const progress = fleet.progress[session.id];
      if (progress === undefined || isFinished(session)) {
        continue;
      }
      const name = sessionName(session);
      const { budget } = progress;
      if (budget !== null && budget.used >= budget.tokens && !budgetWarned(session.id)) {
        alerts.push({
          sessionId: session.id,
          kind: 'budget',
          message: `${name} has used its token budget: ${tokens(budget.used)} of ${tokens(budget.tokens)}.`,
        });
      }
      const overrun =
        progress.tasks === null ? null : this.overrunOf(session.id, name, progress.tasks);
      if (overrun !== null) {
        alerts.push(overrun);
      }
    }
    return alerts;
  }

  private overrunOf(sessionId: string, name: string, tasks: TaskProgress): ProgressAlert | null {
    const known = this.plans.get(sessionId);
    // A new task list gets a new plan.
    const plan = known?.listStartedAt === tasks.startedAt ? known : null;
    const { estimate } = tasks;
    if (plan === null) {
      // A short list never reaches three finished tasks before the end, so it settles sooner.
      const steady = Math.min(SOLID_BASIS, Math.ceil(tasks.total / 3));
      if (estimate !== null && estimate.basis >= steady) {
        this.plans.set(sessionId, {
          listStartedAt: tasks.startedAt,
          tokens: tasks.tokensSpent + estimate.tokensLeft,
          done: tasks.done,
          total: tasks.total,
        });
        this.overrun.delete(sessionId);
      }
      return null;
    }
    if (
      this.overrun.has(sessionId) ||
      tasks.done >= tasks.total ||
      tasks.tokensSpent <= plan.tokens * OVERRUN_FACTOR
    ) {
      return null;
    }
    this.overrun.add(sessionId);
    return {
      sessionId,
      kind: 'overrun',
      message:
        `${name} has used ${tokens(tasks.tokensSpent)} tokens on its task list, more than ` +
        `${OVERRUN_FACTOR.toString()} times the ${tokens(plan.tokens)} it looked set to need ` +
        `when ${plan.done.toString()} of ${plan.total.toString()} tasks were done. ` +
        `It has done ${tasks.done.toString()} of ${tasks.total.toString()}.`,
    };
  }
}

async function warn(rt: Runtime, alert: ProgressAlert): Promise<void> {
  if (alert.kind === 'budget') {
    await rt.budgets.markWarned(alert.sessionId);
  }
  const answer = await rt.host.ask(alert.message, [STOP, SET_BUDGET]);
  if (answer === STOP) {
    await dispatch(rt, { type: 'stop', sessionId: alert.sessionId }, {});
  } else if (answer === SET_BUDGET) {
    await askBudget(rt, alert.sessionId);
  }
}

/** Gives the warnings due now, side by side, so one left open does not hold up the rest. */
export async function checkProgress(rt: Runtime, watch: ProgressWatch): Promise<void> {
  const alerts = watch.review(fleetFor(rt), (sessionId) => rt.budgets.warned(sessionId));
  await Promise.all(alerts.map(async (alert) => warn(rt, alert)));
}
