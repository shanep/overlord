import { describe, expect, it } from 'vitest';

import type { ApiRequest, ToolCall, TokenUsage } from '../../shared/model.js';
import { ZERO_USAGE } from '../../shared/model.js';
import { agent, NOW, session } from '../app/test-helpers/fixtures.js';

import type { ProgressActivity, ProgressInputs } from './fleet-progress.js';
import { fleetProgress } from './fleet-progress.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function tokens(input: number, output = 0): TokenUsage {
  return { ...ZERO_USAGE, input, output };
}

function request(
  agentId: string,
  at: number,
  usage: TokenUsage,
  costUsd: number | null,
): ApiRequest {
  return {
    messageId: `${agentId}-${at.toString()}`,
    requestId: null,
    sessionId: 's1',
    agentId,
    model: 'claude-opus-5-5',
    timestamp: at,
    usage,
    ttftMs: null,
    durationMs: null,
    costUsd,
  };
}

/** A main thread call to a task tool at `at`, answered with `result`. */
function task(name: string, input: unknown, at: number, result: string | null = null): ToolCall {
  return {
    id: `${name}-${at.toString()}`,
    sessionId: 's1',
    agentId: 's1',
    name,
    input,
    startedAt: at,
    endedAt: at + 10,
    ok: true,
    resultPreview: result,
  };
}

const START = NOW - HOUR;

const TASK_CALLS: readonly ToolCall[] = [
  task('TaskCreate', { subject: 'One' }, START, 'Task #1 created successfully: One'),
  task('TaskCreate', { subject: 'Two' }, START + 1, 'Task #2 created successfully: Two'),
  task('TaskUpdate', { taskId: '1', status: 'completed' }, START + MINUTE),
];

function inputs(overrides: Partial<ProgressInputs> = {}): ProgressInputs {
  const activity: ProgressActivity = {
    taskCalls: TASK_CALLS,
    // 100 tokens and $1 before the task list started, then the rest.
    requests: [
      request('s1', START - MINUTE, tokens(100), 1),
      request('s1', START + MINUTE, tokens(400, 100), 2),
      request('a1', START + 2 * MINUTE, tokens(300), 3),
      request('a2', START + 3 * MINUTE, tokens(100), null),
    ],
  };
  return {
    sessions: [session('s1', { usage: tokens(900, 100), costUsd: 6, startedAt: START - HOUR })],
    agents: [
      agent('s1', 's1'),
      agent('s1', 'a1', { description: 'Big job', usage: tokens(300) }),
      agent('s1', 'a2', {
        description: '',
        agentType: 'Explore',
        usage: tokens(100),
        state: 'done',
      }),
    ],
    activity: new Map([['s1', activity]]),
    budgets: {},
    window: null,
    now: NOW,
    ...overrides,
  };
}

describe('fleetProgress', () => {
  it('counts tokens and cost from when the task list started', () => {
    const progress = fleetProgress(inputs())['s1'];
    expect(progress?.tasks).toMatchObject({ done: 1, total: 2, tokensSpent: 900 });
    // Half done, so as much again is left.
    expect(progress?.tasks?.estimate).toMatchObject({ tokensLeft: 900, costLeftUsd: 5 });
  });

  it('lists the subagents that spent the most, with each one priced', () => {
    expect(fleetProgress(inputs())['s1']?.subagents).toStrictEqual({
      running: 1,
      finished: 1,
      tokens: 400,
      top: [
        { agentId: 'a1', description: 'Big job', tokens: 300, running: true },
        { agentId: 'a2', description: 'Explore', tokens: 100, running: false },
      ],
      costs: { a1: 3 },
    });
  });

  it('shows how much of a budget the session has used', () => {
    expect(fleetProgress(inputs({ budgets: { s1: 5000 } }))['s1']?.budget).toStrictEqual({
      tokens: 5000,
      used: 1000,
    });
  });

  it('drops the estimate once the session is finished', () => {
    const done = session('s1', { state: 'done', usage: tokens(900, 100) });
    expect(fleetProgress(inputs({ sessions: [done] }))['s1']?.tasks?.estimate).toBeNull();
  });

  it('leaves out a session with no task list, subagents or budget', () => {
    expect(fleetProgress(inputs({ agents: [], activity: new Map() }))).toStrictEqual({});
  });
});
