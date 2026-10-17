import { describe, expect, it } from 'vitest';

import type { Plan, PlanTask } from '../../shared/plans.js';
import type { LaunchRun } from '../../shared/protocol.js';

import type { Draft } from './draft.js';
import type { PlanRunnerDeps } from './runner.js';
import { outcomeOf, PlanRunner, taskPrompt } from './runner.js';

const STORE = {
  id: 'store',
  title: 'Store',
  prompt: 'Add the store.',
  dependsOn: [],
  files: ['src/store.ts'],
};

const DRAFT: Draft = {
  summary: 'Store first, then the two views.',
  tasks: [
    STORE,
    { id: 'view', title: 'View', prompt: 'Show it.', dependsOn: ['store'], files: [] },
    { id: 'docs', title: 'Docs', prompt: 'Write it up.', dependsOn: [], files: [] },
  ],
};

interface Harness {
  readonly runner: PlanRunner;
  readonly launched: { readonly task: string; readonly prompt: string }[];
  readonly stopped: string[];
  readonly saved: (readonly Plan[])[];
  landed: boolean;
}

async function drafted(): Promise<Draft> {
  await Promise.resolve();
  return DRAFT;
}

function harness(saved: readonly Plan[] = [], draft: () => Promise<Draft> = drafted): Harness {
  const state = {
    launched: [] as { task: string; prompt: string }[],
    stopped: [] as string[],
    saved: [] as (readonly Plan[])[],
    landed: true,
  };
  let id = 0;
  const deps: PlanRunnerDeps = {
    launch: (plan, task) => {
      state.launched.push({ task: task.id, prompt: taskPrompt(plan, task) });
      return `run-${task.id}`;
    },
    stopRun: (runId) => {
      state.stopped.push(runId);
    },
    draft,
    isLanded: async () => {
      await Promise.resolve();
      return state.landed;
    },
    save: async (plans) => {
      await Promise.resolve();
      state.saved.push(plans);
    },
    notify: (): void => {
      // Nothing renders in these tests.
    },
    report: (): void => {
      // Errors show up in the plan state instead.
    },
    newId: () => {
      id += 1;
      return `plan-${String(id)}`;
    },
    clock: () => 42,
  };
  const runner = new PlanRunner(deps, saved);
  return Object.assign(state, { runner });
}

function run(id: string, state: LaunchRun['state'], result: string | null = null): LaunchRun {
  return {
    id,
    batchId: 'b',
    spec: { prompt: '', cwd: '/r', profileId: null, worktree: true, maxBudgetUsd: null, label: '' },
    sessionId: `session-${id}`,
    state,
    costUsd: 0,
    turns: 0,
    durationMs: 0,
    result,
    worktreePath: null,
  };
}

function tasks(runner: PlanRunner): Record<string, PlanTask['state']> {
  return Object.fromEntries((runner.plans()[0]?.tasks ?? []).map((task) => [task.id, task.state]));
}

async function settled(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe('outcomeOf', () => {
  it('reads LANDED and FAILED lines, and treats anything else as a failure', () => {
    expect(outcomeOf('All done.\nLANDED 1a2b3c4d')).toStrictEqual({ sha: '1a2b3c4d' });
    expect(outcomeOf('FAILED the tests need a database')).toStrictEqual({
      failed: 'the tests need a database',
    });
    expect(outcomeOf(null)).toStrictEqual({
      failed: 'The session ended without saying it landed. Open it to see why.',
    });
  });
});

describe('PlanRunner', () => {
  it('drafts a plan, waits for approval, then runs tasks as their dependencies land', async () => {
    const h = harness();
    const planId = await h.runner.draft('Add a store and a view', '/r');
    expect(h.runner.plans()[0]).toMatchObject({
      id: planId,
      state: 'draft',
      summary: DRAFT.summary,
    });
    expect(h.launched).toStrictEqual([]);

    h.runner.approve(planId);
    expect(h.launched.map((item) => item.task)).toStrictEqual(['store', 'docs']);
    expect(h.launched[0]?.prompt).toContain('Add the store.');
    expect(h.launched[0]?.prompt).toContain('LANDED');
    expect(tasks(h.runner)).toStrictEqual({ store: 'queued', view: 'waiting', docs: 'queued' });

    h.runner.onRun(run('run-store', 'running'));
    expect(tasks(h.runner)['store']).toBe('running');
    expect(h.runner.plans()[0]?.tasks[0]?.sessionId).toBe('session-run-store');

    h.runner.onRun(run('run-store', 'done', 'Done.\nLANDED abc1234'));
    await settled();
    expect(tasks(h.runner)).toStrictEqual({ store: 'landed', view: 'queued', docs: 'queued' });
    expect(h.launched.map((item) => item.task)).toStrictEqual(['store', 'docs', 'view']);

    h.runner.onRun(run('run-docs', 'done', 'LANDED def5678'));
    h.runner.onRun(run('run-view', 'done', 'LANDED 0123abc'));
    await settled();
    expect(h.runner.plans()[0]?.state).toBe('done');
    expect(h.saved.length).toBeGreaterThan(0);
  });

  it('fails a task whose commit is not on the default branch, and retries it', async () => {
    const h = harness();
    const planId = await h.runner.draft('g', '/r');
    h.runner.approve(planId);
    h.landed = false;
    h.runner.onRun(run('run-store', 'done', 'LANDED abc1234'));
    await settled();
    expect(h.runner.plans()[0]?.tasks[0]).toMatchObject({
      state: 'failed',
      note: 'It said it landed abc1234, but that commit is not on the default branch.',
    });
    expect(tasks(h.runner)['view']).toBe('waiting');
    h.runner.retry(planId, 'store');
    expect(tasks(h.runner)['store']).toBe('queued');
    expect(h.launched.filter((item) => item.task === 'store')).toHaveLength(2);
  });

  it('marks failed and stopped runs, stops a plan and starts it again', async () => {
    const h = harness();
    const planId = await h.runner.draft('g', '/r');
    h.runner.approve(planId);
    h.runner.onRun(run('run-docs', 'failed', 'Out of budget'));
    expect(h.runner.plans()[0]?.tasks[2]).toMatchObject({ state: 'failed', note: 'Out of budget' });
    h.runner.stop(planId);
    expect(h.stopped).toStrictEqual(['run-store']);
    expect(h.runner.plans()[0]?.state).toBe('stopped');
    expect(tasks(h.runner)).toStrictEqual({ store: 'stopped', view: 'stopped', docs: 'failed' });
    h.runner.retry(planId, 'docs');
    expect(h.runner.plans()[0]?.state).toBe('running');
    expect(tasks(h.runner)).toStrictEqual({ store: 'queued', view: 'waiting', docs: 'queued' });
  });

  it('records a planner failure, discards plans that are not running, and ignores other runs', async () => {
    const h = harness([], async () => {
      await Promise.resolve();
      throw new Error('not logged in');
    });
    const planId = await h.runner.draft('g', '/r');
    expect(h.runner.plans()[0]).toMatchObject({ state: 'failed', error: 'not logged in' });
    h.runner.onRun(run('someone-else', 'done'));
    h.runner.discard(planId);
    expect(h.runner.plans()).toStrictEqual([]);
  });

  it('stops tasks whose runs a reload ended', () => {
    const saved: Plan = {
      id: 'p',
      goal: 'g',
      cwd: '/r',
      createdAt: 1,
      state: 'running',
      summary: '',
      error: null,
      tasks: [
        {
          ...STORE,
          state: 'running',
          runId: 'old',
          sessionId: null,
          landedSha: null,
          note: null,
        },
      ],
    };
    const drafting: Plan = { ...saved, id: 'q', state: 'drafting', tasks: [] };
    const h = harness([saved, drafting]);
    expect(h.runner.plans()[0]?.tasks[0]).toMatchObject({ state: 'stopped' });
    expect(h.runner.plans()[1]).toMatchObject({ state: 'failed' });
  });
});
