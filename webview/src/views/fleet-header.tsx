// Fleet header stats and the pending permissions banner.

import type { ReactElement } from 'react';

import type { PermissionRequest, SessionSummary } from '../../../src/shared/model.js';
import type { FleetState } from '../../../src/shared/protocol.js';
import { Badge } from '../components/badge.js';
import { Meter } from '../components/meter.js';
import { formatCost, formatDuration, formatValue, truncate } from '../format.js';

import { normalizeRatio } from './fleet-rows.js';

function Stat(props: {
  readonly label: string;
  readonly children: ReactElement | string;
}): ReactElement {
  return (
    <div className="stat">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

export function FleetHeader(props: {
  readonly state: FleetState;
  readonly now: number;
}): ReactElement {
  const { state, now } = props;
  const count = (wanted: string): number =>
    state.sessions.filter((session) => session.state === wanted).length;
  const subagents = state.agents.filter(
    (agent) => agent.id !== agent.sessionId && agent.state === 'running',
  ).length;
  const { fiveHourPct, sevenDayPct, resetsAt } = state.rateLimits;
  return (
    <header className="view-header">
      <h1>Fleet</h1>
      <dl className="stats">
        <Stat label="Running">{`${count('running').toString()} of ${state.sessions.length.toString()}`}</Stat>
        <Stat label="Waiting">{count('waiting').toString()}</Stat>
        <Stat label="Subagents running">{subagents.toString()}</Stat>
        <Stat label="Spend per hour">{formatCost(state.spendPerHourUsd)}</Stat>
        <Stat label="5 hour limit">
          <Meter label="5 hour limit used" ratio={normalizeRatio(fiveHourPct)} />
        </Stat>
        {sevenDayPct === null ? null : (
          <Stat label="7 day limit">
            <Meter label="7 day limit used" ratio={normalizeRatio(sevenDayPct)} />
          </Stat>
        )}
        {resetsAt === null ? null : (
          <Stat label="Resets in">{formatDuration(Math.max(0, resetsAt - now))}</Stat>
        )}
      </dl>
    </header>
  );
}

export type PermissionChoice = 'allow' | 'deny';

export function PermissionBanner(props: {
  readonly requests: readonly PermissionRequest[];
  readonly sessions: readonly SessionSummary[];
  readonly onResolve: (request: PermissionRequest, choice: PermissionChoice) => void;
}): ReactElement {
  const { requests, sessions, onResolve } = props;
  const titleOf = (sessionId: string): string =>
    sessions.find((session) => session.id === sessionId)?.title ?? sessionId;
  const noun = requests.length === 1 ? 'permission' : 'permissions';
  return (
    <section className="banner" aria-label="Pending permissions">
      <strong>{`${requests.length.toString()} pending ${noun}`}</strong>
      <ul>
        {requests.map((request) => {
          const title = titleOf(request.sessionId);
          return (
            <li key={request.id}>
              <Badge label={request.toolName} tone="warning" />
              <span>{title}</span>
              <code>{truncate(formatValue(request.input), 80)}</code>
              <button
                type="button"
                className="primary"
                aria-label={`Allow ${request.toolName} for ${title}`}
                onClick={() => {
                  onResolve(request, 'allow');
                }}
              >
                Allow
              </button>
              <button
                type="button"
                aria-label={`Deny ${request.toolName} for ${title}`}
                onClick={() => {
                  onResolve(request, 'deny');
                }}
              >
                Deny
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
