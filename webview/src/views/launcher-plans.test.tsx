import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Plan, PlanTask } from '../../../src/shared/plans.js';
import type { LaunchFolder } from '../../../src/shared/protocol.js';
import { expectAccessible, renderView } from '../../test/render.js';

import { PlansSection } from './launcher-plans.js';

const FOLDERS: readonly LaunchFolder[] = [
  { name: 'overlord', folder: '/w/overlord', source: 'window' },
  { name: 'site', folder: '/w/site', source: 'project' },
];

function task(fields: Partial<PlanTask> & Pick<PlanTask, 'id' | 'title' | 'state'>): PlanTask {
  return {
    prompt: `Do ${fields.title}.`,
    dependsOn: [],
    files: [],
    runId: null,
    sessionId: null,
    landedSha: null,
    note: null,
    ...fields,
  };
}

const RUNNING: Plan = {
  id: 'p1',
  goal: 'Add dark mode',
  cwd: '/w/overlord',
  createdAt: 1,
  state: 'running',
  summary: 'Tokens first, then the views.',
  error: null,
  tasks: [
    task({
      id: 'tokens',
      title: 'Tokens',
      state: 'landed',
      landedSha: 'abc1234',
      files: ['webview/src/theme.css'],
    }),
    task({ id: 'views', title: 'Views', state: 'running', dependsOn: ['tokens'], sessionId: 's1' }),
    task({ id: 'docs', title: 'Docs', state: 'failed', note: 'The tests need a database.' }),
  ],
};

const DRAFT: Plan = {
  ...RUNNING,
  id: 'p2',
  goal: 'Speed up scans',
  state: 'draft',
  tasks: [task({ id: 'a', title: 'Cache', state: 'waiting' })],
};

describe('PlansSection', () => {
  it('drafts a plan for a goal in the picked repository', async () => {
    const { api, container } = renderView(
      <PlansSection plans={[]} folders={FOLDERS} defaultFolder="/w/overlord" />,
    );
    const button = screen.getByRole('button', { name: 'Draft plan' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal' }), {
      target: { value: '  Add dark mode ' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), {
      target: { value: '/w/site' },
    });
    fireEvent.click(button);
    expect(api.actions()).toStrictEqual([
      { type: 'draftPlan', goal: 'Add dark mode', cwd: '/w/site' },
    ]);
    expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveProperty('value', '');
    await expectAccessible(container);
  });

  it('shows each task with its state, order and note, and offers open, retry and stop', async () => {
    const { api, container } = renderView(
      <PlansSection plans={[RUNNING, DRAFT]} folders={FOLDERS} defaultFolder="/w/overlord" />,
    );
    const plan = screen.getByRole('article', { name: 'Add dark mode' });
    expect(plan.textContent).toContain('1 of 3 tasks landed');
    const rows = within(within(plan).getByRole('list', { name: 'Tasks for Add dark mode' }))
      .getAllByRole('listitem')
      .filter((item) => item.classList.contains('plan-task'));
    expect(rows.map((row) => row.querySelector('.card-title')?.textContent)).toStrictEqual([
      'Tokens',
      'Views',
      'Docs',
    ]);
    expect(rows[0]?.textContent).toContain('Landed abc1234');
    expect(rows[1]?.textContent).toContain('After Tokens.');
    expect(rows[2]?.textContent).toContain('The tests need a database.');
    fireEvent.click(within(rows[1] ?? plan).getByRole('button', { name: 'Open' }));
    fireEvent.click(within(plan).getByRole('button', { name: 'Retry Docs' }));
    fireEvent.click(within(plan).getByRole('button', { name: 'Stop' }));
    const draft = screen.getByRole('article', { name: 'Speed up scans' });
    expect(within(draft).getByText('Waiting for approval')).toBeDefined();
    fireEvent.click(within(draft).getByRole('button', { name: 'Approve and run' }));
    fireEvent.click(within(draft).getByRole('button', { name: 'Discard' }));
    expect(api.actions()).toStrictEqual([
      { type: 'openAgent', sessionId: 's1', agentId: 's1' },
      { type: 'retryPlanTask', planId: 'p1', taskId: 'docs' },
      { type: 'stopPlan', planId: 'p1' },
      { type: 'approvePlan', planId: 'p2' },
      { type: 'discardPlan', planId: 'p2' },
    ]);
    await expectAccessible(container);
  });

  it('starts on the first repository when the default folder is not in the list', () => {
    const { api } = renderView(
      <PlansSection plans={[]} folders={FOLDERS} defaultFolder="/elsewhere" />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal' }), { target: { value: 'Go' } });
    fireEvent.click(screen.getByRole('button', { name: 'Draft plan' }));
    expect(api.actions()).toStrictEqual([{ type: 'draftPlan', goal: 'Go', cwd: '/w/overlord' }]);
  });

  it('says when it is drafting or why drafting failed', () => {
    renderView(
      <PlansSection
        plans={[
          { ...DRAFT, id: 'd', goal: 'Drafting one', state: 'drafting', tasks: [], summary: '' },
          {
            ...DRAFT,
            id: 'f',
            goal: 'Failed one',
            state: 'failed',
            tasks: [],
            summary: '',
            error: 'not logged in',
          },
        ]}
        folders={FOLDERS}
        defaultFolder="/w/overlord"
      />,
    );
    expect(screen.getByRole('article', { name: 'Drafting one' }).textContent).toContain(
      'Claude is reading the repository',
    );
    expect(
      within(screen.getByRole('article', { name: 'Drafting one' })).queryByRole('button'),
    ).toBeNull();
    expect(screen.getByRole('article', { name: 'Failed one' }).textContent).toContain(
      'not logged in',
    );
  });
});
