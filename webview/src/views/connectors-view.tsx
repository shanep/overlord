// Every connector a session could reach for: each agent's MCP servers,
// claude.ai connectors, Claude in Chrome and a headless Chrome, as cards with
// whether each one works right now and a button for the ones Overlord can fix,
// plus a place to discover more in the public MCP registry.

import type { ReactElement } from 'react';

import { CLAUDE_CODE } from '../../../src/shared/agents.js';
import type {
  Connector,
  ConnectorFix,
  ConnectorKind,
  ConnectorStatus,
  ConnectorsState,
} from '../../../src/shared/connectors.js';
import { connectorAgent } from '../../../src/shared/connectors.js';
import { findAgent, showsAgent, useAgents } from '../agents.js';
import { useNow } from '../clock.js';
import { Badge } from '../components/badge.js';
import { Card, CardGroup, StatusDot } from '../components/card.js';
import { formatAgo, formatDateTime } from '../format.js';
import type { Tone } from '../labels.js';
import { usePostAction } from '../vscode-context.js';

import { RegistrySection } from './connectors-registry.js';

export const STATUS_INFO: Readonly<Record<ConnectorStatus, { label: string; tone: Tone }>> = {
  ok: { label: 'Ready', tone: 'good' },
  'needs-auth': { label: 'Needs sign in', tone: 'warning' },
  failed: { label: 'Failed', tone: 'critical' },
  pending: { label: 'Needs approval', tone: 'warning' },
  disabled: { label: 'Disabled', tone: 'neutral' },
  missing: { label: 'Not available', tone: 'critical' },
  unknown: { label: 'Unknown', tone: 'neutral' },
  unchecked: { label: 'Not checked', tone: 'neutral' },
};

export const KIND_LABELS: Readonly<Record<ConnectorKind, string>> = {
  'claude.ai': 'claude.ai connector',
  mcp: 'MCP server',
  chrome: 'Browser',
  headless: 'Browser',
};

const FIX_LABELS: Readonly<Record<ConnectorFix, string>> = {
  'sign-in': 'Sign in',
  'open-chrome': 'Open Chrome',
};

function displayName(connector: Connector): string {
  return connector.name.replace(/^claude\.ai /u, '');
}

function byName(left: Connector, right: Connector): number {
  return displayName(left).localeCompare(displayName(right));
}

function FixButton(props: { readonly connector: Connector }): ReactElement | null {
  const post = usePostAction();
  const { fix } = props.connector;
  if (fix === null) {
    return null;
  }
  return (
    <button
      type="button"
      className="primary"
      onClick={() => {
        post({ type: 'fixConnector', connectorId: props.connector.id });
      }}
    >
      {FIX_LABELS[fix]}
    </button>
  );
}

/** The kind, with the agent's name once more than one agent has rows. */
function KindLine(props: {
  readonly connector: Connector;
  readonly listed: readonly string[];
}): ReactElement {
  const agents = useAgents();
  const { connector } = props;
  const owner = connectorAgent(connector);
  const kind = KIND_LABELS[connector.kind];
  const text =
    owner === null || !showsAgent(owner, props.listed)
      ? kind
      : `${kind} · ${findAgent(agents, owner).short}`;
  return <div className="card-sub conn-indent">{text}</div>;
}

function ConnectorCard(props: {
  readonly connector: Connector;
  readonly listed: readonly string[];
}): ReactElement {
  const { connector } = props;
  const info = STATUS_INFO[connector.status];
  return (
    <Card tone={info.tone}>
      <div className="card-head">
        <StatusDot tone={info.tone} />
        <span className="card-title" title={connector.target === '' ? undefined : connector.target}>
          {displayName(connector)}
        </span>
        {connector.status === 'ok' ? null : <Badge label={info.label} tone={info.tone} />}
      </div>
      <KindLine connector={connector} listed={props.listed} />
      <p className="card-text conn-indent">{connector.detail}</p>
      {connector.fix === null ? null : (
        <div className="card-foot">
          <span className="spacer" />
          <FixButton connector={connector} />
        </div>
      )}
    </Card>
  );
}

function ConnectorGroup(props: {
  readonly id: string;
  readonly title: string;
  readonly connectors: readonly Connector[];
  /** Every agent with a row, so a card names its agent once there is more than one. */
  readonly listed: readonly string[];
}): ReactElement | null {
  return (
    <CardGroup id={props.id} title={props.title} count={props.connectors.length}>
      {props.connectors.map((connector) => (
        <ConnectorCard key={connector.id} connector={connector} listed={props.listed} />
      ))}
    </CardGroup>
  );
}

function LastChecked(props: { readonly state: ConnectorsState }): ReactElement {
  const now = useNow();
  const { checkedAt, checking } = props.state;
  if (checking) {
    return <span className="muted">Checking every connector. This takes a few seconds.</span>;
  }
  if (checkedAt === null) {
    return <span className="muted">Not checked yet.</span>;
  }
  return (
    <span className="muted">
      Last checked{' '}
      <time dateTime={new Date(checkedAt).toISOString()} title={formatDateTime(checkedAt)}>
        {formatAgo(checkedAt, now)}
      </time>
    </span>
  );
}

function About(props: {
  readonly folder: string | null;
  readonly others: readonly string[];
}): ReactElement {
  return (
    <details className="about">
      <summary>How this works</summary>
      <p>
        These are the MCP servers and claude.ai connectors as <code>claude mcp list</code> sees them
        {props.folder === null ? '' : ` from ${props.folder}`}, plus Claude in Chrome and a Chrome
        that can run headless.
        {props.others.length === 0
          ? ''
          : ` ${props.others.join(' and ')} servers come from their own config files, and their CLIs do not say whether a server connects.`}{' '}
        Each new session is told what is ready and asked to check the connectors its task needs
        before it starts, so a missing one stops it at the start instead of halfway through.
        Overlord checks again every ten minutes.
      </p>
    </details>
  );
}

export function ConnectorsView(props: { readonly state: ConnectorsState }): ReactElement {
  const { state } = props;
  const post = usePostAction();
  const agents = useAgents();
  const problems = state.connectors.filter(
    (connector) => connector.status !== 'ok' && connector.status !== 'unchecked',
  );
  const ready = state.connectors.filter((connector) => connector.status === 'ok');
  const unchecked = state.connectors.filter((connector) => connector.status === 'unchecked');
  const listed = state.connectors.flatMap((connector) => connectorAgent(connector) ?? []);
  const others = [...new Set(listed)]
    .filter((id) => id !== CLAUDE_CODE)
    .map((id) => findAgent(agents, id).short);
  return (
    <section className="conn" aria-labelledby="connectors-title">
      <header className="view-header">
        <h1 id="connectors-title">Connectors (MCP)</h1>
        <dl className="stats">
          <div className="stat">
            <dt>Ready</dt>
            <dd>{String(ready.length)}</dd>
          </div>
          <div className="stat">
            <dt>Need attention</dt>
            <dd>{String(problems.length)}</dd>
          </div>
        </dl>
        <span className="spacer" />
        <LastChecked state={state} />
        <button
          type="button"
          disabled={state.checking}
          onClick={() => {
            post({ type: 'recheckConnectors' });
          }}
        >
          Recheck
        </button>
      </header>
      <About folder={state.folder} others={others} />
      {state.connectors.length === 0 ? (
        <p className="empty-line muted">{state.checking ? 'Checking…' : 'No connectors found.'}</p>
      ) : null}
      <ConnectorGroup
        id="conn-attention"
        title="Needs attention"
        connectors={problems.toSorted(byName)}
        listed={listed}
      />
      <ConnectorGroup
        id="conn-ready"
        title="Ready"
        connectors={ready.toSorted(byName)}
        listed={listed}
      />
      <ConnectorGroup
        id="conn-unchecked"
        title="Set up, not checked"
        connectors={unchecked.toSorted(byName)}
        listed={listed}
      />
      <RegistrySection registry={state.registry} mcpAgents={state.mcpAgents} />
    </section>
  );
}
