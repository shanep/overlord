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
        entry('asking', { state: 'blocked', startedAt: 25, cwd: '/asking' }),
        entry('stopped', { state: 'stopped', startedAt: 20 }),
        entry('broke', { state: 'failed', startedAt: null, cwd: null, name: null }),
      ]),
    ).toStrictEqual([
      { sessionId: 'broke', name: null, cwd: null, startedAt: null, state: 'failed' },
      { sessionId: 'stopped', name: 'job stopped', cwd: '/work', startedAt: 20, state: 'done' },
      { sessionId: 'asking', name: 'job asking', cwd: '/asking', startedAt: 25, state: 'waiting' },
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

  it('calls a blocked job done once a newer job picks it up in its folder', () => {
    expect(
      backgroundJobs([
        entry('old', { state: 'blocked', startedAt: 10, cwd: '/wt/a' }),
        entry('new', { pid: 50, state: 'working', startedAt: 20, cwd: '/wt/a' }),
        entry('alive', { pid: 51, state: 'blocked', startedAt: 10, cwd: '/wt/b' }),
        entry('later', { pid: 52, state: 'working', startedAt: 20, cwd: '/wt/b' }),
        entry('alone', { state: 'blocked', startedAt: 10, cwd: '/wt/c' }),
        entry('older', { state: 'done', startedAt: 5, cwd: '/wt/c' }),
        entry('no-folder', { state: 'blocked', startedAt: 10, cwd: null }),
        entry('other-kind', { kind: 'interactive', state: 'working', startedAt: 20, cwd: null }),
      ]).map((job) => [job.sessionId, job.state]),
    ).toStrictEqual([
      ['older', 'done'],
      ['old', 'done'],
      ['alive', 'waiting'],
      ['alone', 'waiting'],
      ['no-folder', 'waiting'],
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
