// The fleet tree table. Rows use roving focus: only the selected row and
// its buttons are in the tab order, and arrow keys move the selection.
// Project rows head their sessions with totals and have no per session cells.

import type { KeyboardEvent, ReactElement, RefObject } from 'react';
import { useMemo } from 'react';

import type { ChartTheme } from '../charts/chart-theme.js';
import { EChart } from '../charts/chart.js';
import { buildSparkline } from '../charts/sparkline.js';
import { StateBadge, SurfaceBadge } from '../components/badge.js';
import type { SortState } from '../components/data-table.js';
import { ariaSort, SortHeader } from '../components/data-table.js';
import { Icon } from '../components/icon.js';
import { Meter } from '../components/meter.js';
import { formatCompact, formatCost, formatDuration, formatPercent } from '../format.js';

import type { ProjectAction, RowAction, RowEvent } from './fleet-actions.js';
import { ACTION_LABELS, actionTip } from './fleet-actions.js';
import { deltas } from './fleet-history.js';
import type { RowHistory } from './fleet-history.js';
import type { FleetRow, VisibleRow } from './fleet-rows.js';
import { elapsedMs, rowCallsPerMinute } from './fleet-rows.js';
import { TitleCell } from './fleet-title-cell.js';
import { isLaunched } from './launched.js';

const COLUMNS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'state', label: 'State' },
  { id: 'surface', label: 'Surface' },
  { id: 'title', label: 'Title' },
  { id: 'model', label: 'Model' },
  { id: 'effort', label: 'Effort' },
  { id: 'elapsed', label: 'Elapsed' },
  { id: 'tool', label: 'Tool' },
  { id: 'calls', label: 'Calls/min' },
  { id: 'tokens', label: 'Tokens in/out' },
  { id: 'cache', label: 'Cache' },
  { id: 'context', label: 'Context' },
  { id: 'cost', label: 'Cost' },
];

/** Sparkline of recent token growth. Needs three samples to draw a line. */
export function FleetSparkline(props: {
  readonly history: readonly number[];
  readonly theme: ChartTheme;
  readonly label: string;
}): ReactElement {
  const { history, theme, label } = props;
  const option = useMemo(() => buildSparkline(deltas(history), theme), [history, theme]);
  return (
    <span className="sparkline">
      {history.length < 3 ? null : <EChart option={option} label={label} height={18} width={80} />}
    </span>
  );
}

function RowActions(props: {
  readonly row: FleetRow;
  readonly tabIndex: number;
  readonly onAction: (row: FleetRow, action: RowEvent) => void;
  readonly onProjectAction: (projectId: string, action: ProjectAction) => void;
}): ReactElement {
  const { row, tabIndex, onAction, onProjectAction } = props;
  const iconButton = (
    action: RowAction | ProjectAction,
    onClick: () => void,
    disabled = false,
  ): ReactElement => (
    <button
      key={action}
      type="button"
      className="icon-button"
      tabIndex={tabIndex}
      disabled={disabled}
      data-tip={actionTip(action)}
      aria-label={`${ACTION_LABELS[action]} ${row.title}`}
      onClick={onClick}
    >
      <Icon name={action} />
    </button>
  );
  const button = (action: RowAction, disabled = false): ReactElement =>
    iconButton(
      action,
      () => {
        onAction(row, action);
      },
      disabled,
    );
  if (row.kind === 'project') {
    const { projectId, manualProjectId, projectFolder } = row;
    const buttons = (id: string | null, actions: readonly ProjectAction[]): ReactElement[] =>
      id === null
        ? []
        : actions.map((action) =>
            iconButton(action, () => {
              onProjectAction(id, action);
            }),
          );
    return (
      <span className="actions">
        {buttons(projectFolder === null ? null : projectId, ['newSession', 'openFolder'])}
        {buttons(manualProjectId, ['setFolder', 'rename', 'delete'])}
      </span>
    );
  }
  return (
    <span className="actions">
      {button('open')}
      {button('context')}
      {row.kind === 'session' ? (
        <>
          {button('move')}
          {button('relocate')}
          {button('combine')}
          {button('interrupt', !row.sessionActive)}
          {button('stop', !row.sessionActive)}
        </>
      ) : null}
    </span>
  );
}

interface FleetTableRowProps {
  readonly visible: VisibleRow;
  readonly selected: boolean;
  readonly now: number;
  readonly history: readonly number[];
  readonly theme: ChartTheme;
  /** Whether a session's row shows the line on what it is working on. */
  readonly showSummary: boolean;
  readonly rowRef: RefObject<HTMLTableRowElement | null> | undefined;
  readonly onSelect: (key: string) => void;
  /** A click on the row itself, not one of its buttons. */
  readonly onActivate: (row: FleetRow) => void;
  readonly onKey: (event: KeyboardEvent<HTMLTableRowElement>, key: string) => void;
  readonly onToggle: (visible: VisibleRow) => void;
  readonly onAction: (row: FleetRow, action: RowEvent) => void;
  readonly onProjectAction: (projectId: string, action: ProjectAction) => void;
}

/** A project row: its most urgent state, its name and the totals of its sessions. */
function ProjectCells(props: FleetTableRowProps): ReactElement {
  const { visible, selected, history, theme } = props;
  const { row } = visible;
  return (
    <>
      <td role="gridcell" className="col-state">
        <StateBadge state={row.state} />
      </td>
      <td role="gridcell" className="col-surface" />
      <TitleCell
        visible={visible}
        showSummary={props.showSummary}
        tabIndex={selected ? 0 : -1}
        onToggle={props.onToggle}
        onAction={props.onAction}
      />
      <td role="gridcell" className="col-model" />
      <td role="gridcell" className="col-effort" />
      <td role="gridcell" className="col-elapsed num" />
      <td role="gridcell" className="col-tool" />
      <td role="gridcell" className="col-calls num" />
      <td role="gridcell" className="col-tokens num">
        {`${formatCompact(row.tokensIn)} / ${formatCompact(row.tokensOut)}`}
      </td>
      <td role="gridcell" className="col-cache num" />
      <td role="gridcell" className="col-context" />
      <td role="gridcell" className="col-cost num">
        {formatCost(row.costUsd)}
      </td>
      <td role="gridcell" className="col-trend">
        <FleetSparkline history={history} theme={theme} label={`Token trend for ${row.title}`} />
      </td>
      <td role="gridcell" className="col-actions">
        <RowActions
          row={row}
          tabIndex={selected ? 0 : -1}
          onAction={props.onAction}
          onProjectAction={props.onProjectAction}
        />
      </td>
    </>
  );
}

function SessionCells(props: FleetTableRowProps): ReactElement {
  const { visible, selected, now, history, theme } = props;
  const { row } = visible;
  const session = row.kind === 'session';
  return (
    <>
      <td role="gridcell" className="col-state">
        <StateBadge state={row.state} />
      </td>
      <td role="gridcell" className="col-surface">
        <SurfaceBadge surface={row.surface} />
      </td>
      <TitleCell
        visible={visible}
        showSummary={props.showSummary}
        tabIndex={selected ? 0 : -1}
        onToggle={props.onToggle}
        onAction={props.onAction}
      />
      <td role="gridcell" className="col-model">
        {row.model ?? ''}
      </td>
      <td role="gridcell" className="col-effort">
        {row.effort ?? ''}
      </td>
      <td role="gridcell" className="col-elapsed num">
        {formatDuration(elapsedMs(row, now))}
      </td>
      <td role="gridcell" className="col-tool">
        {row.currentTool ?? ''}
      </td>
      <td role="gridcell" className="col-calls num">
        {rowCallsPerMinute(row, now).toFixed(1)}
      </td>
      <td role="gridcell" className="col-tokens num">
        {`${formatCompact(row.tokensIn)} / ${formatCompact(row.tokensOut)}`}
      </td>
      <td role="gridcell" className="col-cache num">
        {formatPercent(row.cacheHit)}
      </td>
      <td role="gridcell" className="col-context">
        {session ? <Meter label={`Context used by ${row.title}`} ratio={row.contextFill} /> : null}
      </td>
      <td role="gridcell" className="col-cost num">
        {session ? formatCost(row.costUsd) : ''}
      </td>
      <td role="gridcell" className="col-trend">
        <FleetSparkline history={history} theme={theme} label={`Token trend for ${row.title}`} />
      </td>
      <td role="gridcell" className="col-actions">
        <RowActions
          row={row}
          tabIndex={selected ? 0 : -1}
          onAction={props.onAction}
          onProjectAction={props.onProjectAction}
        />
      </td>
    </>
  );
}

function FleetTableRow(props: FleetTableRowProps): ReactElement {
  const { visible, selected, rowRef } = props;
  const { row } = visible;
  return (
    <tr
      ref={rowRef}
      role="row"
      aria-level={visible.depth + 1}
      aria-expanded={visible.hasChildren ? visible.expanded : undefined}
      aria-selected={selected}
      data-kind={row.kind}
      data-state={row.state}
      data-needs-project={row.needsProject ? 'true' : undefined}
      data-launched={isLaunched(row) ? 'true' : undefined}
      tabIndex={selected ? 0 : -1}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('button') !== null) {
          props.onSelect(row.key);
        } else {
          props.onActivate(row);
        }
      }}
      onKeyDown={(event) => {
        props.onKey(event, row.key);
      }}
    >
      {row.kind === 'project' ? <ProjectCells {...props} /> : <SessionCells {...props} />}
    </tr>
  );
}

export interface FleetTableProps extends Omit<
  FleetTableRowProps,
  'visible' | 'selected' | 'history' | 'rowRef'
> {
  readonly rows: readonly VisibleRow[];
  readonly selectedKey: string | null;
  readonly historyByKey: RowHistory;
  readonly selectedRef: RefObject<HTMLTableRowElement | null>;
  readonly sort: SortState;
  readonly onSort: (column: string) => void;
}

const EMPTY: readonly number[] = [];

export function FleetTable(props: FleetTableProps): ReactElement {
  const { rows, selectedKey, sort, onSort } = props;
  return (
    // ARIA in HTML allows role="treegrid" on a table element, and the rows
    // are fully keyboard operable, but jsx-a11y treats table as never
    // interactive. The alternative (a presentational table) trips
    // sonarjs/no-table-as-layout and loses the native table semantics.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role
    <table className="grid tree-table" role="treegrid" aria-label="Sessions">
      <thead>
        <tr role="row">
          {COLUMNS.map((column) => (
            <th
              key={column.id}
              className={`col-${column.id}`}
              role="columnheader"
              scope="col"
              aria-sort={ariaSort(sort, column.id)}
            >
              <SortHeader label={column.label} column={column.id} sort={sort} onSort={onSort} />
            </th>
          ))}
          <th role="columnheader" scope="col" className="col-trend">
            Trend
          </th>
          <th role="columnheader" scope="col" className="col-actions">
            Actions
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((visible) => {
          const selected = visible.row.key === selectedKey;
          return (
            <FleetTableRow
              key={visible.row.key}
              visible={visible}
              selected={selected}
              now={props.now}
              history={props.historyByKey.get(visible.row.key) ?? EMPTY}
              theme={props.theme}
              showSummary={props.showSummary}
              rowRef={selected ? props.selectedRef : undefined}
              onSelect={props.onSelect}
              onActivate={props.onActivate}
              onKey={props.onKey}
              onToggle={props.onToggle}
              onAction={props.onAction}
              onProjectAction={props.onProjectAction}
            />
          );
        })}
      </tbody>
    </table>
  );
}
