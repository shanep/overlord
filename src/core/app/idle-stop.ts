// Closing the tab of a background session stops the session when it has
// nothing left to do, so idle sessions do not pile up in the background and
// their worktrees can go. A session mid turn, or waiting on a permission
// prompt, keeps running. `claude stop` keeps the conversation, so Continue in
// All Sessions picks it back up later. Each step goes through the session's
// agent's background facet, and an agent without one never stops this way.
// Removing a failed job from the fleet deletes it the same way.

import type { AgentCli, BackgroundFacet } from '../agents/types.js';
import type { AgentEntry } from '../surfaces/live.js';
import { attachesTo } from '../surfaces/places.js';

import { agentCli, sessionTerminal } from './agent-terminal.js';
import { messageOf } from './errors.js';
import type { Runtime } from './runtime.js';

/** The closed tab's own `claude attach` can take a moment to exit. */
export const DETACH_TRIES = 10;
/** `claude stop` returns before the process is gone, and the worktree check needs it gone. */
export const EXIT_TRIES = 25;
export const POLL_DELAY_MS = 200;
const PS_TIMEOUT_MS = 5000;
const SOURCE = 'idle stop';

// A finished turn reads "done", and a session that never got a prompt reads
// "blocked". So does one waiting on a permission prompt, but its transcript
// still has the tool call open, which `busy` catches.
const RESTING = new Set(['done', 'blocked']);

/** True when Claude Code says the job is resting and its transcript has nothing open. */
export function nothingLeft(job: AgentEntry, busy: boolean): boolean {
  return (
    job.kind === 'background' &&
    job.pid !== null &&
    job.status === 'idle' &&
    RESTING.has(job.state ?? '') &&
    !busy
  );
}

/** True when some `claude attach` still shows the session, in VS Code or any other terminal. */
async function stillAttached(
  rt: Runtime,
  background: BackgroundFacet,
  sessionId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < DETACH_TRIES; attempt += 1) {
    if (attempt > 0) {
      await rt.delay(POLL_DELAY_MS);
    }
    const ps = await rt.exec('ps', ['-A', '-o', 'pid=,ppid=,args='], { timeoutMs: PS_TIMEOUT_MS });
    const clients = background.attachClients(ps.stdout);
    if (!clients.some((client) => attachesTo(client, sessionId))) {
      return false;
    }
  }
  return true;
}

async function waitForExit(rt: Runtime, pid: number): Promise<void> {
  for (let attempt = 0; attempt < EXIT_TRIES && rt.isAlive(pid); attempt += 1) {
    await rt.delay(POLL_DELAY_MS);
  }
}

/** A background job with a process to stop. */
export interface RunningJob {
  readonly id: string;
  readonly pid: number;
}

/** The agent's background runs, the CLI that drives them, and the job to stop. */
interface JobControl {
  readonly background: BackgroundFacet;
  readonly cli: AgentCli;
}

/** Stops a background job, keeping its conversation, and waits for its process to go. True when it stopped. */
export async function stopJob(rt: Runtime, control: JobControl, job: RunningJob): Promise<boolean> {
  const failed = await control.background.stop({ run: rt.exec, cli: control.cli, jobId: job.id });
  if (failed !== null) {
    rt.report(SOURCE, failed);
    return false;
  }
  await waitForExit(rt, job.pid);
  void rt.places.refresh();
  void rt.jobs.refresh();
  return true;
}

/**
 * A failed background job stays in the agent's list, and so in the fleet,
 * until the agent deletes it. Continuing it starts a new session instead, so
 * Remove deletes it. False after saying why when it could not.
 */
export async function removeFailedJob(rt: Runtime, sessionId: string): Promise<boolean> {
  const at = sessionTerminal(rt, sessionId);
  const background = at?.terminal.background;
  if (at === null || background === undefined) {
    return true;
  }
  const cli = await agentCli(rt, at);
  const listed = await background.list({ exec: rt.surfacesExec, bin: cli.bin, all: true });
  const job = listed.items.find(
    (entry) => entry.sessionId === sessionId && entry.state === 'failed',
  );
  if (job === undefined || job.id === null) {
    return true;
  }
  const failed = await background.remove({ run: rt.exec, cli, jobId: job.id });
  if (failed !== null) {
    rt.host.showWarning(failed);
    return false;
  }
  void rt.jobs.refresh();
  return true;
}

/**
 * A tab showing this session closed. Stops the session when it is a
 * background job with nothing left to do and no other tab shows it. True when
 * it stopped it.
 */
export async function stopIfIdle(rt: Runtime, sessionId: string): Promise<boolean> {
  try {
    const at = sessionTerminal(rt, sessionId);
    const background = at?.terminal.background;
    if (at === null || background === undefined) {
      return false;
    }
    const cli = await agentCli(rt, at);
    const agents = await background.list({ exec: rt.surfacesExec, bin: cli.bin, all: false });
    const job = agents.items.find((entry) => entry.sessionId === sessionId);
    if (
      job === undefined ||
      job.id === null ||
      job.pid === null ||
      !nothingLeft(job, rt.sessionBusy(sessionId))
    ) {
      return false;
    }
    if (await stillAttached(rt, background, sessionId)) {
      return false;
    }
    return await stopJob(rt, { background, cli }, { id: job.id, pid: job.pid });
  } catch (error: unknown) {
    rt.report(SOURCE, messageOf(error));
    return false;
  }
}
