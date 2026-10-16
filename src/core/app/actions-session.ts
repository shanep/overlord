// Actions on one session: open its panels, interrupt or stop it, attach a
// terminal, change model or mode, and hand it off to another surface.
// Sessions Overlord launched are driven through the SDK. Any other local
// session can only be signalled, and only after the user agrees.

import type { LaunchRun, SurfaceSession } from '../../shared/protocol.js';
import { parsePermissionMode } from '../harness/events.js';
import { isTerminal } from '../harness/launcher.js';
import type { SdkSession } from '../harness/session.js';
import { buildHandoff } from '../surfaces/handoff.js';
import type { LiveProcess } from '../surfaces/live.js';
import { buildLiveProcessTable } from '../surfaces/live.js';

import type { ActionContext, ActionHandlers } from './action-types.js';
import type { Runtime } from './runtime.js';
import { shortId } from './text.js';

type SessionActions =
  | 'openAgent'
  | 'openContext'
  | 'openFile'
  | 'interrupt'
  | 'stop'
  | 'attach'
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

async function liveProcess(rt: Runtime, sessionId: string): Promise<LiveProcess | undefined> {
  const table = await buildLiveProcessTable({
    paths: rt.paths,
    exec: rt.surfacesExec,
    isAlive: rt.isAlive,
    options: { claudeBin: rt.host.settings.claudePath },
  });
  return table.processes.get(sessionId);
}

/** Where a terminal for this session should start. */
function cwdFor(rt: Runtime, sessionId: string, known: string | null): string {
  const session = rt.store
    .fleetState(rt.clock())
    .sessions.find((candidate) => candidate.id === sessionId);
  return known ?? session?.cwd ?? rt.host.workspaceFolder() ?? rt.paths.home;
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

export const sessionActions: ActionHandlers<SessionActions> = {
  openAgent: async ({ rt }, action) => {
    rt.host.openPanel('agent', { sessionId: action.sessionId, agentId: action.agentId });
    await Promise.resolve();
  },
  openContext: async ({ rt }, action) => {
    const params =
      action.agentId === null
        ? { sessionId: action.sessionId }
        : { sessionId: action.sessionId, agentId: action.agentId };
    rt.host.openPanel('context', params);
    await Promise.resolve();
  },
  openFile: async ({ rt }, action) => {
    await rt.host.openFile(action.path);
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
  attach: async ({ rt }, action) => {
    const live = await liveProcess(rt, action.sessionId);
    const background = live?.kind === 'background';
    const args = background
      ? ['attach', live.agentId ?? action.sessionId]
      : ['--resume', action.sessionId];
    rt.host.runInTerminal({
      name: `Claude ${shortId(action.sessionId)}`,
      command: rt.host.settings.claudePath,
      args,
      cwd: cwdFor(rt, action.sessionId, live?.cwd ?? null),
    });
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
    rt.host.runInTerminal({
      name: `Claude ${action.kind}`,
      command: command.command,
      args: command.args,
      cwd: cwdFor(rt, session.id, session.cwd),
    });
  },
};
