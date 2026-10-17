// A background session whose work is finished stops on its own a few minutes
// after its last reply, so its worktree can go without the user closing
// anything. Only a job Claude Code calls done qualifies: a reply that asks the
// user something reads blocked and keeps running. So does a session a tab or
// any `claude attach` shows, and one whose worktree holds work that has not
// landed. `claude stop` keeps the conversation, so Continue picks it up later.

import type { AgentTerminal } from '../agents/terminals.js';
import { terminalAgents } from '../agents/terminals.js';
import { isInside } from '../context/path-tools.js';
import type { AgentEntry } from '../surfaces/live.js';

import { agentCli } from './agent-terminal.js';
import { messageOf } from './errors.js';
import { nothingLeft, stillAttached, stopJob } from './idle-stop.js';
import type { Runtime } from './runtime.js';
import { tidyWorktrees } from './worktrees.js';

/** How often finished sessions are looked for. */
export const FINISHED_CHECK_MS = 60_000;
/** How long a finished session stays up after its last reply, in case the user has more to say. */
export const FINISHED_GRACE_MS = 5 * 60_000;
const SOURCE = 'finished stop';

/** When each session was first seen done, so one that keeps reading done counts from then. */
export class FinishedWatch {
  private readonly since = new Map<string, number>();

  /** Notes the sessions done now and forgets the rest. Returns when each was first seen done. */
  note(done: readonly string[], now: number): ReadonlyMap<string, number> {
    for (const sessionId of this.since.keys()) {
      if (!done.includes(sessionId)) {
        this.since.delete(sessionId);
      }
    }
    for (const sessionId of done) {
      if (!this.since.has(sessionId)) {
        this.since.set(sessionId, now);
      }
    }
    return this.since;
  }
}

interface Finished {
  readonly at: AgentTerminal;
  readonly job: AgentEntry & { readonly id: string; readonly pid: number };
}

function isStoppable(job: AgentEntry): job is Finished['job'] {
  return job.id !== null && job.pid !== null;
}

/** The agent's live background jobs that are done with nothing left open. */
async function finishedJobs(rt: Runtime, at: AgentTerminal): Promise<Finished[]> {
  const { background } = at.terminal;
  if (background === undefined) {
    return [];
  }
  const { bin } = await agentCli(rt, at);
  const agents = await background.list({ exec: rt.surfacesExec, bin, all: false });
  return agents.items
    .filter((job) => job.state === 'done' && nothingLeft(job, rt.sessionBusy(job.sessionId)))
    .filter(isStoppable)
    .map((job) => ({ at, job }));
}

/** True when the folder is in an Overlord worktree with nothing uncommitted or unlanded. */
function inLandedWorktree(rt: Runtime, cwd: string | null): boolean {
  if (cwd === null) {
    return false;
  }
  const tree = rt.caches.worktrees.value.find((item) => isInside(item.path, cwd));
  return tree?.dirty === 0 && tree.ahead === 0;
}

/** When the session last did anything: its last transcript write or when it was first seen done. */
function quietSince(rt: Runtime, sessionId: string, seen: number, now: number): number {
  const session = rt.store.fleetState(now).sessions.find((item) => item.id === sessionId);
  return Math.max(seen, session?.updatedAt ?? 0);
}

async function stopOne(rt: Runtime, { at, job }: Finished): Promise<boolean> {
  const { background } = at.terminal;
  // A tab Overlord opened for the session, or any attach anywhere, keeps it up.
  if (
    background === undefined ||
    rt.sessionWorktrees.has(job.sessionId) ||
    !inLandedWorktree(rt, job.cwd) ||
    (await stillAttached(rt, background, job.sessionId, 1))
  ) {
    return false;
  }
  return stopJob(rt, { background, cli: await agentCli(rt, at) }, job);
}

/** Stops each background session that has been done for the grace period, then tidies worktrees. */
export async function stopFinished(rt: Runtime, watch: FinishedWatch): Promise<void> {
  try {
    const now = rt.clock();
    const lists = await Promise.all(terminalAgents().map(async (at) => finishedJobs(rt, at)));
    const found = lists.flat();
    const since = watch.note(
      found.map(({ job }) => job.sessionId),
      now,
    );
    const ripe = found.filter(({ job }) => {
      const seen = since.get(job.sessionId) ?? now;
      return now - quietSince(rt, job.sessionId, seen, now) >= FINISHED_GRACE_MS;
    });
    if (ripe.length === 0) {
      return;
    }
    // The worktree list is up to a minute old, and a commit may have landed since.
    await rt.caches.worktrees.refresh();
    let stopped = false;
    for (const finished of ripe) {
      stopped = (await stopOne(rt, finished)) || stopped;
    }
    if (stopped) {
      await tidyWorktrees(rt);
    }
  } catch (error: unknown) {
    rt.report(SOURCE, messageOf(error));
  }
}
