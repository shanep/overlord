// Every connector a session could reach for: MCP servers, claude.ai
// connectors, Claude in Chrome and a headless Chrome, with whether each one
// works right now and a button for the ones Overlord can fix, plus a search
// of the public MCP registry to add more.

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
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
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

/** Problems first, so what needs attention is at the top. */
function statusRank(status: ConnectorStatus): number {
  return status === 'ok' ? 1 : 0;
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
      onClick={() => {
        post({ type: 'fixConnector', connectorId: props.connector.id });
      }}
    >
      {FIX_LABELS[fix]}
    </button>
  );
}

const COLUMNS: readonly Column<Connector>[] = [
  {
    id: 'name',
    header: 'Connector',
    cell: (row) => (
      <span title={row.target === '' ? undefined : row.target}>
        {row.name.replace(/^claude\.ai /u, '')}
      </span>
    ),
    sortValue: (row) => row.name,
  },
  {
    id: 'kind',
    header: 'Kind',
    cell: (row) => KIND_LABELS[row.kind],
    sortValue: (row) => KIND_LABELS[row.kind],
  },
  {
    id: 'status',
    header: 'Status',
    cell: (row): ReactElement => {
      const info = STATUS_INFO[row.status];
      return <Badge label={info.label} tone={info.tone} title={row.detail} />;
    },
    sortValue: (row) => statusRank(row.status),
  },
  { id: 'detail', header: 'Detail', cell: (row) => row.detail, wrap: true },
  { id: 'fix', header: 'Fix', cell: (row) => <FixButton connector={row} /> },
];

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

export function ConnectorsView(props: { readonly state: ConnectorsState }): ReactElement {
  const { state } = props;
  const post = usePostAction();
  const rows = state.connectors.toSorted(
    (left, right) => statusRank(left.status) - statusRank(right.status),
  );
  const problems = state.connectors.filter((connector) => connector.status !== 'ok').length;
  return (
    <section aria-labelledby="connectors-title">
      <header className="view-header">
        <h1 id="connectors-title">Connectors (MCP)</h1>
        <dl className="stats">
          <div className="stat">
            <dt>Ready</dt>
            <dd>{String(state.connectors.length - problems)}</dd>
          </div>
          <div className="stat">
            <dt>Need attention</dt>
            <dd>{String(problems)}</dd>
          </div>
        </dl>
      </header>
      <div className="toolbar">
        <button
          type="button"
          disabled={state.checking}
          onClick={() => {
            post({ type: 'recheckConnectors' });
          }}
        >
          Recheck
        </button>
        <LastChecked state={state} />
      </div>
      <p className="muted">
        MCP servers and claude.ai connectors as <code>claude mcp list</code> sees them
        {state.folder === null ? '' : ` from ${state.folder}`}, plus Claude in Chrome and a Chrome
        that can run headless. Each new session is told what is ready and asked to check the
        connectors its task needs before it starts, so a missing one stops it at the start instead
        of halfway through. Overlord checks again every ten minutes.
      </p>
      <DataTable
        caption="Connectors"
        columns={COLUMNS}
        rows={rows}
        rowKey={(row) => row.id}
        empty={state.checking ? 'Checking…' : 'No connectors found.'}
      />
      <RegistrySection registry={state.registry} />
    </section>
  );
}
