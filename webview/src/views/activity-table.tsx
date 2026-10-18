// The sessions table in the activity view: one row per running session with
// totals for its whole process tree, and a twisty that opens the processes.

import type { ReactElement } from 'react';
import { Fragment } from 'react';

import type {
  ActivityLevel,
  ActivityProcess,
  ActivitySession,
  ProcessFlag,
  ProcessFlagKind,
  Rates,
} from '../../../src/shared/activity.js';
import { useAgent } from '../agents.js';
import { AgentMark, Badge, PlaceMarker } from '../components/badge.js';
import type { Column, SortState } from '../components/data-table.js';
import { ariaSort, nextSort, SortHeader, sortRows } from '../components/data-table.js';
import { formatBytes, formatInteger, formatRate } from '../format.js';
import { isRecord, isString, isStringArray } from '../guards.js';
import { usePersistentState, usePostAction } from '../vscode-context.js';

const FLAG_LABELS: Readonly<Record<ProcessFlagKind, string>> = {
  'cpu-hog': 'CPU hog',
  'memory-hog': 'Memory hog',
  'disk-hog': 'Disk hog',
  'network-hog': 'Network hog',
  starved: 'Starved',
  blocked: 'Blocked',
  stopped: 'Stopped',
  zombie: 'Zombie',
};

const STATE_LABELS: Readonly<Record<string, string>> = {
  R: 'Running',
  S: 'Sleeping',
  I: 'Idle',
  D: 'Waiting on I/O',
  U: 'Waiting on I/O',
  T: 'Stopped',
  t: 'Stopped',
  Z: 'Zombie',
};

/** The OS state letter in words. The full code, with its modifiers, shows on hover. */
export function stateLabel(state: string): string {
  return STATE_LABELS[state.charAt(0)] ?? state;
}

export function formatCpu(pct: number | null): string {
  return pct === null ? '...' : `${pct.toFixed(1)}%`;
}

/** Read and write rates as "1.2 MB/s / 0 B/s", or n/a when the platform cannot tell. */
export function formatRates(rates: Rates): string {
  if (rates.readPerSec === null) {
    return 'n/a';
  }
  return `${formatRate(rates.readPerSec)} / ${formatRate(rates.writePerSec)}`;
}

function rateSum(rates: Rates): number {
  return (rates.readPerSec ?? 0) + (rates.writePerSec ?? 0);
}

function worst(flags: readonly ProcessFlag[]): ActivityLevel | null {
  if (flags.some((flag) => flag.level === 'critical')) {
    return 'critical';
  }
  return flags.length > 0 ? 'warning' : null;
}

export function sessionFlags(session: ActivitySession): readonly ProcessFlag[] {
  return session.processes.flatMap((process) => process.flags);
}

function FlagBadges(props: { readonly flags: readonly ProcessFlag[] }): ReactElement {
  return (
    <>
      {props.flags.map((flag) => (
        <Badge
          key={flag.kind}
          label={FLAG_LABELS[flag.kind]}
          tone={flag.level}
          title={flag.detail}
        />
      ))}
    </>
  );
}

function FlagSummary(props: { readonly session: ActivitySession }): ReactElement {
  const flags = sessionFlags(props.session);
  const level = worst(flags);
  if (level === null) {
    return <span className="muted">None</span>;
  }
  const title = flags.map((flag) => `${FLAG_LABELS[flag.kind]}: ${flag.detail}`).join('\n');
  return <Badge label={formatInteger(flags.length)} tone={level} title={title} />;
}

function SessionTitle(props: { readonly session: ActivitySession }): ReactElement {
  const post = usePostAction();
  const { session } = props;
  return (
    <button
      type="button"
      className="link-button row-title"
      data-tip={`${session.cwd}\nOpen the agent view for this session`}
      onClick={() => {
        post({ type: 'openAgent', sessionId: session.sessionId, agentId: session.sessionId });
      }}
    >
      {session.title}
    </button>
  );
}

function SessionCell(props: { readonly session: ActivitySession }): ReactElement {
  const agent = useAgent(props.session.agent);
  const { session } = props;
  return (
    <>
      {session.place === null ? null : <PlaceMarker place={session.place} />}{' '}
      <AgentMark agent={agent} /> <SessionTitle session={session} />
    </>
  );
}

const SESSION_COLUMNS: readonly Column<ActivitySession>[] = [
  {
    id: 'title',
    header: 'Session',
    cell: (row) => <SessionCell session={row} />,
    sortValue: (row) => row.title.toLowerCase(),
  },
  {
    id: 'cpu',
    header: 'CPU',
    cell: (row) => formatCpu(row.cpuPct),
    sortValue: (row) => row.cpuPct ?? -1,
    numeric: true,
  },
  {
    id: 'memory',
    header: 'Memory',
    cell: (row) => formatBytes(row.memoryBytes),
    sortValue: (row) => row.memoryBytes,
    numeric: true,
  },
  {
    id: 'disk',
    header: 'Disk read / write',
    cell: (row) => formatRates(row.disk),
    sortValue: (row) => rateSum(row.disk),
    numeric: true,
  },
  {
    id: 'network',
    header: 'Network in / out',
    cell: (row) => formatRates(row.network),
    sortValue: (row) => rateSum(row.network),
    numeric: true,
  },
  {
    id: 'processes',
    header: 'Processes',
    cell: (row) => formatInteger(row.processes.length),
    sortValue: (row) => row.processes.length,
    numeric: true,
  },
  {
    id: 'flags',
    header: 'Problems',
    cell: (row) => <FlagSummary session={row} />,
    sortValue: (row) => sessionFlags(row).length,
  },
];

function ProcessRow(props: { readonly process: ActivityProcess }): ReactElement {
  const { process } = props;
  return (
    <tr className="activity-process">
      <td className="title-cell" data-tip={process.command}>
        <span className="activity-indent mono">{process.pid}</span> {process.name}
      </td>
      <td className="num">{formatCpu(process.cpuPct)}</td>
      <td className="num">{formatBytes(process.memoryBytes)}</td>
      <td className="num">{formatRates(process.disk)}</td>
      <td className="num">{formatRates(process.network)}</td>
      <td data-tip={`State code ${process.state}`}>{stateLabel(process.state)}</td>
      <td>
        <FlagBadges flags={process.flags} />
      </td>
    </tr>
  );
}

const DEFAULT_SORT: SortState = { column: 'cpu', descending: true };

function isSortState(value: unknown): value is SortState {
  return isRecord(value) && isString(value['column']) && typeof value['descending'] === 'boolean';
}

export function ActivityTable(props: {
  readonly sessions: readonly ActivitySession[];
}): ReactElement {
  const [sort, setSort] = usePersistentState('activitySort', DEFAULT_SORT, isSortState);
  const [open, setOpen] = usePersistentState<readonly string[]>('activityOpen', [], isStringArray);
  const rows = sortRows(props.sessions, SESSION_COLUMNS, sort);
  const toggle = (sessionId: string): void => {
    setOpen(
      open.includes(sessionId) ? open.filter((id) => id !== sessionId) : [...open, sessionId],
    );
  };
  return (
    <div className="table-scroll">
      <table className="grid activity-table">
        <caption className="visually-hidden">Running sessions</caption>
        <thead>
          <tr>
            {SESSION_COLUMNS.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={column.numeric === true ? 'num' : undefined}
                aria-sort={ariaSort(sort, column.id)}
              >
                <SortHeader
                  label={column.header}
                  column={column.id}
                  sort={sort}
                  onSort={(id) => {
                    setSort(nextSort(sort, id));
                  }}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={SESSION_COLUMNS.length} className="muted">
                No sessions are running on this machine.
              </td>
            </tr>
          ) : (
            rows.map((session) => {
              const expanded = open.includes(session.sessionId);
              return (
                <Fragment key={session.sessionId}>
                  <tr>
                    {SESSION_COLUMNS.map((column, index) => (
                      <td key={column.id} className={column.numeric === true ? 'num' : undefined}>
                        {index === 0 ? (
                          <button
                            type="button"
                            className="twisty"
                            aria-expanded={expanded}
                            aria-label={`${expanded ? 'Hide' : 'Show'} processes for ${session.title}`}
                            onClick={() => {
                              toggle(session.sessionId);
                            }}
                          >
                            {expanded ? '▾' : '▸'}
                          </button>
                        ) : null}
                        {column.cell(session)}
                      </td>
                    ))}
                  </tr>
                  {expanded
                    ? session.processes.map((process) => (
                        <ProcessRow key={process.pid} process={process} />
                      ))
                    : null}
                </Fragment>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
