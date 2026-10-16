// Background jobs whose state the fleet cannot read from a transcript. A job
// blocked on the user looks idle in its transcript, and a finished one looks
// the same. `claude agents --json --all` knows the difference and keeps a
// finished job until the user deletes it, so the fleet follows its list.

import type { AgentEntry } from './live.js';

export interface BackgroundJob {
  readonly sessionId: string;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly startedAt: number | null;
  readonly state: 'waiting' | 'done' | 'failed';
}

// Blocked means the job needs an answer, a login or a retry from the user. A
// job the user stopped is as finished as one that ran to the end.
const STATES = new Map<string, BackgroundJob['state']>([
  ['blocked', 'waiting'],
  ['done', 'done'],
  ['stopped', 'done'],
  ['failed', 'failed'],
]);

function startedAt(job: BackgroundJob): number {
  return job.startedAt ?? 0;
}

/** Background jobs waiting on the user or finished, oldest first. Working and interactive ones are left out. */
export function backgroundJobs(entries: readonly AgentEntry[]): BackgroundJob[] {
  const jobs: BackgroundJob[] = [];
  for (const entry of entries) {
    const state = STATES.get(entry.state ?? '');
    if (entry.kind !== 'background' || state === undefined) {
      continue;
    }
    jobs.push({
      sessionId: entry.sessionId,
      name: entry.name,
      cwd: entry.cwd,
      startedAt: entry.startedAt,
      state,
    });
  }
  return jobs.toSorted((a, b) => startedAt(a) - startedAt(b));
}
