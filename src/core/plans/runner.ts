// Runs plans. A plan starts as a draft to read and approve. Once approved,
// every task whose dependencies have landed goes to the Launcher as its own
// run in its own worktree, and the next tasks start as those land. A task
// counts as landed only when its session ends with "LANDED <sha>" and that
// commit is on the default branch. Plans are saved, so a reload keeps them,
// though a reload ends the runs, which then show as stopped.

import type { Plan, PlanTask, PlanTaskState } from '../../shared/plans.js';
import type { LaunchRun } from '../../shared/protocol.js';

import type { Draft } from './draft.js';

/** What a task's session is told after its own prompt. */
export function taskPrompt(plan: Plan, task: PlanTask): string {
  return `${task.prompt}

This is one task of a larger plan ("${plan.goal}"). Other sessions work on the other tasks at the same time in their own worktrees, so stay within this task.

When it is done and its checks pass, commit it and land it on the default branch the way this repository lands work (npm run land when it has that script). Then end your last message with a line of its own: LANDED followed by the commit hash on the default branch. If you cannot finish, end with a line FAILED followed by one sentence on why.`;
}

const LANDED = /^LANDED\s+([0-9a-f]{7,40})\b/mu;
const FAILED = /^FAILED (.+)$/mu;

/** What a finished run's last message says about its task. */
export function outcomeOf(
  result: string | null,
): { readonly sha: string } | { readonly failed: string } {
  const landed = LANDED.exec(result ?? '');
  if (landed?.[1] !== undefined) {
    return { sha: landed[1] };
  }
  const failed = FAILED.exec(result ?? '');
  return {
    failed:
      failed?.[1]?.trim() ?? 'The session ended without saying it landed. Open it to see why.',
  };
}

export interface PlanRunnerDeps {
  /** Starts a run for the task and returns its run id. */
  readonly launch: (plan: Plan, task: PlanTask) => string;
  readonly stopRun: (runId: string) => void;
  /** Runs the planner for a goal. */
  readonly draft: (goal: string, cwd: string) => Promise<Draft>;
  /** True when the commit is on the default branch of the repository at cwd. */
  readonly isLanded: (cwd: string, sha: string) => Promise<boolean>;
  readonly save: (plans: readonly Plan[]) => Promise<void>;
  readonly notify: () => void;
  readonly report: (message: string) => void;
  readonly newId: () => string;
  readonly clock: () => number;
}

const ACTIVE: ReadonlySet<PlanTaskState> = new Set(['queued', 'running']);

function fromRun(run: LaunchRun): PlanTaskState {
  return run.state === 'queued' ? 'queued' : 'running';
}

export class PlanRunner {
  private list: Plan[];
  private readonly deps: PlanRunnerDeps;
  /** The last save, so the next one waits for it and an older list never lands on top of a newer one. */
  private saving: Promise<void> = Promise.resolve();

  /** `saved` is what the last session saved. Runs from before a reload are gone, so their tasks stop. */
  constructor(deps: PlanRunnerDeps, saved: readonly Plan[]) {
    this.deps = deps;
    this.list = saved.map((plan) => ({
      ...plan,
      state: plan.state === 'drafting' ? 'failed' : plan.state,
      error:
        plan.state === 'drafting'
          ? 'Overlord restarted while drafting. Draft it again.'
          : plan.error,
      tasks: plan.tasks.map((task) =>
        ACTIVE.has(task.state)
          ? {
              ...task,
              state: 'stopped',
              note: 'Overlord restarted, which ended the run. Retry it.',
            }
          : task,
      ),
    }));
  }

  plans(): readonly Plan[] {
    return this.list;
  }

  private find(planId: string): Plan | undefined {
    return this.list.find((plan) => plan.id === planId);
  }

  private put(next: Plan): void {
    this.list = this.list.map((plan) => (plan.id === next.id ? next : plan));
    this.saving = this.saveAfter(this.saving, this.list);
    this.deps.notify();
  }

  /** Saves `list` once the save before it is done. It never rejects, since a failed save is reported. */
  private async saveAfter(previous: Promise<void>, list: readonly Plan[]): Promise<void> {
    await previous;
    try {
      await this.deps.save(list);
    } catch (error: unknown) {
      this.deps.report(
        `Could not save plans: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Drafts a plan for the goal. It shows as drafting until the planner answers. */
  async draft(goal: string, cwd: string): Promise<string> {
    const plan: Plan = {
      id: this.deps.newId(),
      goal,
      cwd,
      createdAt: this.deps.clock(),
      state: 'drafting',
      summary: '',
      tasks: [],
      error: null,
    };
    this.list = [plan, ...this.list];
    this.put(plan);
    try {
      const draft = await this.deps.draft(goal, cwd);
      this.put({
        ...plan,
        state: 'draft',
        summary: draft.summary,
        tasks: draft.tasks.map((task) => ({
          ...task,
          state: 'waiting',
          runId: null,
          sessionId: null,
          landedSha: null,
          note: null,
        })),
      });
    } catch (error) {
      this.put({
        ...plan,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return plan.id;
  }

  approve(planId: string): void {
    const plan = this.find(planId);
    if (plan?.state === 'draft') {
      this.advance({ ...plan, state: 'running' });
    }
  }

  discard(planId: string): void {
    const plan = this.find(planId);
    if (plan === undefined || plan.state === 'running' || plan.state === 'drafting') {
      return;
    }
    this.list = this.list.filter((candidate) => candidate.id !== planId);
    this.put(plan);
  }

  /** Stops the plan's runs. Tasks that landed stay landed. */
  stop(planId: string): void {
    const plan = this.find(planId);
    if (plan?.state !== 'running') {
      return;
    }
    for (const task of plan.tasks) {
      if (task.runId !== null && ACTIVE.has(task.state)) {
        this.deps.stopRun(task.runId);
      }
    }
    this.put({
      ...plan,
      state: 'stopped',
      tasks: plan.tasks.map((task) =>
        ACTIVE.has(task.state) || task.state === 'waiting'
          ? { ...task, state: 'stopped', note: 'The plan was stopped.' }
          : task,
      ),
    });
  }

  /** Runs a failed or stopped task again, and starts the plan again when it had stopped. */
  retry(planId: string, taskId: string): void {
    const plan = this.find(planId);
    if (
      plan === undefined ||
      plan.state === 'draft' ||
      plan.state === 'drafting' ||
      plan.state === 'failed'
    ) {
      return;
    }
    const tasks = plan.tasks.map((task) =>
      (task.id === taskId && (task.state === 'failed' || task.state === 'stopped')) ||
      (plan.state === 'stopped' && task.state === 'stopped')
        ? { ...task, state: 'waiting' as const, runId: null, sessionId: null, note: null }
        : task,
    );
    this.advance({ ...plan, state: 'running', tasks });
  }

  /** Starts every waiting task whose dependencies have all landed, and marks the plan done when all have. */
  private advance(plan: Plan): void {
    if (plan.state !== 'running') {
      this.put(plan);
      return;
    }
    const landed = new Set(
      plan.tasks.filter((task) => task.state === 'landed').map((task) => task.id),
    );
    let next: Plan = plan;
    for (const task of plan.tasks) {
      if (task.state === 'waiting' && task.dependsOn.every((id) => landed.has(id))) {
        const runId = this.deps.launch(next, task);
        next = {
          ...next,
          tasks: next.tasks.map((candidate) =>
            candidate.id === task.id ? { ...candidate, state: 'queued', runId } : candidate,
          ),
        };
      }
    }
    const allLanded = next.tasks.every((task) => task.state === 'landed');
    this.put(allLanded ? { ...next, state: 'done' } : next);
  }

  /** Follows a Launcher run that belongs to a task. */
  /** The plan and the active task a run works on, or null when it is not a plan's. */
  private activeTask(runId: string): { readonly plan: Plan; readonly task: PlanTask } | null {
    for (const plan of this.list) {
      const task = plan.tasks.find((candidate) => candidate.runId === runId);
      if (task !== undefined) {
        return ACTIVE.has(task.state) ? { plan, task } : null;
      }
    }
    return null;
  }

  onRun(run: LaunchRun): void {
    const found = this.activeTask(run.id);
    if (found === null) {
      return;
    }
    const { plan, task } = found;
    const patch = (fields: Partial<PlanTask>): Plan => ({
      ...plan,
      tasks: plan.tasks.map((candidate) =>
        candidate.id === task.id ? { ...candidate, ...fields } : candidate,
      ),
    });
    if (run.state === 'queued' || run.state === 'running') {
      if (fromRun(run) !== task.state || run.sessionId !== task.sessionId) {
        this.put(patch({ state: fromRun(run), sessionId: run.sessionId }));
      }
      return;
    }
    if (run.state !== 'done') {
      this.put(
        patch({
          state: run.state === 'stopped' ? 'stopped' : 'failed',
          note: run.result ?? `The run ${run.state === 'stopped' ? 'was stopped' : 'failed'}.`,
        }),
      );
      return;
    }
    void this.settle(plan.id, task.id, run);
  }

  private async settle(planId: string, taskId: string, run: LaunchRun): Promise<void> {
    const outcome = outcomeOf(run.result);
    const plan = this.find(planId);
    if (plan === undefined) {
      return;
    }
    let fields: Partial<PlanTask>;
    if ('sha' in outcome) {
      const landed = await this.deps.isLanded(plan.cwd, outcome.sha).catch(() => false);
      fields = landed
        ? { state: 'landed', landedSha: outcome.sha, note: null }
        : {
            state: 'failed',
            note: `It said it landed ${outcome.sha}, but that commit is not on the default branch.`,
          };
    } else {
      fields = { state: 'failed', note: outcome.failed };
    }
    // Read the plan again: it may have changed while git ran.
    const current = this.find(planId) ?? plan;
    this.advance({
      ...current,
      tasks: current.tasks.map((task) =>
        task.id === taskId ? { ...task, ...fields, sessionId: run.sessionId } : task,
      ),
    });
  }
}
