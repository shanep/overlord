import { describe, expect, it } from 'vitest';

import type { ToolCall } from '../../shared/model.js';

import { readTaskList } from './tasks.js';

const T0 = 1_800_000_000_000;

let next = 0;

function call(
  name: string,
  input: unknown,
  result: string | null = null,
  ok: boolean | null = true,
): ToolCall {
  next += 1;
  return {
    id: `t${next.toString()}`,
    sessionId: 's1',
    agentId: 's1',
    name,
    input,
    startedAt: T0 + next * 1000,
    endedAt: ok === null ? null : T0 + next * 1000 + 10,
    ok,
    resultPreview: result,
  };
}

function created(id: string, subject: string): ToolCall {
  return call(
    'TaskCreate',
    { subject, description: '' },
    `Task #${id} created successfully: ${subject}`,
  );
}

describe('readTaskList', () => {
  it('is null with no task calls', () => {
    expect(readTaskList([call('Bash', { command: 'ls' })])).toBeNull();
  });

  it('builds the list from TaskCreate and TaskUpdate, using the ids TaskCreate answered with', () => {
    const first = created('1', 'Parse the input');
    const list = readTaskList([
      first,
      created('2', 'Write the output'),
      created('3', 'Drop me'),
      call('TaskUpdate', { taskId: '1', status: 'completed' }),
      call('TaskUpdate', { taskId: '2', status: 'in_progress', subject: 'Write the output file' }),
      call('TaskUpdate', { taskId: '3', status: 'deleted' }),
      call('TaskUpdate', { taskId: '9', status: 'completed' }),
    ]);
    expect(list).toStrictEqual({
      startedAt: first.startedAt,
      items: [
        { id: '1', subject: 'Parse the input', status: 'completed' },
        { id: '2', subject: 'Write the output file', status: 'in_progress' },
      ],
    });
  });

  it('applies a repeated call once and in start order, and skips failed calls', () => {
    const create = created('1', 'Only task');
    const done = call('TaskUpdate', { taskId: '1', status: 'completed' });
    const failed = call('TaskUpdate', { taskId: '1', status: 'pending' }, 'error', false);
    const list = readTaskList([done, create, done, failed]);
    expect(list?.items).toStrictEqual([{ id: '1', subject: 'Only task', status: 'completed' }]);
  });

  it('numbers a pending TaskCreate past every task made, deleted ones too', () => {
    const list = readTaskList([
      created('1', 'First'),
      created('2', 'Second'),
      call('TaskUpdate', { taskId: '1', status: 'deleted' }),
      call('TaskCreate', { subject: 'Third' }, null, null),
    ]);
    expect(list?.items.map((item) => [item.id, item.subject])).toStrictEqual([
      ['2', 'Second'],
      ['3', 'Third'],
    ]);
  });

  it('numbers a TaskCreate whose result has not come back yet', () => {
    const list = readTaskList([
      created('1', 'First'),
      call('TaskCreate', { subject: 'Second' }, null, null),
      call('TaskUpdate', { taskId: '2', status: 'in_progress' }),
    ]);
    expect(list?.items.map((item) => [item.id, item.status])).toStrictEqual([
      ['1', 'pending'],
      ['2', 'in_progress'],
    ]);
  });

  it('takes the latest whole list from TodoWrite', () => {
    const list = readTaskList([
      call('TodoWrite', { todos: [{ content: 'A', status: 'pending', activeForm: 'Doing A' }] }),
      call('TodoWrite', {
        todos: [
          { content: 'A', status: 'completed', activeForm: 'Doing A' },
          { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
        ],
      }),
      call('TodoWrite', { todos: 'not a list' }),
    ]);
    expect(list?.items).toStrictEqual([
      { id: '1', subject: 'A', status: 'completed' },
      { id: '2', subject: 'B', status: 'in_progress' },
    ]);
  });

  it("reads Codex's update_plan", () => {
    const list = readTaskList([
      call('update_plan', {
        explanation: 'Start',
        plan: [
          { step: 'Read the code', status: 'completed' },
          { step: 'Fix the bug', status: 'pending' },
        ],
      }),
    ]);
    expect(list?.items.map((item) => item.status)).toStrictEqual(['completed', 'pending']);
  });

  it('is null when every task was deleted', () => {
    expect(
      readTaskList([created('1', 'Gone'), call('TaskUpdate', { taskId: '1', status: 'deleted' })]),
    ).toBeNull();
  });
});
