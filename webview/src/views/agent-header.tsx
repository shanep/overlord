// Agent detail header: who this agent is, what it has used, and the
// session actions. Interrupt and stop confirm inline before posting.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { AgentNode, ApiRequest, SessionSummary } from '../../../src/shared/model.js';
import { useNow } from '../clock.js';
import { StateBadge } from '../components/badge.js';
import { StatTiles } from '../components/card.js';
import { ConfirmBar } from '../components/confirm-bar.js';
import { formatCompact, formatCost, formatDuration } from '../format.js';
import { LOCAL_SURFACES } from '../labels.js';
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
      <div className="agent-title">
        <span className="chip">{agent.agentType}</span>
        <h1 title={agent.description}>{agent.description}</h1>
        <StateBadge state={agent.state} />
      </div>
      {session === null ? null : (
        <p className="muted agent-where">
          {session.title === agent.description ? null : <>{session.title} </>}
          <span className="mono">{session.cwd}</span>
        </p>
      )}
      <StatTiles
        tiles={[
          { label: 'Model', value: agent.model ?? 'unknown' },
          { label: 'Elapsed', value: formatDuration((agent.endedAt ?? now) - agent.startedAt) },
          { label: 'Tokens', value: formatCompact(totalTokens(agent.usage)) },
          { label: 'Cost', value: formatCost(agentCost(agent, session, requests)) },
          { label: 'Tool calls', value: String(agent.toolCallCount) },
        ]}
      />
      <div className="toolbar agent-actions">
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
        {parent === null && session !== null && LOCAL_SURFACES.has(session.surface) ? (
          <button
            type="button"
            className="primary"
            title="Continue this session in Claude Code"
            onClick={() => {
              post({ type: 'handoff', sessionId: session.id, kind: 'resume-local' });
            }}
          >
            Continue
          </button>
        ) : null}
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
