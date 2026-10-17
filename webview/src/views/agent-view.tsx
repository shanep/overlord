// Agent detail: header and actions, why it failed and links to failed
// subagents, charts, the subagents as cards, and the live feed.

import type { ReactElement } from 'react';
import { Fragment } from 'react';

import type { AgentNode } from '../../../src/shared/model.js';
import type { AgentDetailState } from '../../../src/shared/protocol.js';
import { useAgent } from '../agents.js';
import { useNow } from '../clock.js';
import { StateBadge } from '../components/badge.js';
import { Card, CardGrid, Notice } from '../components/card.js';
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

/** Links straight to every failed subagent below this agent, so none needs hunting for. */
function FailedAgents(props: { readonly agents: readonly AgentNode[] }): ReactElement | null {
  const post = usePostAction();
  const count = props.agents.length;
  if (count === 0) {
    return null;
  }
  return (
    <Notice ok={false}>
      {count === 1 ? 'A subagent failed: ' : `${String(count)} subagents failed: `}
      {props.agents.map((failed, index) => (
        <Fragment key={failed.id}>
          {index === 0 ? null : ', '}
          <button
            type="button"
            className="link-button"
            title={`Open ${failed.agentType}: ${failed.description}`}
            onClick={() => {
              post({ type: 'openAgent', sessionId: failed.sessionId, agentId: failed.id });
            }}
          >
            {failed.description}
          </button>
        </Fragment>
      ))}
    </Notice>
  );
}

export function AgentView(props: { readonly state: AgentDetailState }): ReactElement {
  const {
    agent,
    session,
    children,
    failedAgents,
    failure,
    feed,
    toolCalls,
    requests,
    compactions,
  } = props.state;
  const info = useAgent(session?.agent);
  if (agent === null) {
    return <EmptyState title="No agent selected" detail="Open an agent from the fleet view." />;
  }
  return (
    <section aria-label="Agent">
      <AgentHeader agent={agent} session={session} requests={requests} info={info} />
      {agent.state === 'failed' ? (
        <Notice ok={false}>
          This agent failed. {failure ?? 'No error text came back from it.'}
        </Notice>
      ) : null}
      <FailedAgents agents={failedAgents} />
      {info.capabilities.subagents ? (
        <section className="section" aria-labelledby="agent-children">
          <h2 id="agent-children" className="section-title">
            Subagents <span className="count">{String(children.length)}</span>
          </h2>
          <AgentChildren agents={children} />
        </section>
      ) : null}
      <section className="section" aria-labelledby="agent-charts">
        <h2 id="agent-charts" className="section-title">
          Activity
        </h2>
        <AgentCharts
          toolCalls={toolCalls}
          requests={requests}
          compactions={compactions}
          model={agent.model}
          agent={info.id}
          cacheReads={info.capabilities.cacheReads}
        />
      </section>
      <section className="section" aria-labelledby="agent-feed">
        <h2 id="agent-feed" className="section-title">
          Feed <span className="count">{String(feed.length)}</span>
        </h2>
        <AgentFeed feed={feed} agentName={info.short} />
      </section>
    </section>
  );
}
