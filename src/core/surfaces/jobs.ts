// Background jobs Claude Code still lists after they finish. `claude agents
// --json --all` keeps a finished job until the user deletes it, so the fleet
// shows it as done for exactly as long as Claude Code's own list does.

import type { AgentEntry } from './live.js';

export interface FinishedJob {
  readonly sessionId: string;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly startedAt: number | null;
  readonly state: 'done' | 'failed';
}

// A job the user stopped is as finished as one that ran to the end.
const FINISHED = new Map<string, FinishedJob['state']>([
  ['done', 'done'],
  ['stopped', 'done'],
  ['failed', 'failed'],
]);

function startedAt(job: FinishedJob): number {
  return job.startedAt ?? 0;
}

/** The background jobs that have finished, oldest first. Running and interactive ones are left out. */
export function finishedJobs(entries: readonly AgentEntry[]): FinishedJob[] {
  const jobs: FinishedJob[] = [];
  for (const entry of entries) {
    const state = FINISHED.get(entry.state ?? '');
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
