// One list of sessions across every surface, grouped by project folder, with
// the handoffs each one supports right now.

import type { ReactElement } from 'react';

import type { Surface } from '../../../src/shared/model.js';
import type { HandoffKind, SessionsState, SurfaceSession } from '../../../src/shared/protocol.js';
import { useNow } from '../clock.js';
import { Badge, SurfaceBadge } from '../components/badge.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { formatAgo } from '../format.js';
import { isBoolean, isString } from '../guards.js';
import { isSurface, LOCAL_SURFACES, SURFACE_LABELS, SURFACES } from '../labels.js';
import { usePersistentState, usePostAction } from '../vscode-context.js';

export const HANDOFF_LABELS: Readonly<Record<HandoffKind, string>> = {
  'resume-local': 'Continue',
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

export interface ProjectGroup {
  /** The session folder, null for sessions that have none (claude.ai, some cloud). */
  readonly cwd: string | null;
  readonly name: string;
  readonly sessions: readonly SurfaceSession[];
}

/** The last folder in a path, so "/Users/me/repos/app" reads as "app". */
export function projectName(cwd: string | null): string {
  if (cwd === null) {
    return 'No folder';
  }
  return cwd.split(/[\\/]/u).findLast((part) => part !== '') ?? cwd;
}

/**
 * Sessions grouped by folder, with worktree folders folded into the
 * repository they came from. Groups keep the order of their first session.
 */
export function groupByProject(
  sessions: readonly SurfaceSession[],
  projects: Readonly<Record<string, string>>,
): readonly ProjectGroup[] {
  const groups = new Map<string | null, SurfaceSession[]>();
  for (const entry of sessions) {
    const key = entry.cwd === null ? null : (projects[entry.cwd] ?? entry.cwd);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [entry]);
    } else {
      group.push(entry);
    }
  }
  return [...groups].map(([cwd, items]) => ({ cwd, name: projectName(cwd), sessions: items }));
}

function SessionTitle(props: { readonly entry: SurfaceSession }): ReactElement {
  const post = usePostAction();
  const { entry } = props;
  if (!LOCAL_SURFACES.has(entry.surface)) {
    return <>{entry.title}</>;
  }
  return (
    <button
      type="button"
      className="link-button"
      title="Open the agent view for this session"
      onClick={() => {
        post({ type: 'openAgent', sessionId: entry.id, agentId: entry.id });
      }}
    >
      {entry.title}
    </button>
  );
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
          className={kind === 'resume-local' ? 'primary' : undefined}
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
          <SessionTitle entry={entry} />
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
  const groups = groupByProject(rows, state.projects);
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
      {groups.length === 0 ? <p className="muted">No sessions match.</p> : null}
      {groups.map((group) => (
        <details key={group.cwd ?? ''} open className="section">
          <summary>
            <strong>{group.name}</strong>{' '}
            {group.cwd === null ? null : <span className="muted mono">{group.cwd}</span>} (
            {group.sessions.length.toString()})
          </summary>
          <DataTable
            caption={`Sessions in ${group.cwd ?? 'no folder'}`}
            columns={columns(now)}
            rows={group.sessions}
            rowKey={(entry) => `${entry.surface}:${entry.id}`}
          />
        </details>
      ))}
    </section>
  );
}
