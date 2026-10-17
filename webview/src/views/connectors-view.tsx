// Every connector a session could reach for: MCP servers, claude.ai
// connectors, Claude in Chrome and a headless Chrome, as cards with whether
// each one works right now and a button for the ones Overlord can fix, plus a
// place to discover more in the public MCP registry.

import type { ReactElement } from 'react';

import type {
  Connector,
  ConnectorFix,
  ConnectorKind,
  ConnectorStatus,
  ConnectorsState,
} from '../../../src/shared/connectors.js';
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

function ConnectorCard(props: { readonly connector: Connector }): ReactElement {
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
      <div className="card-sub conn-indent">{KIND_LABELS[connector.kind]}</div>
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
}): ReactElement | null {
  return (
    <CardGroup id={props.id} title={props.title} count={props.connectors.length}>
      {props.connectors.map((connector) => (
        <ConnectorCard key={connector.id} connector={connector} />
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

function About(props: { readonly folder: string | null }): ReactElement {
  return (
    <details className="about">
      <summary>How this works</summary>
      <p>
        These are the MCP servers and claude.ai connectors as <code>claude mcp list</code> sees them
        {props.folder === null ? '' : ` from ${props.folder}`}, plus Claude in Chrome and a Chrome
        that can run headless. Each new session is told what is ready and asked to check the
        connectors its task needs before it starts, so a missing one stops it at the start instead
        of halfway through. Overlord checks again every ten minutes.
      </p>
    </details>
  );
}

export function ConnectorsView(props: { readonly state: ConnectorsState }): ReactElement {
  const { state } = props;
  const post = usePostAction();
  const problems = state.connectors.filter((connector) => connector.status !== 'ok');
  const ready = state.connectors.filter((connector) => connector.status === 'ok');
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
      <About folder={state.folder} />
      {state.connectors.length === 0 ? (
        <p className="empty-line muted">{state.checking ? 'Checking…' : 'No connectors found.'}</p>
      ) : null}
      <ConnectorGroup
        id="conn-attention"
        title="Needs attention"
        connectors={problems.toSorted(byName)}
      />
      <ConnectorGroup id="conn-ready" title="Ready" connectors={ready.toSorted(byName)} />
      <RegistrySection registry={state.registry} />
    </section>
  );
}
