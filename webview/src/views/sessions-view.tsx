// One list of sessions across every surface, with the handoffs each one
// supports right now.

import type { ReactElement } from 'react';

import type { Surface } from '../../../src/shared/model.js';
import type { HandoffKind, SessionsState, SurfaceSession } from '../../../src/shared/protocol.js';
import { useNow } from '../clock.js';
import { Badge, SurfaceBadge } from '../components/badge.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { formatAgo } from '../format.js';
import { isBoolean, isString } from '../guards.js';
import { isSurface, SURFACE_LABELS, SURFACES } from '../labels.js';
import { usePersistentState, usePostAction } from '../vscode-context.js';

export const HANDOFF_LABELS: Readonly<Record<HandoffKind, string>> = {
  'resume-local': 'Resume',
  'open-desktop': 'Open in Desktop',
  'teleport-local': 'Pull to local',
  'start-cloud': 'Start in cloud',
  'remote-control': 'Remote control',
};

export interface SessionFilter {
  readonly text: string;
  readonly surface: Surface | 'all';
  readonly archived: boolean;
}

function isSurfaceFilter(value: unknown): value is Surface | 'all' {
  return value === 'all' || isSurface(value);
}

/** Sessions that match the filter, newest first. */
export function filterSessions(
  sessions: readonly SurfaceSession[],
  filter: SessionFilter,
): readonly SurfaceSession[] {
  const needle = filter.text.trim().toLowerCase();
  return sessions
    .filter((entry) => filter.archived || !entry.archived)
    .filter((entry) => filter.surface === 'all' || entry.surface === filter.surface)
    .filter(
      (entry) =>
        needle === '' ||
        entry.title.toLowerCase().includes(needle) ||
        (entry.cwd ?? '').toLowerCase().includes(needle),
    )
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

function HandoffButtons(props: { readonly entry: SurfaceSession }): ReactElement {
  const post = usePostAction();
  const { entry } = props;
  if (entry.handoffs.length === 0) {
    return <span className="muted">none</span>;
  }
  return (
    <span className="actions">
      {entry.handoffs.map((kind) => (
        <button
          key={kind}
          type="button"
          aria-label={`${HANDOFF_LABELS[kind]}: ${entry.title}`}
          onClick={() => {
            post({ type: 'handoff', sessionId: entry.id, kind });
          }}
        >
          {HANDOFF_LABELS[kind]}
        </button>
      ))}
    </span>
  );
}

function columns(now: number): readonly Column<SurfaceSession>[] {
  return [
    {
      id: 'surface',
      header: 'Surface',
      cell: (entry) => <SurfaceBadge surface={entry.surface} />,
      sortValue: (entry) => SURFACE_LABELS[entry.surface],
    },
    {
      id: 'title',
      header: 'Title',
      cell: (entry) => (
        <>
          {entry.title}
          {entry.archived ? (
            <>
              {' '}
              <Badge label="archived" />
            </>
          ) : null}
        </>
      ),
      sortValue: (entry) => entry.title.toLowerCase(),
    },
    {
      id: 'cwd',
      header: 'Folder',
      cell: (entry) => entry.cwd ?? <span className="muted">none</span>,
      sortValue: (entry) => entry.cwd ?? '',
    },
    {
      id: 'updated',
      header: 'Updated',
      cell: (entry) => formatAgo(entry.updatedAt, now),
      sortValue: (entry) => entry.updatedAt,
    },
    { id: 'handoff', header: 'Handoff', cell: (entry) => <HandoffButtons entry={entry} /> },
  ];
}

export function SessionsView(props: { readonly state: SessionsState }): ReactElement {
  const { state } = props;
  const now = useNow();
  const post = usePostAction();
  const [text, setText] = usePersistentState('sessions.text', '', isString);
  const [surface, setSurface] = usePersistentState('sessions.surface', 'all', isSurfaceFilter);
  const [archived, setArchived] = usePersistentState('sessions.archived', false, isBoolean);
  const rows = filterSessions(state.sessions, { text, surface, archived });
  return (
    <section aria-labelledby="sessions-title">
      <header className="view-header">
        <h1 id="sessions-title">All sessions</h1>
        <span className="muted">
          {rows.length.toString()} of {state.sessions.length.toString()}
        </span>
        <span className="spacer" />
        <span className="muted">
          claude.ai import:{' '}
          {state.claudeAiImportedAt === null ? 'never' : formatAgo(state.claudeAiImportedAt, now)}
        </span>
        <button
          type="button"
          onClick={() => {
            post({ type: 'importClaudeAi' });
          }}
        >
          Import claude.ai export
        </button>
      </header>
      <div className="toolbar" role="search">
        <label>
          Filter
          <input
            type="search"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </label>
        <label>
          Surface
          <select
            value={surface}
            onChange={(event) => {
              const next = event.target.value;
              setSurface(isSurfaceFilter(next) ? next : 'all');
            }}
          >
            <option value="all">All</option>
            {SURFACES.map((entry) => (
              <option key={entry} value={entry}>
                {SURFACE_LABELS[entry]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => {
              setArchived(event.target.checked);
            }}
          />
          Show archived
        </label>
      </div>
      <DataTable
        caption="Sessions"
        columns={columns(now)}
        rows={rows}
        rowKey={(entry) => `${entry.surface}:${entry.id}`}
        empty="No sessions match."
      />
    </section>
  );
}
