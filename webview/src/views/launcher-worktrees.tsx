// Worktrees table: every worktree Overlord made, what is left in it, which
// other worktrees or newly landed commits touch the same files, and the
// actions a finished one takes.

import type { ReactElement } from 'react';

import type { WorktreeState, WorktreeSummary } from '../../../src/shared/protocol.js';
import { Badge } from '../components/badge.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import type { Tone } from '../labels.js';
import { usePostAction } from '../vscode-context.js';

import { projectName } from './sessions-view.js';

export const WORKTREE_INFO: Readonly<
  Record<WorktreeState, { readonly tone: Tone; readonly description: string }>
> = {
  active: { tone: 'good', description: 'A session is working in it.' },
  dirty: { tone: 'warning', description: 'It has uncommitted edits.' },
  unlanded: { tone: 'warning', description: 'It has commits the default branch does not have.' },
  landed: { tone: 'info', description: 'Everything landed. It goes away on the next tidy-up.' },
  missing: { tone: 'critical', description: 'Its folder is gone.' },
};

/** Commits and uncommitted files, such as "2 commits, 1 file". */
export function describeChanges(item: WorktreeSummary): string {
  const parts = [
    ...(item.ahead > 0 ? [`${item.ahead.toString()} commit${item.ahead === 1 ? '' : 's'}`] : []),
    ...(item.dirty > 0 ? [`${item.dirty.toString()} file${item.dirty === 1 ? '' : 's'}`] : []),
  ];
  return parts.length === 0 ? 'none' : parts.join(', ');
}

function Overlaps(props: { readonly item: WorktreeSummary }): ReactElement {
  const { overlaps, upstreamFiles, target } = props.item;
  if (overlaps.length === 0 && upstreamFiles.length === 0) {
    return <span className="muted">none</span>;
  }
  return (
    <ul className="plain-list">
      {overlaps.map((overlap) => (
        <li key={overlap.id} title={overlap.files.join('\n')}>
          <Badge label="overlap" tone="warning" /> {overlap.label}: {overlap.files.join(', ')}
        </li>
      ))}
      {upstreamFiles.length > 0 ? (
        <li title={upstreamFiles.join('\n')}>
          <Badge label="behind" tone="warning" /> {target ?? 'default branch'} also changed:{' '}
          {upstreamFiles.join(', ')}
        </li>
      ) : null}
    </ul>
  );
}

function Actions(props: { readonly item: WorktreeSummary }): ReactElement | null {
  const post = usePostAction();
  const { item } = props;
  if (item.state === 'active' || item.state === 'missing') {
    return null;
  }
  return (
    <span className="actions">
      <button
        type="button"
        aria-label={`Open a session in ${item.label}`}
        onClick={() => {
          post({ type: 'openWorktree', id: item.id });
        }}
      >
        Open
      </button>
      {item.state === 'unlanded' && item.target !== null ? (
        <button
          type="button"
          aria-label={`Land ${item.label} on ${item.target}`}
          onClick={() => {
            post({ type: 'landWorktree', id: item.id });
          }}
        >
          Land
        </button>
      ) : null}
      <button
        type="button"
        className="danger"
        aria-label={`Discard ${item.label}`}
        onClick={() => {
          post({ type: 'discardWorktree', id: item.id });
        }}
      >
        Discard
      </button>
    </span>
  );
}

const COLUMNS: readonly Column<WorktreeSummary>[] = [
  {
    id: 'label',
    header: 'Label',
    wrap: true,
    cell: (item) => (
      <span title={item.path}>
        {item.label} <span className="muted mono">{item.branch}</span>
      </span>
    ),
    sortValue: (item) => item.label,
  },
  {
    id: 'repo',
    header: 'Repository',
    drop: 1,
    cell: (item) => <span title={item.repoRoot}>{projectName(item.repoRoot)}</span>,
    sortValue: (item) => item.repoRoot,
  },
  {
    id: 'state',
    header: 'State',
    cell: (item) => (
      <Badge
        label={item.state}
        tone={WORKTREE_INFO[item.state].tone}
        title={WORKTREE_INFO[item.state].description}
      />
    ),
    sortValue: (item) => item.state,
  },
  {
    id: 'slot',
    header: 'Slot',
    numeric: true,
    drop: 1,
    cell: (item) => item.slot,
    sortValue: (item) => item.slot,
  },
  { id: 'changes', header: 'Changes', drop: 2, cell: describeChanges },
  { id: 'overlaps', header: 'Overlaps', wrap: true, cell: (item) => <Overlaps item={item} /> },
  { id: 'actions', header: 'Actions', cell: (item) => <Actions item={item} /> },
];

export function WorktreesTable(props: {
  readonly worktrees: readonly WorktreeSummary[];
}): ReactElement {
  const { worktrees } = props;
  const overlapping = worktrees.filter((item) => item.overlaps.length > 0).length;
  return (
    <section className="section" aria-labelledby="worktrees-heading">
      <div className="list-bar">
        <h2 id="worktrees-heading">Worktrees</h2>
        <span className="muted">
          {worktrees.length} open
          {overlapping > 0 ? `, ${overlapping.toString()} touching the same files` : ''}
        </span>
      </div>
      <p className="hint">
        Each session and run works in its own copy of the repository. When one finishes, Open starts
        a session in it to look around, Land puts its commits on the default branch, and Discard
        throws it away.
      </p>
      <div className="table-card">
        <DataTable
          caption="Worktrees"
          columns={COLUMNS}
          rows={worktrees}
          rowKey={(item) => item.id}
          empty="No worktrees. Each new session and run gets its own."
        />
      </div>
    </section>
  );
}
