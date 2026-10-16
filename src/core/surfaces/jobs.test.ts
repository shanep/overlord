import { describe, expect, it } from 'vitest';

import { backgroundJobs } from './jobs.js';
import type { AgentEntry } from './live.js';

function entry(sessionId: string, overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: null,
    pid: null,
    sessionId,
    cwd: '/work',
    kind: 'background',
    name: `job ${sessionId}`,
    state: 'done',
    status: null,
    startedAt: 10,
    ...overrides,
  };
}

describe('backgroundJobs', () => {
  it('keeps blocked and finished background jobs, oldest first, with stopped counted as done', () => {
    expect(
      backgroundJobs([
        entry('late', { startedAt: 30 }),
        entry('asking', { state: 'blocked', startedAt: 25 }),
        entry('stopped', { state: 'stopped', startedAt: 20 }),
        entry('broke', { state: 'failed', startedAt: null, cwd: null, name: null }),
      ]),
    ).toStrictEqual([
      { sessionId: 'broke', name: null, cwd: null, startedAt: null, state: 'failed' },
      { sessionId: 'stopped', name: 'job stopped', cwd: '/work', startedAt: 20, state: 'done' },
      { sessionId: 'asking', name: 'job asking', cwd: '/work', startedAt: 25, state: 'waiting' },
      { sessionId: 'late', name: 'job late', cwd: '/work', startedAt: 30, state: 'done' },
    ]);
  });

  it('calls a done job idle while its process still runs, so an open tab is not done', () => {
    expect(
      backgroundJobs([
        entry('between-turns', { pid: 42, status: 'idle' }),
        entry('asking', { pid: 43, state: 'blocked', startedAt: 20 }),
        entry('broke', { pid: 44, state: 'failed', startedAt: 30 }),
      ]).map((job) => [job.sessionId, job.state]),
    ).toStrictEqual([
      ['between-turns', 'idle'],
      ['asking', 'waiting'],
      ['broke', 'failed'],
    ]);
  });

  it('leaves out running jobs, jobs with no state and interactive sessions', () => {
    expect(
      backgroundJobs([
        entry('working', { state: 'working' }),
        entry('unknown', { state: null }),
        entry('terminal', { kind: 'interactive' }),
        entry('no-kind', { kind: null }),
      ]),
    ).toStrictEqual([]);
  });
});
