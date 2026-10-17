// Actions on one session: open it where it runs or in its panels, interrupt
// or stop it, change model or mode, and hand it off to another surface.
// Sessions Overlord launched are driven through the SDK. Any other local
// session can only be signalled, and only after the user agrees. What a
// session's agent can do comes from its adapter's capabilities and terminal
// facet.

import { CLAUDE_CODE } from '../../shared/agents.js';
import type { SessionSummary } from '../../shared/model.js';
import { sessionName } from '../../shared/model.js';
import type { HandoffKind, LaunchRun, SurfaceSession } from '../../shared/protocol.js';
import { isViewId } from '../../shared/protocol.js';
import { agents } from '../agents/index.js';
import type { AgentTerminal } from '../agents/terminals.js';
import { terminalOf } from '../agents/terminals.js';
import type { AgentAdapter, TerminalFacet } from '../agents/types.js';
import { isTerminal } from '../harness/launcher.js';
import type { AgentSession } from '../harness/session.js';
import type { HandoffCommand } from '../surfaces/handoff.js';
import type { LiveProcess } from '../surfaces/live.js';

import type { ActionHandlers } from './action-types.js';
import {
  agentCli,
  findLive,
  sessionAgent,
  sessionTerminal,
  terminalCommand,
} from './agent-terminal.js';
import { removeFailedJob, stopJob } from './idle-stop.js';
import { continueHere } from './resume.js';
import type { Runtime } from './runtime.js';
import { shortId } from './text.js';
import { clearOtherCopy } from './transfer.js';
import { restoreWorktree } from './worktrees.js';

type SessionActions =
  | 'openSession'
  | 'openAgent'
  | 'openContext'
  | 'openProperties'
  | 'openFile'
  | 'openView'
  | 'interrupt'
  | 'stop'
  | 'removeSession'
  | 'setModel'
  | 'setPermissionMode'
  | 'handoff';

interface SdkTarget {
  readonly run: LaunchRun;
  readonly session: AgentSession;
}

export const NOT_LOCAL = 'That session is not running on this machine.';
export const SDK_ONLY =
  'Only sessions Overlord launched can change model or permission mode while they run.';

/** The live SDK session behind a session id, when Overlord launched it. */
export function sdkTarget(rt: Runtime, sessionId: string): SdkTarget | null {
  const run = rt.launcher
    .runs()
    .find((candidate) => candidate.sessionId === sessionId && !isTerminal(candidate.state));
  const session = run === undefined ? null : rt.launcher.session(run.id);
  return run === undefined || session === null ? null : { run, session };
}

/** The live process holding a session on this machine, if any, as its agent records it. */
export async function liveProcess(
  rt: Runtime,
  sessionId: string,
): Promise<LiveProcess | undefined> {
  return findLive(rt, sessionId);
}

const TAB_TITLE_CHARS = 40;

/** Tab title for a handoff terminal that runs something else, for example "Claude teleport-local: Cloud fix". */
export function terminalName(
  kind: HandoffKind,
  title: string,
  terminal: TerminalFacet | undefined = terminalOf(CLAUDE_CODE)?.terminal,
): string {
  const short =
    title.length > TAB_TITLE_CHARS ? `${title.slice(0, TAB_TITLE_CHARS - 3)}...` : title;
  const label = `${kind}: ${short}`;
  return terminal?.tabName(label) ?? label;
}

/** The adapter of the session's agent, or null when no adapter has it. */
function sessionAdapter(rt: Runtime, sessionId: string): AgentAdapter | null {
  return agents.get(sessionAgent(rt, sessionId));
}

function fleetSession(rt: Runtime, sessionId: string): SessionSummary | undefined {
  return rt.store.fleetState(rt.clock()).sessions.find((candidate) => candidate.id === sessionId);
}

/** Where a terminal for this session should start. */
function cwdFor(rt: Runtime, sessionId: string, known: string | null): string {
  return known ?? fleetSession(rt, sessionId)?.cwd ?? rt.host.workspaceFolder() ?? rt.paths.home;
}

/** A tab that runs the session itself takes the session's name in the fleet. */
function tabName(rt: Runtime, session: SurfaceSession, cwd: string): string {
  return sessionName(fleetSession(rt, session.id) ?? { title: session.title, cwd });
}

type Running = LiveProcess & { readonly pid: number };

/** A live process and the terminal facet of the agent that runs it. */
interface LiveTarget {
  readonly at: AgentTerminal;
  readonly live: Running;
}

function running(live: LiveProcess | undefined): Running | null {
  return live === undefined || live.pid === null || !live.alive ? null : { ...live, pid: live.pid };
}

/** The live process behind a session and its agent's terminal facet, or null when it is not on this machine. */
async function liveTarget(rt: Runtime, sessionId: string): Promise<LiveTarget | null> {
  const at = sessionTerminal(rt, sessionId);
  const live = at === null ? null : running(await liveProcess(rt, sessionId));
  return at === null || live === null ? null : { at, live };
}

/** The live process behind a session, or null after saying it is not on this machine. */
async function reachable(rt: Runtime, sessionId: string): Promise<LiveTarget | null> {
  const target = await liveTarget(rt, sessionId);
  if (target === null) {
    rt.host.showInfo(NOT_LOCAL);
  }
  return target;
}

async function agreed(rt: Runtime, target: LiveTarget, verb: string): Promise<boolean> {
  const { at, live } = target;
  const question = `${verb} ${at.adapter.short} session ${shortId(live.sessionId)} (pid ${String(live.pid)})?`;
  return rt.host.confirm(question, verb);
}

export const INTERRUPT_IN_TAB = "Press Esc in the session's tab to interrupt it.";

/**
 * Claude Code takes SIGTERM to a background job's process for a crash and
 * respawns it, so a background job stops through its agent, here `claude
 * stop`. Any other process gets SIGTERM. True when it stopped.
 */
async function terminate(rt: Runtime, target: LiveTarget): Promise<boolean> {
  const { at, live } = target;
  const { background } = at.terminal;
  if (live.kind !== 'background' || live.agentId === null || background === undefined) {
    rt.kill(live.pid, 'SIGTERM');
    return true;
  }
  const control = { background, cli: await agentCli(rt, at) };
  return stopJob(rt, control, { id: live.agentId, pid: live.pid });
}

/**
 * Stop a session without asking, for a caller that already asked. False when
 * it is not running on this machine or would not stop.
 */
export async function stopNow(rt: Runtime, sessionId: string): Promise<boolean> {
  const target = sdkTarget(rt, sessionId);
  if (target !== null) {
    rt.launcher.stopRun(target.run.id);
    return true;
  }
  const live = await liveTarget(rt, sessionId);
  return live !== null && (await terminate(rt, live));
}

export const IN_LAUNCHER = 'This session is running in the Overlord launcher. Stop the run first.';

/** Handoffs whose terminal runs this same session, so its properties can follow it. */
const TRACKED_HANDOFFS: ReadonlySet<HandoffKind> = new Set<HandoffKind>(['remote-control']);

/** No other process may hold the session when Overlord resumes it. */
async function readyToResume(rt: Runtime, session: SurfaceSession): Promise<boolean> {
  if (sdkTarget(rt, session.id) !== null) {
    rt.host.showInfo(IN_LAUNCHER);
    return false;
  }
  return clearOtherCopy(rt, await liveProcess(rt, session.id), session.title);
}

/**
 * Handoffs that resume this session's own id on this machine, so they need
 * its folder and must not start a second copy. Cowork ids are not session
 * ids, and a teleport pulls a cloud session down instead.
 */
function resumesHere(kind: HandoffKind, session: SurfaceSession): boolean {
  return (
    kind === 'resume-local' ||
    kind === 'remote-control' ||
    (kind === 'open-desktop' && session.surface !== 'cowork')
  );
}

/** False, after saying why, when a handoff that resumes the session here cannot. */
export async function canHandOff(
  rt: Runtime,
  kind: HandoffKind,
  session: SurfaceSession,
  cwd: string,
): Promise<boolean> {
  if (!resumesHere(kind, session)) {
    return true;
  }
  // Claude Code finds a session by the folder it ran in, so resuming
  // anywhere else fails with a confusing "no conversation found". An
  // Overlord worktree tidied away once its work landed comes back instead.
  if (
    (await rt.fs.kind(cwd)) !== 'directory' &&
    !(await restoreWorktree(rt, session.id, cwd, session.title))
  ) {
    rt.host.showWarning(`Cannot continue "${session.title}": its folder ${cwd} no longer exists.`);
    return false;
  }
  return readyToResume(rt, session);
}

/** The command for a handoff the session's agent offers, with that agent's terminal facet, or null. */
function planHandoff(
  rt: Runtime,
  kind: HandoffKind,
  session: SurfaceSession,
): { readonly at: AgentTerminal; readonly command: HandoffCommand } | null {
  const at = terminalOf(session.agent);
  if (at?.adapter.capabilities.handoffs.includes(kind) !== true) {
    return null;
  }
  const command = at.terminal.handoff?.(kind, session, terminalCommand(rt, at)) ?? null;
  return command === null ? null : { at, command };
}

async function openAgentPanel(rt: Runtime, sessionId: string, agentId: string): Promise<void> {
  // Old sessions are not tailed, so load the transcript before the panel asks for it.
  const known = rt.store
    .fleetState(rt.clock())
    .sessions.some((session) => session.id === sessionId);
  if (!known && !(await rt.openTranscript(sessionId))) {
    rt.host.showInfo(`No transcript found for session ${shortId(sessionId)}.`);
    return;
  }
  rt.host.openPanel('agent', { sessionId, agentId });
}

/**
 * A tab running `claude attach` for a background session, tracked so a later
 * open focuses it. False when the session's agent has no background runs.
 */
async function attachBackground(rt: Runtime, sessionId: string): Promise<boolean> {
  const at = sessionTerminal(rt, sessionId);
  const background = at?.terminal.background;
  if (at === null || background === undefined) {
    return false;
  }
  const live = await liveProcess(rt, sessionId);
  const cwd = cwdFor(rt, sessionId, live?.cwd ?? null);
  rt.host.runInTerminal({
    name: at.terminal.tabName(shortId(sessionId)),
    command: terminalCommand(rt, at),
    args: background.attachArgs(live?.agentId ?? sessionId),
    // Attach reaches the session over a socket, so when its folder is gone
    // any folder will do, and VS Code will not start a tab in a missing one.
    cwd:
      (await rt.fs.kind(cwd)) === 'directory' ? cwd : (rt.host.workspaceFolder() ?? rt.paths.home),
    sessionId,
  });
  return true;
}

/**
 * Go to the session where it runs: its VS Code tab, a new attach tab for a
 * background session, and the agent view for anything else, since resuming a
 * session open in another terminal would start a second copy.
 */
async function showSession(rt: Runtime, sessionId: string): Promise<void> {
  await rt.places.refresh();
  const processId = rt.places.terminalFor(sessionId);
  if (await rt.host.showTerminal({ sessionId, processId })) {
    return;
  }
  if (rt.places.value[sessionId] === 'background' && (await attachBackground(rt, sessionId))) {
    return;
  }
  await openAgentPanel(rt, sessionId, sessionId);
}

export const sessionActions: ActionHandlers<SessionActions> = {
  openSession: async ({ rt }, { sessionId }) => {
    await showSession(rt, sessionId);
  },
  openAgent: async ({ rt }, action) => {
    await openAgentPanel(rt, action.sessionId, action.agentId);
  },
  openContext: async ({ rt }, action) => {
    const params =
      action.agentId === null
        ? { sessionId: action.sessionId }
        : { sessionId: action.sessionId, agentId: action.agentId };
    rt.host.openPanel('context', params);
    await Promise.resolve();
  },
  openProperties: async ({ rt }, action) => {
    rt.host.openPanel('properties', { sessionId: action.sessionId });
    await Promise.resolve();
  },
  openFile: async ({ rt }, action) => {
    await rt.host.openFile(action.path);
  },
  // Actions arrive over postMessage, so the view name is checked before it opens.
  openView: async ({ rt }, action) => {
    if (!isViewId(action.view)) {
      rt.host.showInfo(`Overlord does not know the view "${String(action.view)}".`);
      return;
    }
    rt.host.openPanel(action.view, {});
    await Promise.resolve();
  },
  interrupt: async ({ rt }, action) => {
    const target = sdkTarget(rt, action.sessionId);
    if (target !== null) {
      await target.session.interrupt();
      return;
    }
    const found = await reachable(rt, action.sessionId);
    if (found === null) {
      return;
    }
    // SIGINT ends a background job rather than its turn, and leaves the
    // turn's tools running, so Esc in its tab is the only clean interrupt.
    const signal = found.at.terminal.interruptSignal;
    if (found.live.kind === 'background' || signal === null) {
      await showSession(rt, action.sessionId);
      rt.host.showInfo(INTERRUPT_IN_TAB);
      return;
    }
    if (await agreed(rt, found, 'Interrupt')) {
      rt.kill(found.live.pid, signal);
    }
  },
  stop: async ({ rt }, action) => {
    const target = sdkTarget(rt, action.sessionId);
    if (target !== null) {
      rt.launcher.stopRun(target.run.id);
      return;
    }
    const found = await reachable(rt, action.sessionId);
    if (found !== null && (await agreed(rt, found, 'Stop')) && !(await terminate(rt, found))) {
      rt.host.showWarning(
        `${found.at.adapter.name} did not stop session ${shortId(action.sessionId)}.`,
      );
    }
  },
  // Launched sessions and failed background jobs stay in the fleet until
  // this. A launched one still running stops first, so a last update from it
  // cannot bring the row back.
  removeSession: async ({ rt }, action) => {
    const target = sdkTarget(rt, action.sessionId);
    if (target !== null) {
      rt.launcher.stopRun(target.run.id);
      await target.session.finished;
    }
    if (!(await removeFailedJob(rt, action.sessionId))) {
      return;
    }
    await rt.launched.remove(action.sessionId);
    await rt.dismissTranscript(action.sessionId);
    rt.bus.emit('session.removed', { sessionId: action.sessionId });
  },
  setModel: async ({ rt }, action) => {
    const target = sdkTarget(rt, action.sessionId);
    const adapter = sessionAdapter(rt, action.sessionId);
    if (target === null && adapter?.capabilities.liveModelChange === false) {
      rt.host.showInfo(`${adapter.name} cannot change model while a session runs.`);
      return;
    }
    if (target === null) {
      rt.host.showInfo(SDK_ONLY);
      return;
    }
    await target.session.setModel(action.model);
    rt.host.showInfo(`Model set to ${action.model}.`);
  },
  setPermissionMode: async ({ rt }, action) => {
    const { mode } = action;
    const target = sdkTarget(rt, action.sessionId);
    const adapter = sessionAdapter(rt, action.sessionId);
    // Each agent has its own modes, so the id is checked against the session's agent.
    if (adapter?.modes.permission.some((option) => option.id === mode) !== true) {
      rt.host.showInfo(`Unknown permission mode "${action.mode}".`);
    } else if (target === null && !adapter.capabilities.livePermissionMode) {
      rt.host.showInfo(`${adapter.name} cannot change permission mode while a session runs.`);
    } else if (target === null) {
      rt.host.showInfo(SDK_ONLY);
    } else {
      await target.session.setPermissionMode(mode);
      rt.host.showInfo(`Permission mode set to ${mode}.`);
    }
  },
  handoff: async ({ rt }, action) => {
    const find = (): SurfaceSession | undefined =>
      rt.caches.sessions.peek().sessions.find((session) => session.id === action.sessionId);
    if (find() === undefined) {
      await rt.caches.sessions.refresh();
    }
    const session = find();
    const planned = session === undefined ? null : planHandoff(rt, action.kind, session);
    if (session === undefined || planned === null) {
      rt.host.showInfo('That handoff is not available for this session.');
      return;
    }
    const { at, command } = planned;
    const cwd = cwdFor(rt, session.id, session.cwd);
    const missing = (await rt.fs.kind(cwd)) !== 'directory';
    if (!(await canHandOff(rt, action.kind, session, cwd))) {
      return;
    }
    if (action.kind === 'resume-local') {
      await continueHere(rt, { session, cwd, name: tabName(rt, session, cwd), restored: missing });
      return;
    }
    const tracked = TRACKED_HANDOFFS.has(action.kind);
    rt.host.runInTerminal({
      name: tracked
        ? tabName(rt, session, cwd)
        : terminalName(action.kind, session.title, at.terminal),
      command: command.command,
      args: command.args,
      cwd,
      sessionId: tracked ? session.id : null,
    });
  },
};
