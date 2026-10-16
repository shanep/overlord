// Closing the tab of a background session stops the session when it has
// nothing left to do, so idle sessions do not pile up in the background and
// their worktrees can go. A session mid turn, or waiting on a permission
// prompt, keeps running. `claude stop` keeps the conversation, so Continue in
// All Sessions picks it back up later.

import type { AgentEntry } from '../surfaces/live.js';
import { readClaudeAgents } from '../surfaces/live.js';
import { attachesTo, parseAttachClients } from '../surfaces/places.js';

import { messageOf } from './errors.js';
import type { Runtime } from './runtime.js';

/** The closed tab's own `claude attach` can take a moment to exit. */
export const DETACH_TRIES = 10;
/** `claude stop` returns before the process is gone, and the worktree check needs it gone. */
export const EXIT_TRIES = 25;
export const POLL_DELAY_MS = 200;
const STOP_TIMEOUT_MS = 15_000;
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
async function stillAttached(rt: Runtime, sessionId: string): Promise<boolean> {
  for (let attempt = 0; attempt < DETACH_TRIES; attempt += 1) {
    if (attempt > 0) {
      await rt.delay(POLL_DELAY_MS);
    }
    const ps = await rt.exec('ps', ['-A', '-o', 'pid=,ppid=,args='], { timeoutMs: PS_TIMEOUT_MS });
    const clients = parseAttachClients(ps.stdout);
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

/**
 * A tab showing this session closed. Stops the session when it is a
 * background job with nothing left to do and no other tab shows it. True when
 * it stopped it.
 */
export async function stopIfIdle(rt: Runtime, sessionId: string): Promise<boolean> {
  try {
    const cli = await rt.claudeCli();
    const agents = await readClaudeAgents(rt.surfacesExec, { claudeBin: cli.bin });
    const job = agents.items.find((entry) => entry.sessionId === sessionId);
    if (
      job === undefined ||
      job.id === null ||
      job.pid === null ||
      !nothingLeft(job, rt.sessionBusy(sessionId))
    ) {
      return false;
    }
    if (await stillAttached(rt, sessionId)) {
      return false;
    }
    const result = await rt.exec(cli.bin, ['stop', job.id], {
      timeoutMs: STOP_TIMEOUT_MS,
      env: cli.env,
    });
    if (result.code !== 0) {
      rt.report(SOURCE, `claude stop ${job.id} failed: ${result.stderr.trim()}`);
      return false;
    }
    await waitForExit(rt, job.pid);
    void rt.places.refresh();
    void rt.jobs.refresh();
    return true;
  } catch (error: unknown) {
    rt.report(SOURCE, messageOf(error));
    return false;
  }
}
