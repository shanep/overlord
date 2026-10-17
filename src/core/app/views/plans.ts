// The plans the Launcher shows, and the runner behind them. The runner is
// made the first time something asks for it, once the saved plans have
// loaded, and follows every Launcher run from then on.

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { LaunchSpec } from '../../../shared/model.js';
import type { Plan } from '../../../shared/plans.js';
import type { Draft } from '../../plans/draft.js';
import { draftPlan } from '../../plans/draft.js';
import { PlanRunner, taskPrompt } from '../../plans/runner.js';
import { loadPlans, savePlans } from '../../plans/store.js';
import { messageOf } from '../errors.js';
import type { Runtime } from '../runtime.js';

export const PLANS_FILE = 'plans.json';
const LABEL_CHARS = 40;

interface Entry {
  runner: PlanRunner | null;
  loading: Promise<PlanRunner> | null;
}

const entries = new WeakMap<Runtime, Entry>();

function entryFor(rt: Runtime): Entry {
  let entry = entries.get(rt);
  if (entry === undefined) {
    entry = { runner: null, loading: null };
    entries.set(rt, entry);
  }
  return entry;
}

function shortGoal(goal: string): string {
  return goal.length > LABEL_CHARS ? `${goal.slice(0, LABEL_CHARS - 1)}…` : goal;
}

/** True when the commit is on the default branch of the repository at cwd, after a fetch. */
async function isLanded(rt: Runtime, cwd: string, sha: string): Promise<boolean> {
  await rt.exec('git', ['fetch', '--quiet', 'origin'], { cwd });
  const head = await rt.exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd,
  });
  const branch = head.code === 0 ? head.stdout.trim() : 'origin/master';
  const result = await rt.exec('git', ['merge-base', '--is-ancestor', sha, branch], { cwd });
  return result.code === 0;
}

function makeRunner(rt: Runtime, saved: readonly Plan[]): PlanRunner {
  const file = path.join(rt.host.storageDir, PLANS_FILE);
  const runner = new PlanRunner(
    {
      launch: (plan, task): string => {
        const spec: LaunchSpec = {
          prompt: taskPrompt(plan, task),
          cwd: plan.cwd,
          profileId: null,
          worktree: true,
          maxBudgetUsd: null,
          label: `${shortGoal(plan.goal)}: ${task.title}`,
        };
        const batchId = rt.launcher.launch([spec], rt.caches.profiles.value);
        return rt.launcher.runs().find((run) => run.batchId === batchId)?.id ?? batchId;
      },
      stopRun: (runId): void => {
        rt.launcher.stopRun(runId);
      },
      draft: async (goal, cwd): Promise<Draft> =>
        draftPlan({ exec: rt.exec, claude: rt.host.settings.claudePath, cwd, goal }),
      isLanded: async (cwd, sha): Promise<boolean> => isLanded(rt, cwd, sha),
      save: async (plans): Promise<void> => savePlans(file, plans),
      notify: rt.notify,
      report: (message): void => {
        rt.report('plans', message);
      },
      newId: randomUUID,
      clock: rt.clock,
    },
    saved,
  );
  rt.launcher.onChange((run) => {
    runner.onRun(run);
  });
  return runner;
}

/** The runner, loading the saved plans the first time. */
export async function planRunner(rt: Runtime): Promise<PlanRunner> {
  const entry = entryFor(rt);
  entry.loading ??= loadPlans(path.join(rt.host.storageDir, PLANS_FILE)).then(
    (saved) => {
      entry.runner = makeRunner(rt, saved);
      rt.notify();
      return entry.runner;
    },
    (error: unknown) => {
      entry.loading = null;
      throw error;
    },
  );
  return entry.loading;
}

/** The plans to show. Empty until the saved ones have loaded. */
export function planList(rt: Runtime): readonly Plan[] {
  const entry = entryFor(rt);
  if (entry.runner === null) {
    planRunner(rt).catch((error: unknown) => {
      rt.report('plans', messageOf(error));
    });
    return [];
  }
  return entry.runner.plans();
}
