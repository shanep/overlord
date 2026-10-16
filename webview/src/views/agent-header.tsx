// Agent detail header: who this agent is, what it has used, and the
// session actions. Interrupt and stop confirm inline before posting.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { AgentNode, ApiRequest, SessionSummary } from '../../../src/shared/model.js';
import { useNow } from '../clock.js';
import { StateBadge } from '../components/badge.js';
import { ConfirmBar } from '../components/confirm-bar.js';
import { formatCompact, formatCost, formatDuration } from '../format.js';
import { totalTokens } from '../metrics.js';
import { usePostAction } from '../vscode-context.js';

/** Sum of known request costs, or null when no request has a cost. */
export function costFromRequests(requests: readonly ApiRequest[]): number | null {
  const known = requests.flatMap((request) => (request.costUsd === null ? [] : [request.costUsd]));
  return known.length === 0 ? null : known.reduce((sum, cost) => sum + cost, 0);
}

/** The main thread uses the session cost; a subagent sums its own requests. */
export function agentCost(
  agent: AgentNode,
  session: SessionSummary | null,
  requests: readonly ApiRequest[],
): number | null {
  if (agent.parentAgentId === null && session !== null) {
    return session.costUsd;
  }
  return costFromRequests(requests);
}

type PendingAction = 'interrupt' | 'stop';

const CONFIRM: Readonly<Record<PendingAction, { message: string; label: string }>> = {
  interrupt: { message: 'Interrupt this session?', label: 'Interrupt' },
  stop: { message: 'Stop this session?', label: 'Stop' },
};

export function AgentHeader(props: {
  readonly agent: AgentNode;
  readonly session: SessionSummary | null;
  readonly requests: readonly ApiRequest[];
}): ReactElement {
  const { agent, session, requests } = props;
  const now = useNow();
  const post = usePostAction();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const parent = agent.parentAgentId;
  return (
    <header>
      <div className="view-header">
        <h1>
          {agent.agentType}: {agent.description}
        </h1>
        <StateBadge state={agent.state} />
      </div>
      {session === null ? null : (
        <p className="muted">
          {session.title} <span className="mono">{session.cwd}</span>
        </p>
      )}
      <dl className="stats">
        <div className="stat">
          <dt>Model</dt>
          <dd>{agent.model ?? 'unknown'}</dd>
        </div>
        <div className="stat">
          <dt>Elapsed</dt>
          <dd>{formatDuration((agent.endedAt ?? now) - agent.startedAt)}</dd>
        </div>
        <div className="stat">
          <dt>Tokens</dt>
          <dd>{formatCompact(totalTokens(agent.usage))}</dd>
        </div>
        <div className="stat">
          <dt>Cost</dt>
          <dd>{formatCost(agentCost(agent, session, requests))}</dd>
        </div>
        <div className="stat">
          <dt>Tool calls</dt>
          <dd>{agent.toolCallCount}</dd>
        </div>
      </dl>
      <div className="toolbar">
        <button
          type="button"
          onClick={() => {
            post({ type: 'openContext', sessionId: agent.sessionId, agentId: agent.id });
          }}
        >
          Context
        </button>
        {parent === null ? null : (
          <button
            type="button"
            onClick={() => {
              post({ type: 'openAgent', sessionId: agent.sessionId, agentId: parent });
            }}
          >
            Open parent
          </button>
        )}
        <span className="spacer" />
        <button
          type="button"
          onClick={() => {
            setPending('interrupt');
          }}
        >
          Interrupt
        </button>
        <button
          type="button"
          onClick={() => {
            setPending('stop');
          }}
        >
          Stop
        </button>
      </div>
      {pending === null ? null : (
        <ConfirmBar
          message={CONFIRM[pending].message}
          confirmLabel={CONFIRM[pending].label}
          onConfirm={() => {
            post({ type: pending, sessionId: agent.sessionId });
            setPending(null);
          }}
          onCancel={() => {
            setPending(null);
          }}
        />
      )}
    </header>
  );
}
