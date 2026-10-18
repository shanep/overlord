// One list of sessions across every surface, grouped by project folder, with
// the handoffs each one supports right now. Each group is a table in a panel,
// with fixed columns so the groups line up.

import type { ReactElement } from 'react';

import type { Surface } from '../../../src/shared/model.js';
import type { HandoffKind, SessionsState, SurfaceSession } from '../../../src/shared/protocol.js';
import { knowsClaude, useAgent, useAgents } from '../agents.js';
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

/**
 * The surfaces worth offering in the filter: those with at least one
 * session, plus the one chosen now so a saved choice still shows.
 */
export function surfaceOptions(
  sessions: readonly SurfaceSession[],
  chosen: Surface | 'all',
): readonly Surface[] {
  const present = new Set(sessions.map((entry) => entry.surface));
  return SURFACES.filter((entry) => present.has(entry) || entry === chosen);
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
    return <span title={entry.title}>{entry.title}</span>;
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

/** A running session opens where it runs, since continuing it would start a second copy. */
function OpenButton(props: { readonly entry: SurfaceSession }): ReactElement {
  const post = usePostAction();
  const { entry } = props;
  return (
    <span className="actions">
      <button
        type="button"
        className="primary"
        aria-label={`Open: ${entry.title}`}
        data-tip="Open: Go to this session where it runs in Overlord"
        onClick={() => {
          post({ type: 'openSession', sessionId: entry.id });
        }}
      >
        Open
      </button>
    </span>
  );
}

function HandoffButtons(props: {
  readonly entry: SurfaceSession;
  readonly active: boolean;
}): ReactElement {
  const post = usePostAction();
  const { entry } = props;
  // Only the handoffs the session's agent offers, whatever the surface reports.
  const offered = useAgent(entry.agent).capabilities.handoffs;
  if (props.active) {
    return <OpenButton entry={entry} />;
  }
  const handoffs = entry.handoffs.filter((kind) => offered.includes(kind));
  if (handoffs.length === 0) {
    return <span className="muted">none</span>;
  }
  return (
    <span className="actions">
      {handoffs.map((kind) => (
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

function columns(now: number, active: ReadonlySet<string>): readonly Column<SurfaceSession>[] {
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
          {active.has(entry.id) ? (
            <>
              {' '}
              <Badge label="active" tone="good" title="Running now" />
            </>
          ) : null}
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
    {
      id: 'handoff',
      header: 'Handoff',
      cell: (entry) => <HandoffButtons entry={entry} active={active.has(entry.id)} />,
    },
  ];
}

interface FilterControls {
  readonly filter: SessionFilter;
  readonly setText: (text: string) => void;
  readonly setSurface: (surface: Surface | 'all') => void;
  readonly setArchived: (archived: boolean) => void;
}

function Filters(props: {
  readonly sessions: readonly SurfaceSession[];
  readonly controls: FilterControls;
}): ReactElement {
  const { filter, setText, setSurface, setArchived } = props.controls;
  const { text, surface, archived } = filter;
  return (
    <div className="list-bar" role="search">
      <input
        type="search"
        className="sessions-filter"
        aria-label="Filter"
        placeholder="Filter by title or folder"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
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
          {surfaceOptions(props.sessions, surface).map((entry) => (
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
  );
}

function GroupPanel(props: {
  readonly group: ProjectGroup;
  readonly now: number;
  readonly active: ReadonlySet<string>;
}): ReactElement {
  const { group } = props;
  return (
    <details open className="panel session-group">
      <summary>
        <span className="group-name">{group.name}</span>
        <span className="count">{group.sessions.length.toString()}</span>
        {group.cwd === null ? null : <span className="muted mono">{group.cwd}</span>}
      </summary>
      <DataTable
        caption={`Sessions in ${group.cwd ?? 'no folder'}`}
        columns={columns(props.now, props.active)}
        rows={group.sessions}
        rowKey={(entry) => `${entry.surface}:${entry.id}`}
      />
    </details>
  );
}

export function SessionsView(props: { readonly state: SessionsState }): ReactElement {
  const { state } = props;
  const now = useNow();
  const post = usePostAction();
  const [text, setText] = usePersistentState('sessions.text', '', isString);
  const [surface, setSurface] = usePersistentState('sessions.surface', 'all', isSurfaceFilter);
  const [archived, setArchived] = usePersistentState('sessions.archived', false, isBoolean);
  const filter = { text, surface, archived };
  const claudeAi = knowsClaude(useAgents());
  const rows = filterSessions(state.sessions, filter);
  const groups = groupByProject(rows, state.projects);
  const active = new Set(state.active);
  return (
    <section aria-labelledby="sessions-title">
      <header className="view-header">
        <h1 id="sessions-title">All sessions</h1>
        <span className="muted">
          {rows.length.toString()} of {state.sessions.length.toString()}
        </span>
        <span className="spacer" />
        {claudeAi ? (
          <>
            <span className="muted">
              claude.ai import:{' '}
              {state.claudeAiImportedAt === null
                ? 'never'
                : formatAgo(state.claudeAiImportedAt, now)}
            </span>
            <button
              type="button"
              onClick={() => {
                post({ type: 'importClaudeAi' });
              }}
            >
              Import claude.ai export
            </button>
          </>
        ) : null}
      </header>
      <Filters sessions={state.sessions} controls={{ filter, setText, setSurface, setArchived }} />
      {groups.length === 0 ? <p className="empty-line muted">No sessions match.</p> : null}
      {groups.map((group) => (
        <GroupPanel key={group.cwd ?? ''} group={group} now={now} active={active} />
      ))}
    </section>
  );
}
