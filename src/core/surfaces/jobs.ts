// Background jobs whose state the fleet cannot read from a transcript. A job
// blocked on the user looks idle in its transcript, and a finished one looks
// the same. `claude agents --json --all` knows the difference and keeps a
// finished job until the user deletes it. The fleet takes each job's state
// from that list but lets a finished one age out with the active window.
// It also calls a job done after each turn while its process still runs
// and a tab may be attached, so a done job with a pid is only idle. And it
// keeps a job blocked after it exits, even once Continue has picked the
// conversation up in a new job, so that one is done.

import type { AgentEntry } from './live.js';

export interface BackgroundJob {
  readonly sessionId: string;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly startedAt: number | null;
  readonly state: 'waiting' | 'idle' | 'done' | 'failed';
}

// Blocked means the job needs an answer, a login or a retry from the user. A
// job the user stopped is as finished as one that ran to the end.
const STATES = new Map<string, BackgroundJob['state']>([
  ['blocked', 'waiting'],
  ['done', 'done'],
  ['stopped', 'done'],
  ['failed', 'failed'],
]);

function startedAt(job: Pick<BackgroundJob, 'startedAt'>): number {
  return job.startedAt ?? 0;
}

/**
 * True when a job with no process has a newer job in its folder. Each
 * session gets its own worktree, so that is the same conversation continued.
 */
function continued(entry: AgentEntry, entries: readonly AgentEntry[]): boolean {
  return (
    entry.pid === null &&
    entry.cwd !== null &&
    entries.some(
      (other) =>
        other.kind === 'background' &&
        other.sessionId !== entry.sessionId &&
        other.cwd === entry.cwd &&
        startedAt(other) > startedAt(entry),
    )
  );
}

function stateOf(entry: AgentEntry, entries: readonly AgentEntry[]): BackgroundJob['state'] | null {
  const mapped = STATES.get(entry.state ?? '');
  if (mapped === 'waiting' && continued(entry, entries)) {
    return 'done';
  }
  return mapped === 'done' && entry.pid !== null ? 'idle' : (mapped ?? null);
}

/** Background jobs waiting on the user, idle or finished, oldest first. Working and interactive ones are left out. */
export function backgroundJobs(entries: readonly AgentEntry[]): BackgroundJob[] {
  const jobs: BackgroundJob[] = [];
  for (const entry of entries) {
    const state = stateOf(entry, entries);
    if (entry.kind !== 'background' || state === null) {
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
