// Actions on one session: open it where it runs or in its panels, interrupt
// or stop it, change model or mode, and hand it off to another surface.
// Sessions Overlord launched are driven through the SDK. Any other local
// session can only be signalled, and only after the user agrees.

import type { SessionSummary } from '../../shared/model.js';
import { sessionName } from '../../shared/model.js';
import type { HandoffKind, LaunchRun, SurfaceSession } from '../../shared/protocol.js';
import { isViewId } from '../../shared/protocol.js';
import { parsePermissionMode } from '../harness/events.js';
import { isTerminal } from '../harness/launcher.js';
import type { SdkSession } from '../harness/session.js';
import { buildHandoff } from '../surfaces/handoff.js';
import type { LiveProcess } from '../surfaces/live.js';
import { buildLiveProcessTable } from '../surfaces/live.js';

import type { ActionContext, ActionHandlers } from './action-types.js';
import { openClaudeTab } from './claude-tabs.js';
import type { Runtime } from './runtime.js';
import { shortId } from './text.js';
import { clearOtherCopy } from './transfer.js';

type SessionActions =
  | 'openSession'
  | 'openAgent'
  | 'openContext'
  | 'openProperties'
  | 'openFile'
  | 'openView'
  | 'interrupt'
  | 'stop'
  | 'setModel'
  | 'setPermissionMode'
  | 'handoff';

interface SdkTarget {
  readonly run: LaunchRun;
  readonly session: SdkSession;
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

/** The live claude process holding a session on this machine, if any. */
export async function liveProcess(
  rt: Runtime,
  sessionId: string,
): Promise<LiveProcess | undefined> {
  const table = await buildLiveProcessTable({
    paths: rt.paths,
    exec: rt.surfacesExec,
    isAlive: rt.isAlive,
    options: { claudeBin: rt.host.settings.claudePath },
  });
  return table.processes.get(sessionId);
}

const TAB_TITLE_CHARS = 40;

/** Tab title for a handoff terminal that runs something else, for example "Claude teleport-local: Cloud fix". */
export function terminalName(kind: HandoffKind, title: string): string {
  const short =
    title.length > TAB_TITLE_CHARS ? `${title.slice(0, TAB_TITLE_CHARS - 3)}...` : title;
  return `Claude ${kind}: ${short}`;
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

async function signal(
  context: ActionContext,
  sessionId: string,
  kind: { readonly verb: string; readonly signal: NodeJS.Signals },
): Promise<void> {
  const { rt } = context;
  const live = await liveProcess(rt, sessionId);
  if (live === undefined || live.pid === null || !live.alive) {
    rt.host.showInfo(NOT_LOCAL);
    return;
  }
  const question = `${kind.verb} Claude session ${shortId(sessionId)} (pid ${String(live.pid)})?`;
  if (await rt.host.confirm(question, kind.verb)) {
    rt.kill(live.pid, kind.signal);
  }
}

/**
 * Stop a session without asking, for a caller that already asked. False when
 * it is not running on this machine.
 */
export async function stopNow(rt: Runtime, sessionId: string): Promise<boolean> {
  const target = sdkTarget(rt, sessionId);
  if (target !== null) {
    rt.launcher.stopRun(target.run.id);
    return true;
  }
  const live = await liveProcess(rt, sessionId);
  if (live === undefined || live.pid === null || !live.alive) {
    return false;
  }
  rt.kill(live.pid, 'SIGTERM');
  return true;
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
  // anywhere else fails with a confusing "no conversation found".
  if ((await rt.fs.kind(cwd)) !== 'directory') {
    rt.host.showWarning(`Cannot continue "${session.title}": its folder ${cwd} no longer exists.`);
    return false;
  }
  return readyToResume(rt, session);
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

/** A tab running `claude attach` for a background session, tracked so a later open focuses it. */
async function attachBackground(rt: Runtime, sessionId: string): Promise<void> {
  const live = await liveProcess(rt, sessionId);
  rt.host.runInTerminal({
    name: `Claude ${shortId(sessionId)}`,
    command: rt.host.settings.claudePath,
    args: ['attach', live?.agentId ?? sessionId],
    cwd: cwdFor(rt, sessionId, live?.cwd ?? null),
    sessionId,
  });
}

export const sessionActions: ActionHandlers<SessionActions> = {
  // Go to the session where it runs: its VS Code tab, a new attach tab for a
  // background session, and the agent view for anything else, since resuming
  // a session open in another terminal would start a second copy.
  openSession: async ({ rt }, { sessionId }) => {
    await rt.places.refresh();
    const processId = rt.places.terminalFor(sessionId);
    if (await rt.host.showTerminal({ sessionId, processId })) {
      return;
    }
    if (rt.places.value[sessionId] === 'background') {
      await attachBackground(rt, sessionId);
      return;
    }
    await openAgentPanel(rt, sessionId, sessionId);
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
  interrupt: async (context, action) => {
    const target = sdkTarget(context.rt, action.sessionId);
    if (target === null) {
      await signal(context, action.sessionId, { verb: 'Interrupt', signal: 'SIGINT' });
      return;
    }
    await target.session.interrupt();
  },
  stop: async (context, action) => {
    const target = sdkTarget(context.rt, action.sessionId);
    if (target === null) {
      await signal(context, action.sessionId, { verb: 'Stop', signal: 'SIGTERM' });
      return;
    }
    context.rt.launcher.stopRun(target.run.id);
  },
  setModel: async ({ rt }, action) => {
    const target = sdkTarget(rt, action.sessionId);
    if (target === null) {
      rt.host.showInfo(SDK_ONLY);
      return;
    }
    await target.session.setModel(action.model);
    rt.host.showInfo(`Model set to ${action.model}.`);
  },
  setPermissionMode: async ({ rt }, action) => {
    const mode = parsePermissionMode(action.mode);
    const target = sdkTarget(rt, action.sessionId);
    if (mode === null) {
      rt.host.showInfo(`Unknown permission mode "${action.mode}".`);
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
    const command =
      session === undefined
        ? null
        : buildHandoff(action.kind, session, { claudeBin: rt.host.settings.claudePath });
    if (session === undefined || command === null) {
      rt.host.showInfo('That handoff is not available for this session.');
      return;
    }
    const cwd = cwdFor(rt, session.id, session.cwd);
    if (!(await canHandOff(rt, action.kind, session, cwd))) {
      return;
    }
    if (action.kind === 'resume-local') {
      await openClaudeTab(rt, { name: tabName(rt, session, cwd), cwd, resume: session.id });
      return;
    }
    const tracked = TRACKED_HANDOFFS.has(action.kind);
    rt.host.runInTerminal({
      name: tracked ? tabName(rt, session, cwd) : terminalName(action.kind, session.title),
      command: command.command,
      args: command.args,
      cwd,
      sessionId: tracked ? session.id : null,
    });
  },
};
