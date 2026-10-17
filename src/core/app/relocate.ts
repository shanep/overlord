// Continuing a session in another folder. Claude Code fixes a session's
// folder when it starts, so Overlord stops the session and resumes a fork of
// it in the new folder. Claude Code finds a session by id from any folder, and
// the fork records the new one, so the original stays behind as it was.

import type { AgentId } from '../../shared/agents.js';
import { sessionName } from '../../shared/model.js';
import { terminalOf } from '../agents/terminals.js';

import { IN_LAUNCHER, liveProcess, sdkTarget } from './actions-session.js';
import { agentCli, sessionTerminal } from './agent-terminal.js';
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
  const at = sessionTerminal(rt, sessionId);
  const background = at?.terminal.background;
  if (at === null || background === undefined) {
    return clearOtherCopy(rt, await liveProcess(rt, sessionId), title);
  }
  const cli = await agentCli(rt, at);
  const agents = await background.list({ exec: rt.surfacesExec, bin: cli.bin, all: false });
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
  if (await stopJob(rt, { background, cli }, { id: job.id, pid: job.pid })) {
    return true;
  }
  rt.host.showWarning(
    `${at.adapter.name} did not stop "${title}", so Overlord did not continue it.`,
  );
  return false;
}

/** False, after saying so, when the session's agent cannot fork a session into a new tab. */
function canFork(rt: Runtime, agent: AgentId): boolean {
  const adapter = terminalOf(agent)?.adapter;
  if (adapter?.capabilities.fork === true) {
    return true;
  }
  rt.host.showInfo(`${adapter?.name ?? agent} cannot continue a session in another folder.`);
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
  if (!canFork(rt, session.agent)) {
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
  await startSession(rt, folder, { name, forkOf: sessionId, agent: session.agent });
  const left = session.cwd === '' ? '' : ` The original stays in ${session.cwd}.`;
  rt.host.showInfo(`Continuing "${title}" in ${folder}.${left}`);
}
