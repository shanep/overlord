// Continuing a session in another folder. Claude Code fixes a session's
// folder when it starts, so Overlord stops the session and resumes a fork of
// it in the new folder. Claude Code finds a session by id from any folder, and
// the fork records the new one, so the original stays behind as it was.

import { sessionName } from '../../shared/model.js';
import { readClaudeAgents } from '../surfaces/live.js';

import { IN_LAUNCHER, liveProcess, sdkTarget } from './actions-session.js';
import { stopJob } from './idle-stop.js';
import type { Runtime } from './runtime.js';
import { shortId } from './text.js';
import { clearOtherCopy } from './transfer.js';
import { fleetFor } from './views/fleet.js';
import { startSession } from './worktrees.js';

export const STOP_LABEL = 'Stop and continue';

/**
 * Makes sure the original is not still working in its old folder. A
 * background job stops through Claude Code, which keeps its conversation, and
 * a terminal's claude gets SIGTERM. True when it is safe to continue.
 */
async function stopOriginal(
  rt: Runtime,
  sessionId: string,
  title: string,
  folder: string,
): Promise<boolean> {
  const cli = await rt.claudeCli();
  const agents = await readClaudeAgents(rt.surfacesExec, { claudeBin: cli.bin });
  const job = agents.items.find(
    (entry) => entry.sessionId === sessionId && entry.kind === 'background',
  );
  if (job === undefined || job.id === null || job.pid === null || !rt.isAlive(job.pid)) {
    return clearOtherCopy(rt, await liveProcess(rt, sessionId), title);
  }
  const question = `"${title}" is still running in the background. Stop it and continue a copy in ${folder}?`;
  if (!(await rt.host.confirm(question, STOP_LABEL))) {
    return false;
  }
  if (await stopJob(rt, cli, { id: job.id, pid: job.pid })) {
    return true;
  }
  rt.host.showWarning(`Claude Code did not stop "${title}", so Overlord did not continue it.`);
  return false;
}

/** Asks for a folder and continues a fork of the session there. */
export async function continueInFolder(rt: Runtime, sessionId: string): Promise<void> {
  const session = fleetFor(rt).sessions.find((item) => item.id === sessionId);
  if (session === undefined) {
    rt.host.showInfo('That session is gone.');
    return;
  }
  if (sdkTarget(rt, sessionId) !== null) {
    rt.host.showInfo(IN_LAUNCHER);
    return;
  }
  const title = session.title === '' ? shortId(sessionId) : session.title;
  const folder = await rt.host.pickFolder(`Continue "${title}" in`);
  if (folder === null) {
    return;
  }
  if (folder === session.cwd) {
    rt.host.showInfo(`"${title}" already runs in ${folder}.`);
    return;
  }
  if (!(await stopOriginal(rt, sessionId, title, folder))) {
    return;
  }
  const name = sessionName({ title: session.title, cwd: folder });
  await startSession(rt, folder, { name, forkOf: sessionId });
  const left = session.cwd === '' ? '' : ` The original stays in ${session.cwd}.`;
  rt.host.showInfo(`Continuing "${title}" in ${folder}.${left}`);
}
