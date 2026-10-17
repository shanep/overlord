// One builder per view. Each is a synchronous read of the store and the
// background caches, so a panel can ask for state at any time.

import type {
  AgentDetailState,
  HostToWebview,
  LauncherState,
  ViewId,
} from '../../../shared/protocol.js';
import { launchFolder } from '../actions-launch.js';
import type { PanelParams } from '../host-port.js';
import type { Runtime } from '../runtime.js';

import { buildConnectors } from './connectors.js';
import { fleetFor } from './fleet.js';
import { buildKnobs } from './knobs.js';
import { buildLibrary } from './library.js';
import { buildMessages } from './messages.js';
import { buildProperties } from './properties.js';
import { buildReputation } from './reputation.js';
import { buildSessions } from './sessions.js';
import { buildTuning } from './tuning.js';
import { buildUsage } from './usage.js';

function buildAgent(rt: Runtime, params: PanelParams): AgentDetailState {
  const sessionId = params.sessionId ?? '';
  return rt.store.agentDetailState(sessionId, params.agentId ?? sessionId);
}

function buildLauncher(rt: Runtime): LauncherState {
  const snapshot = rt.launcher.state();
  return {
    runs: snapshot.runs,
    maxConcurrency: snapshot.maxConcurrency,
    profiles: rt.caches.profiles.value,
    drafts: rt.caches.drafts.value,
    pendingPermissions: rt.permissions.list(),
    rules: rt.permissions.rules(),
    worktrees: rt.caches.worktrees.value,
    defaultFolder: launchFolder(rt),
  };
}

type SessionView = 'agent' | 'context' | 'properties';

const SESSION_VIEWS: ReadonlySet<ViewId> = new Set<SessionView>(['agent', 'context', 'properties']);

function isSessionView(view: ViewId): view is SessionView {
  return SESSION_VIEWS.has(view);
}

/** Views about one session or agent, picked by the panel params. */
function sessionStateFor(rt: Runtime, view: SessionView, params: PanelParams): HostToWebview {
  switch (view) {
    case 'agent': {
      return { type: 'state', view, state: buildAgent(rt, params) };
    }
    case 'context': {
      return { type: 'state', view, state: rt.context.build(params) };
    }
    case 'properties': {
      const state = buildProperties(
        rt.store,
        rt.permissions.list(),
        params.sessionId ?? null,
        (sessionId) => rt.places.pidOf(sessionId),
      );
      return { type: 'state', view, state };
    }
  }
}

type ReportView =
  'usage' | 'reputation' | 'messages' | 'help' | 'tuning' | 'connectors' | 'activity';

const REPORT_VIEWS: ReadonlySet<ViewId> = new Set<ReportView>([
  'usage',
  'reputation',
  'messages',
  'help',
  'tuning',
  'connectors',
  'activity',
]);

function isReportView(view: ViewId): view is ReportView {
  return REPORT_VIEWS.has(view);
}

/** The Global views that report on history, setup and live load rather than one session. */
function reportStateFor(rt: Runtime, view: ReportView): HostToWebview {
  switch (view) {
    case 'usage': {
      return { type: 'state', view, state: buildUsage(rt) };
    }
    case 'reputation': {
      return { type: 'state', view, state: buildReputation(rt) };
    }
    case 'messages': {
      return { type: 'state', view, state: buildMessages(rt) };
    }
    case 'help': {
      return { type: 'state', view, state: {} };
    }
    case 'tuning': {
      return { type: 'state', view, state: buildTuning(rt) };
    }
    case 'connectors': {
      return { type: 'state', view, state: buildConnectors(rt) };
    }
    case 'activity': {
      return { type: 'state', view, state: rt.activity.state() };
    }
  }
}

export function stateFor(rt: Runtime, view: ViewId, params: PanelParams): HostToWebview {
  if (isSessionView(view)) {
    return sessionStateFor(rt, view, params);
  }
  if (isReportView(view)) {
    return reportStateFor(rt, view);
  }
  switch (view) {
    case 'fleet': {
      return {
        type: 'state',
        view,
        state: fleetFor(rt),
      };
    }
    case 'knobs': {
      const state = buildKnobs(rt.caches.knobs.value, rt.caches.profiles.value);
      return { type: 'state', view, state };
    }
    case 'launcher': {
      return { type: 'state', view, state: buildLauncher(rt) };
    }
    case 'sessions': {
      return {
        type: 'state',
        view,
        state: buildSessions(rt.caches.sessions.value, rt.worktrees.projectFor),
      };
    }
    case 'config': {
      const state = { ...rt.caches.config.value, sync: rt.configSync.status() };
      return { type: 'state', view, state };
    }
    case 'skills': {
      return { type: 'state', view, state: buildLibrary(rt, 'skill') };
    }
    case 'agents': {
      return { type: 'state', view, state: buildLibrary(rt, 'agent') };
    }
  }
}
