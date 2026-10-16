// One builder per view. Each is a synchronous read of the store and the
// background caches, so a panel can ask for state at any time.

import type {
  AgentDetailState,
  HostToWebview,
  LauncherState,
  ViewId,
} from '../../../shared/protocol.js';
import type { PanelParams } from '../host-port.js';
import type { Runtime } from '../runtime.js';

import { fleetFor } from './fleet.js';
import { buildFrustration } from './frustration.js';
import { buildKnobs } from './knobs.js';
import { buildMessages } from './messages.js';
import { buildProperties } from './properties.js';
import { buildSessions } from './sessions.js';
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
      const state = buildProperties(rt.store, rt.permissions.list(), params.sessionId ?? null);
      return { type: 'state', view, state };
    }
  }
}

export function stateFor(rt: Runtime, view: ViewId, params: PanelParams): HostToWebview {
  if (isSessionView(view)) {
    return sessionStateFor(rt, view, params);
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
      return { type: 'state', view, state: buildSessions(rt.caches.sessions.value) };
    }
    case 'config': {
      return { type: 'state', view, state: rt.caches.config.value };
    }
    case 'usage': {
      return { type: 'state', view, state: buildUsage(rt) };
    }
    case 'frustration': {
      return { type: 'state', view, state: buildFrustration(rt) };
    }
    case 'messages': {
      return { type: 'state', view, state: buildMessages(rt) };
    }
  }
}
