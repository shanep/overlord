// Agent detail: header and actions, charts, the subagents as cards, and the
// live feed.

import type { ReactElement } from 'react';

import type { AgentNode } from '../../../src/shared/model.js';
import type { AgentDetailState } from '../../../src/shared/protocol.js';
import { useNow } from '../clock.js';
import { StateBadge } from '../components/badge.js';
import { Card, CardGrid } from '../components/card.js';
import { EmptyState } from '../components/empty-state.js';
import { formatDuration } from '../format.js';
import { STATE_INFO } from '../labels.js';
import { usePostAction } from '../vscode-context.js';

import { AgentCharts } from './agent-charts.js';
import { AgentFeed } from './agent-feed.js';
import { AgentHeader } from './agent-header.js';

function ChildCard(props: { readonly child: AgentNode }): ReactElement {
  const post = usePostAction();
  const now = useNow();
  const { child } = props;
  const calls =
    child.toolCallCount === 1 ? '1 tool call' : `${String(child.toolCallCount)} tool calls`;
  return (
    <Card tone={STATE_INFO[child.state].tone} action>
      <div className="card-head">
        <span className="chip">{child.agentType}</span>
        <span className="spacer" />
        <StateBadge state={child.state} />
      </div>
      <button
        type="button"
        className="link-button agent-child-name"
        aria-label={`${child.agentType}: ${child.description}`}
        title={child.description}
        onClick={() => {
          post({ type: 'openAgent', sessionId: child.sessionId, agentId: child.id });
        }}
      >
        {child.description}
      </button>
      <div className="card-sub">
        {child.model ?? 'unknown model'}, {calls},{' '}
        {formatDuration((child.endedAt ?? now) - child.startedAt)}
        {child.background ? ', in the background' : ''}
      </div>
    </Card>
  );
}

function AgentChildren(props: { readonly agents: readonly AgentNode[] }): ReactElement {
  if (props.agents.length === 0) {
    return <p className="muted">No subagents.</p>;
  }
  return (
    <CardGrid label="Subagents">
      {props.agents.map((child) => (
        <ChildCard key={child.id} child={child} />
      ))}
    </CardGrid>
  );
}

export function AgentView(props: { readonly state: AgentDetailState }): ReactElement {
  const { agent, session, children, feed, toolCalls, requests, compactions } = props.state;
  if (agent === null) {
    return <EmptyState title="No agent selected" detail="Open an agent from the fleet view." />;
  }
  return (
    <section aria-label="Agent">
      <AgentHeader agent={agent} session={session} requests={requests} />
      <section className="section" aria-labelledby="agent-children">
        <h2 id="agent-children" className="section-title">
          Subagents <span className="count">{String(children.length)}</span>
        </h2>
        <AgentChildren agents={children} />
      </section>
      <section className="section" aria-labelledby="agent-charts">
        <h2 id="agent-charts" className="section-title">
          Activity
        </h2>
        <AgentCharts
          toolCalls={toolCalls}
          requests={requests}
          compactions={compactions}
          model={agent.model}
        />
      </section>
      <section className="section" aria-labelledby="agent-feed">
        <h2 id="agent-feed" className="section-title">
          Feed <span className="count">{String(feed.length)}</span>
        </h2>
        <AgentFeed feed={feed} />
      </section>
    </section>
  );
}
