import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { fakeQueries, flush, resultMessage } from '../../../test/fake-claude/fake-query.js';
import type { Plan } from '../../shared/plans.js';

import type { ExecCall } from './test-helpers/fixtures.js';
import { makeApp, makeEnv, ok, waitFor } from './test-helpers/fixtures.js';
import { planList, PLANS_FILE } from './views/plans.js';

const DRAFT = {
  summary: 'One task is enough.',
  tasks: [
    { id: 'docs', title: 'Docs', prompt: 'Write the README.', dependsOn: [], files: ['README.md'] },
  ],
};

function planner(call: ExecCall): ReturnType<typeof ok> | undefined {
  return call.args[0] === '-p' ? ok(JSON.stringify({ structured_output: DRAFT })) : undefined;
}

function only(plans: readonly Plan[]): Plan {
  const [plan] = plans;
  if (plan === undefined) {
    throw new Error('no plan');
  }
  return plan;
}

describe('plans in the app', () => {
  it('drafts a plan, runs its task on approval and saves how it went', async () => {
    const env = await makeEnv();
    // Each session answers once, without a LANDED line.
    const queries = fakeQueries((query) => {
      void (async (): Promise<void> => {
        await flush();
        query.emit(resultMessage({ result: 'I wrote it but could not land it.' }));
      })();
    });
    const { app, calls } = makeApp(env, { responders: [planner], queries });
    expect(planList(app.runtime)).toStrictEqual([]);
    await app.dispatch({ type: 'draftPlan', goal: '  Document it  ', cwd: '/repo' }, {});
    const draft = only(planList(app.runtime));
    expect(draft).toMatchObject({
      goal: 'Document it',
      cwd: '/repo',
      state: 'draft',
      summary: DRAFT.summary,
    });
    const plannerCall = calls.find((call) => call.args[0] === '-p');
    expect(plannerCall?.options.cwd).toBe('/repo');

    await app.dispatch({ type: 'approvePlan', planId: draft.id }, {});
    expect(app.runtime.launcher.runs().map((run) => run.spec)).toMatchObject([
      { cwd: '/repo', worktree: true, label: 'Document it: Docs' },
    ]);
    expect(app.runtime.launcher.runs()[0]?.spec.prompt).toContain('Write the README.');

    // The fake session ends without a LANDED line, so the task fails and says why.
    await waitFor(() => only(planList(app.runtime)).tasks[0]?.state === 'failed');
    expect(only(planList(app.runtime)).tasks[0]?.note).toContain('without saying it landed');

    const saved = (): string => {
      try {
        return readFileSync(path.join(env.storageDir, PLANS_FILE), 'utf8');
      } catch {
        return '';
      }
    };
    await waitFor(() => saved().includes('"failed"'));
    await app.dispatch({ type: 'stopPlan', planId: draft.id }, {});
    expect(only(planList(app.runtime)).state).toBe('stopped');
    await app.dispatch({ type: 'discardPlan', planId: draft.id }, {});
    expect(planList(app.runtime)).toStrictEqual([]);
  });

  it('reports a plans file it cannot read once, not on every render', async () => {
    const env = await makeEnv();
    // A folder where the file should be cannot be read as one.
    mkdirSync(path.join(env.storageDir, PLANS_FILE), { recursive: true });
    const { app } = makeApp(env);
    expect(planList(app.runtime)).toStrictEqual([]);
    await waitFor(() => app.errorList().some((error) => error.source === 'plans'));
    expect(planList(app.runtime)).toStrictEqual([]);
    expect(planList(app.runtime)).toStrictEqual([]);
    expect(app.errorList().filter((error) => error.source === 'plans')).toHaveLength(1);
  });

  it('ignores an empty goal and records a planner that fails', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'draftPlan', goal: ' '.repeat(3), cwd: '/repo' }, {});
    expect(planList(app.runtime)).toStrictEqual([]);
    await app.dispatch({ type: 'draftPlan', goal: 'Go', cwd: '/repo' }, {});
    expect(only(planList(app.runtime))).toMatchObject({ state: 'failed' });
    expect(only(planList(app.runtime)).error).toContain('exit code 1');
    await app.dispatch({ type: 'retryPlanTask', planId: 'nope', taskId: 'x' }, {});
  });
});
