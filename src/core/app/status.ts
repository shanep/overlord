// The status bar text, the Fleet's sidebar badge and the items of the
// "Running" tree view.

import type { AgentNode, SessionState, SessionSummary } from '../../shared/model.js';
import type { FleetState } from '../../shared/protocol.js';

import { formatUsd } from './prices.js';
import { plural, shortId } from './text.js';

export interface RunningItem {
  readonly id: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly label: string;
  readonly description: string;
  readonly state: SessionState;
  readonly children: readonly RunningItem[];
}

const ACTIVE: ReadonlySet<SessionState> = new Set(['running', 'waiting']);

function isActive(state: SessionState): boolean {
  return ACTIVE.has(state);
}

/** For example "Overlord: 3 running, 1 waiting, $1.20/h, 5h 40%". */
export function statusLine(fleet: FleetState): string {
  const running = fleet.sessions.filter((session) => session.state === 'running').length;
  const waiting = fleet.sessions.filter((session) => session.state === 'waiting').length;
  const parts = [`${String(running)} running`];
  if (waiting > 0) {
    parts.push(`${String(waiting)} waiting`);
  }
  parts.push(`${formatUsd(fleet.spendPerHourUsd)}/h`);
  const fiveHour = fleet.rateLimits.fiveHourPct;
  if (fiveHour !== null) {
    parts.push(`5h ${String(Math.round(fiveHour * 100))}%`);
  }
  return `Overlord: ${parts.join(', ')}`;
}

export interface WaitingBadge {
  readonly value: number;
  readonly tooltip: string;
}

/** The count on the Fleet's sidebar icon: sessions waiting on an answer or a permission, if any. */
export function waitingBadge(fleet: FleetState): WaitingBadge | undefined {
  const ids = new Set([
    ...fleet.sessions.filter((session) => session.state === 'waiting').map((session) => session.id),
    ...fleet.pendingPermissions.map((request) => request.sessionId),
  ]);
  return ids.size === 0
    ? undefined
    : { value: ids.size, tooltip: `${plural(ids.size, 'session')} waiting on you` };
}

function agentItem(agent: AgentNode): RunningItem {
  return {
    id: `${agent.sessionId}/${agent.id}`,
    sessionId: agent.sessionId,
    agentId: agent.id,
    label: agent.agentType,
    description: agent.currentTool ?? agent.state,
    state: agent.state,
    children: [],
  };
}

function sessionItem(session: SessionSummary, agents: readonly AgentNode[]): RunningItem {
  const children = agents
    .filter((agent) => agent.sessionId === session.id && agent.id !== session.id)
    .filter((agent) => isActive(agent.state))
    .map((agent) => agentItem(agent));
  const extra = children.length === 0 ? '' : `, ${plural(children.length, 'subagent')}`;
  return {
    id: session.id,
    sessionId: session.id,
    agentId: session.id,
    label: session.title === '' ? shortId(session.id) : session.title,
    description: `${session.state}${extra}`,
    state: session.state,
    children,
  };
}

/** Sessions that are running or waiting on the user, each with its active subagents. */
export function runningItems(fleet: FleetState): readonly RunningItem[] {
  return fleet.sessions
    .filter((session) => isActive(session.state))
    .map((session) => sessionItem(session, fleet.agents));
}
