// Runs table with open, stop and a guarded stop all.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { LaunchProfile } from '../../../src/shared/model.js';
import type { LaunchRun } from '../../../src/shared/protocol.js';
import { Badge } from '../components/badge.js';
import { ConfirmBar } from '../components/confirm-bar.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { formatCost, formatDuration, truncate } from '../format.js';
import { usePostAction } from '../vscode-context.js';

import { isActiveRun, RUN_TONES } from './launcher-values.js';

function RunActions(props: { readonly run: LaunchRun }): ReactElement {
  const post = usePostAction();
  const { run } = props;
  const { sessionId } = run;
  return (
    <span className="actions">
      {sessionId === null ? null : (
        <button
          type="button"
          aria-label={`Open ${run.spec.label}`}
          onClick={() => {
            post({ type: 'openSession', sessionId });
          }}
        >
          Open
        </button>
      )}
      {isActiveRun(run) ? (
        <button
          type="button"
          aria-label={`Stop ${run.spec.label}`}
          onClick={() => {
            post({ type: 'stopRun', runId: run.id });
          }}
        >
          Stop
        </button>
      ) : null}
    </span>
  );
}

/** The last part of a worktree path, which Overlord never ends with a slash. */
function baseName(folder: string): string {
  return folder.slice(folder.lastIndexOf('/') + 1);
}

function runColumns(profiles: readonly LaunchProfile[]): Column<LaunchRun>[] {
  const names = new Map(profiles.map((profile) => [profile.id, profile.name]));
  const profileName = (run: LaunchRun): string =>
    run.spec.profileId === null ? 'none' : (names.get(run.spec.profileId) ?? run.spec.profileId);
  return [
    {
      id: 'label',
      header: 'Label',
      cell: (run) => run.spec.label,
      sortValue: (run) => run.spec.label,
    },
    { id: 'profile', header: 'Profile', cell: profileName, sortValue: profileName },
    {
      id: 'state',
      header: 'State',
      cell: (run) => <Badge label={run.state} tone={RUN_TONES[run.state]} />,
      sortValue: (run) => run.state,
    },
    {
      id: 'cost',
      header: 'Cost',
      numeric: true,
      cell: (run) => formatCost(run.costUsd),
      sortValue: (run) => run.costUsd,
    },
    {
      id: 'turns',
      header: 'Turns',
      numeric: true,
      cell: (run) => run.turns,
      sortValue: (run) => run.turns,
    },
    {
      id: 'time',
      header: 'Time',
      numeric: true,
      cell: (run) => formatDuration(run.durationMs),
      sortValue: (run) => run.durationMs,
    },
    {
      id: 'result',
      header: 'Result',
      cell: (run) =>
        run.result === null ? (
          <span className="muted">n/a</span>
        ) : (
          <span title={run.result}>{truncate(run.result, 60)}</span>
        ),
    },
    {
      id: 'worktree',
      header: 'Worktree',
      // The folder name is enough to tell runs apart. The whole path is on hover.
      cell: (run) =>
        run.worktreePath === null ? null : (
          <span className="mono" title={run.worktreePath}>
            {baseName(run.worktreePath)}
          </span>
        ),
    },
    { id: 'actions', header: 'Actions', cell: (run) => <RunActions run={run} /> },
  ];
}

export function RunsTable(props: {
  readonly runs: readonly LaunchRun[];
  readonly profiles: readonly LaunchProfile[];
  readonly maxConcurrency: number;
}): ReactElement {
  const { runs, profiles, maxConcurrency } = props;
  const post = usePostAction();
  const [confirming, setConfirming] = useState(false);
  const active = runs.filter((run) => isActiveRun(run)).length;
  return (
    <section className="section" aria-labelledby="runs-heading">
      <div className="toolbar">
        <h2 id="runs-heading">Runs</h2>
        <span className="muted">
          {active} active, max {maxConcurrency} at once
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="danger"
          disabled={active === 0}
          onClick={() => {
            setConfirming(true);
          }}
        >
          Stop all
        </button>
      </div>
      <p className="hint">
        Open shows what a run is doing. Runs past the first {maxConcurrency} wait their turn.
      </p>
      {confirming ? (
        <ConfirmBar
          message={`Stop ${active.toString()} active runs?`}
          confirmLabel="Stop all"
          onConfirm={() => {
            setConfirming(false);
            post({ type: 'stopAll' });
          }}
          onCancel={() => {
            setConfirming(false);
          }}
        />
      ) : null}
      <DataTable
        caption="Runs"
        columns={runColumns(profiles)}
        rows={runs}
        rowKey={(run) => run.id}
        empty="No runs yet. Launch one above and it shows up here."
      />
    </section>
  );
}
