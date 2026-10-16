// Agent detail: header and actions, charts, the live feed, and children.

import type { ReactElement } from 'react';

import type { AgentNode } from '../../../src/shared/model.js';
import type { AgentDetailState } from '../../../src/shared/protocol.js';
import { StateBadge } from '../components/badge.js';
import { EmptyState } from '../components/empty-state.js';
import { usePostAction } from '../vscode-context.js';

import { AgentCharts } from './agent-charts.js';
import { AgentFeed } from './agent-feed.js';
import { AgentHeader } from './agent-header.js';

function AgentChildren(props: { readonly agents: readonly AgentNode[] }): ReactElement {
  const post = usePostAction();
  if (props.agents.length === 0) {
    return <p className="muted">No subagents.</p>;
  }
  return (
    <ul className="legend" aria-label="Subagents">
      {props.agents.map((child) => (
        <li key={child.id}>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              post({ type: 'openAgent', sessionId: child.sessionId, agentId: child.id });
            }}
          >
            {child.agentType}: {child.description}
          </button>{' '}
          <StateBadge state={child.state} />
        </li>
      ))}
    </ul>
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
      <section className="section" aria-labelledby="agent-charts">
        <h2 id="agent-charts">Activity</h2>
        <AgentCharts
          toolCalls={toolCalls}
          requests={requests}
          compactions={compactions}
          model={agent.model}
        />
      </section>
      <section className="section" aria-labelledby="agent-children">
        <h2 id="agent-children">Subagents</h2>
        <AgentChildren agents={children} />
      </section>
      <section className="section" aria-labelledby="agent-feed">
        <h2 id="agent-feed">Feed</h2>
        <AgentFeed feed={feed} />
      </section>
    </section>
  );
}
