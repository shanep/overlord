// Properties panel beside a Claude CLI tab: what the session is working on,
// the facts about it grouped like an IDE property sheet, and its subagents.

import type { ReactElement } from 'react';

import type { SessionHealth } from '../../../src/shared/health.js';
import type { AgentNode, PermissionRequest, SessionSummary } from '../../../src/shared/model.js';
import type { PropertiesState } from '../../../src/shared/protocol.js';
import { useNow } from '../clock.js';
import { StateBadge, SurfaceBadge } from '../components/badge.js';
import { EmptyState } from '../components/empty-state.js';
import { formatAgo, formatCompact, formatCost, formatDateTime } from '../format.js';
import { totalTokens } from '../metrics.js';
import { usePostAction } from '../vscode-context.js';

import { HealthSection } from './properties-health.js';
import type { Row } from './props-group.js';
import { Group } from './props-group.js';

function orUnknown(value: string | number | null): string {
  return value === null ? 'unknown' : String(value);
}

function sessionRows(session: SessionSummary, now: number): readonly Row[] {
  return [
    [
      'Id',
      <span key="id" className="mono">
        {session.id}
      </span>,
    ],
    ['Surface', <SurfaceBadge key="surface" surface={session.surface} />],
    ['Started', formatDateTime(session.startedAt)],
    ['Last activity', formatAgo(session.updatedAt, now)],
    ['Claude Code', orUnknown(session.version)],
    ['Process', orUnknown(session.pid)],
  ];
}

function workspaceRows(session: SessionSummary): readonly Row[] {
  return [
    [
      'Folder',
      <span key="folder" className="mono">
        {session.cwd}
      </span>,
    ],
    ['Branch', orUnknown(session.gitBranch)],
  ];
}

function modelRows(session: SessionSummary): readonly Row[] {
  return [
    ['Model', orUnknown(session.model)],
    ['Effort', orUnknown(session.effort)],
    ['Permissions', orUnknown(session.permissionMode)],
  ];
}

function usageRows(session: SessionSummary): readonly Row[] {
  const { usage } = session;
  return [
    ['Tokens', formatCompact(totalTokens(usage))],
    ['Input', formatCompact(usage.input)],
    ['Output', formatCompact(usage.output)],
    ['Cache read', formatCompact(usage.cacheRead)],
    ['Cache write', formatCompact(usage.cacheCreation)],
    ['Cost', formatCost(session.costUsd)],
  ];
}

/**
 * Claude Code's own recap of the session and the last thing asked of it, so
 * the user can tell what a tab is doing without reading back through it.
 */
function WorkingOn(props: {
  readonly session: SessionSummary;
  readonly now: number;
}): ReactElement | null {
  const { recap, lastPrompt } = props.session;
  if (recap === null && lastPrompt === null) {
    return null;
  }
  return (
    <section className="props-group" aria-label="Working on">
      <h2>Working on</h2>
      {recap === null ? null : (
        <>
          <p className="props-recap">{recap.text}</p>
          <p className="muted props-recap-age">Recap {formatAgo(recap.at, props.now)}</p>
        </>
      )}
      {lastPrompt === null ? null : (
        <dl className="props">
          <div className="prop">
            <dt>Last prompt</dt>
            <dd>{lastPrompt}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}

function Waiting(props: {
  readonly requests: readonly PermissionRequest[];
  readonly now: number;
}): ReactElement | null {
  if (props.requests.length === 0) {
    return null;
  }
  return (
    <Group
      title="Waiting on you"
      rows={props.requests.map((request) => [
        request.toolName,
        `asked ${formatAgo(request.requestedAt, props.now)}`,
      ])}
    />
  );
}

function Subagents(props: {
  readonly sessionId: string;
  readonly agents: readonly AgentNode[];
}): ReactElement {
  const post = usePostAction();
  return (
    <section className="props-group" aria-label="Subagents">
      <h2>Subagents</h2>
      {props.agents.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ul className="props-list">
          {props.agents.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  post({ type: 'openAgent', sessionId: props.sessionId, agentId: agent.id });
                }}
              >
                {agent.agentType}: {agent.description}
              </button>{' '}
              <StateBadge state={agent.state} />
              {agent.currentTool === null ? null : (
                <span className="muted"> {agent.currentTool}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SessionProperties(props: {
  readonly session: SessionSummary;
  readonly agents: readonly AgentNode[];
  readonly pending: readonly PermissionRequest[];
  readonly health: SessionHealth | null;
}): ReactElement {
  const { session } = props;
  const now = useNow();
  const post = usePostAction();
  return (
    <>
      <header>
        <div className="view-header">
          <h1>{session.title}</h1>
          <StateBadge state={session.state} />
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              post({ type: 'openAgent', sessionId: session.id, agentId: session.id });
            }}
          >
            Agent view
          </button>
          <button
            type="button"
            onClick={() => {
              post({ type: 'openContext', sessionId: session.id, agentId: null });
            }}
          >
            Context
          </button>
        </div>
      </header>
      <WorkingOn session={session} now={now} />
      <Waiting requests={props.pending} now={now} />
      {props.health === null ? null : <HealthSection health={props.health} />}
      <Group title="Session" rows={sessionRows(session, now)} />
      <Group title="Workspace" rows={workspaceRows(session)} />
      <Group title="Model" rows={modelRows(session)} />
      <Group title="Usage" rows={usageRows(session)} />
      <Subagents sessionId={session.id} agents={props.agents} />
    </>
  );
}

export function PropertiesView(props: { readonly state: PropertiesState }): ReactElement {
  const { sessionId, session, agents, pendingPermissions, health } = props.state;
  if (sessionId === null) {
    return (
      <EmptyState title="No Claude tab" detail="Focus a Claude Code tab to see its properties." />
    );
  }
  if (session === null) {
    return (
      <EmptyState
        title="Waiting for Claude Code"
        detail={`Session ${sessionId} shows up here once Claude Code reports it, usually after the first prompt.`}
      />
    );
  }
  return (
    <SessionProperties
      session={session}
      agents={agents}
      pending={pendingPermissions}
      health={health}
    />
  );
}
