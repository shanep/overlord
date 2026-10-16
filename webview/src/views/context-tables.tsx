// Sortable tables for the context inspector: loaded memory files, skipped
// candidates, skills and the environment block.

import type { ReactElement } from 'react';

import type { LoadedInstruction, SkillEntry, SkippedCandidate } from '../../../src/shared/model.js';
import { Badge } from '../components/badge.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { formatInteger } from '../format.js';
import type { Tone } from '../labels.js';
import { usePostAction } from '../vscode-context.js';

export function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

/** Whether the loaded text still matches the file, as a word and a tone. */
export function diskState(differs: boolean | null): {
  readonly label: string;
  readonly tone: Tone;
} {
  if (differs === null) {
    return { label: 'Unknown', tone: 'neutral' };
  }
  return differs ? { label: 'Yes', tone: 'warning' } : { label: 'No', tone: 'good' };
}

function PathCell(props: { readonly path: string | null }): ReactElement {
  return props.path === null ? (
    <span className="muted">none</span>
  ) : (
    <span className="mono">{props.path}</span>
  );
}

export function LoadedTable(props: {
  readonly loaded: readonly LoadedInstruction[];
}): ReactElement {
  const post = usePostAction();
  const columns: readonly Column<LoadedInstruction>[] = [
    {
      id: 'path',
      header: 'Path',
      sortValue: (row) => row.path,
      cell: (row) => (
        <button
          type="button"
          className="link-button mono"
          onClick={() => {
            post({ type: 'openFile', path: row.path });
          }}
        >
          {row.path}
        </button>
      ),
    },
    { id: 'tier', header: 'Tier', sortValue: (row) => row.tier, cell: (row) => row.tier },
    { id: 'reason', header: 'Reason', sortValue: (row) => row.reason, cell: (row) => row.reason },
    { id: 'trigger', header: 'Trigger', cell: (row) => <PathCell path={row.triggerPath} /> },
    { id: 'parent', header: 'Imported by', cell: (row) => <PathCell path={row.parentPath} /> },
    {
      id: 'bytes',
      header: 'Bytes',
      numeric: true,
      sortValue: (row) => row.bytes,
      cell: (row) => formatInteger(row.bytes),
    },
    {
      id: 'differs',
      header: 'Differs from disk',
      cell: (row): ReactElement => {
        const state = diskState(row.differsFromDisk);
        return <Badge label={state.label} tone={state.tone} />;
      },
    },
  ];
  return (
    <DataTable
      caption="Loaded memory files"
      columns={columns}
      rows={props.loaded}
      rowKey={(row) => row.path}
      empty="No memory files loaded."
    />
  );
}

const SKIPPED_COLUMNS: readonly Column<SkippedCandidate>[] = [
  {
    id: 'path',
    header: 'Path',
    sortValue: (row) => row.path,
    cell: (row) => <span className="mono">{row.path}</span>,
  },
  { id: 'tier', header: 'Tier', sortValue: (row) => row.tier, cell: (row) => row.tier },
  { id: 'exists', header: 'Exists', cell: (row) => yesNo(row.exists) },
  {
    id: 'code',
    header: 'Reason',
    sortValue: (row) => row.code,
    cell: (row) => <Badge label={row.code} tone="warning" />,
  },
  { id: 'detail', header: 'Detail', cell: (row) => row.detail },
];

export function SkippedTable(props: {
  readonly skipped: readonly SkippedCandidate[];
}): ReactElement {
  return (
    <DataTable
      caption="Files that did not load"
      columns={SKIPPED_COLUMNS}
      rows={props.skipped}
      rowKey={(row) => `${row.path}:${row.code}`}
      empty="Every candidate loaded."
    />
  );
}

const SKILL_COLUMNS: readonly Column<SkillEntry>[] = [
  { id: 'name', header: 'Skill', sortValue: (row) => row.name, cell: (row) => row.name },
  { id: 'source', header: 'Source', sortValue: (row) => row.source, cell: (row) => row.source },
  { id: 'listed', header: 'Listed', cell: (row) => yesNo(row.listed) },
  { id: 'invoked', header: 'Invoked', cell: (row) => yesNo(row.invoked) },
  {
    id: 'chars',
    header: 'Description chars',
    numeric: true,
    sortValue: (row) => row.descriptionChars,
    cell: (row) => formatInteger(row.descriptionChars),
  },
];

export function SkillsTable(props: { readonly skills: readonly SkillEntry[] }): ReactElement {
  return (
    <DataTable
      caption="Skills"
      columns={SKILL_COLUMNS}
      rows={props.skills}
      rowKey={(row) => `${row.source}:${row.name}`}
      empty="No skills."
    />
  );
}

interface EnvRow {
  readonly key: string;
  readonly value: string;
}

const ENV_COLUMNS: readonly Column<EnvRow>[] = [
  { id: 'key', header: 'Key', sortValue: (row) => row.key, cell: (row) => row.key },
  { id: 'value', header: 'Value', cell: (row) => <span className="mono">{row.value}</span> },
];

export function EnvironmentTable(props: {
  readonly environment: Readonly<Record<string, string>>;
}): ReactElement {
  const rows = Object.entries(props.environment).map(([key, value]) => ({ key, value }));
  return (
    <DataTable
      caption="Environment"
      columns={ENV_COLUMNS}
      rows={rows}
      rowKey={(row) => row.key}
      empty="No environment block."
    />
  );
}
