import { describe, expect, it } from 'vitest';

import { finishedJobs } from './jobs.js';
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

describe('finishedJobs', () => {
  it('keeps finished background jobs, oldest first, with stopped counted as done', () => {
    expect(
      finishedJobs([
        entry('late', { startedAt: 30 }),
        entry('stopped', { state: 'stopped', startedAt: 20 }),
        entry('broke', { state: 'failed', startedAt: null, cwd: null, name: null }),
      ]),
    ).toStrictEqual([
      { sessionId: 'broke', name: null, cwd: null, startedAt: null, state: 'failed' },
      { sessionId: 'stopped', name: 'job stopped', cwd: '/work', startedAt: 20, state: 'done' },
      { sessionId: 'late', name: 'job late', cwd: '/work', startedAt: 30, state: 'done' },
    ]);
  });

  it('leaves out running jobs, jobs with no state and interactive sessions', () => {
    expect(
      finishedJobs([
        entry('working', { state: 'working' }),
        entry('unknown', { state: null }),
        entry('terminal', { kind: 'interactive' }),
        entry('no-kind', { kind: null }),
      ]),
    ).toStrictEqual([]);
  });
});
