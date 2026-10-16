// The fleet tree table. Rows use roving focus: only the selected row and
// its buttons are in the tab order, and arrow keys move the selection.

import type { KeyboardEvent, ReactElement, RefObject } from 'react';
import { useMemo } from 'react';

import type { ChartTheme } from '../charts/chart-theme.js';
import { EChart } from '../charts/chart.js';
import { buildSparkline } from '../charts/sparkline.js';
import { PlaceBadge, StateBadge, SurfaceBadge } from '../components/badge.js';
import type { SortState } from '../components/data-table.js';
import { ariaSort, SortHeader } from '../components/data-table.js';
import { Icon } from '../components/icon.js';
import { Meter } from '../components/meter.js';
import { formatCompact, formatCost, formatDuration, formatPercent } from '../format.js';

import { deltas } from './fleet-history.js';
import type { RowHistory } from './fleet-history.js';
import type { FleetRow, VisibleRow } from './fleet-rows.js';
import { elapsedMs, rowCallsPerMinute } from './fleet-rows.js';

export type RowAction = 'open' | 'interrupt' | 'stop' | 'attach';

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
  readonly onAction: (row: FleetRow, action: RowAction) => void;
}): ReactElement {
  const { row, tabIndex, onAction } = props;
  const button = (action: RowAction, label: string, disabled: boolean): ReactElement => (
    <button
      type="button"
      className="icon-button"
      tabIndex={tabIndex}
      disabled={disabled}
      title={label}
      aria-label={`${label} ${row.title}`}
      onClick={() => {
        onAction(row, action);
      }}
    >
      <Icon name={action} />
    </button>
  );
  return (
    <span className="actions">
      {button('open', 'Open', false)}
      {row.kind === 'session' ? (
        <>
          {button('interrupt', 'Interrupt', !row.sessionActive)}
          {button('stop', 'Stop', !row.sessionActive)}
          {button('attach', 'Attach', false)}
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
  readonly rowRef: RefObject<HTMLTableRowElement | null> | undefined;
  readonly onSelect: (key: string) => void;
  readonly onKey: (event: KeyboardEvent<HTMLTableRowElement>, key: string) => void;
  readonly onToggle: (visible: VisibleRow) => void;
  readonly onAction: (row: FleetRow, action: RowAction) => void;
}

function Twisty(props: {
  readonly visible: VisibleRow;
  readonly onToggle: (visible: VisibleRow) => void;
}): ReactElement {
  const { visible, onToggle } = props;
  if (!visible.hasChildren) {
    return <span className="twisty" aria-hidden="true" />;
  }
  const verb = visible.expanded ? 'Collapse' : 'Expand';
  return (
    <button
      type="button"
      className="twisty"
      tabIndex={-1}
      title={verb}
      aria-label={`${verb} ${visible.row.title}`}
      onClick={() => {
        onToggle(visible);
      }}
    >
      {visible.expanded ? '▾' : '▸'}
    </button>
  );
}

function FleetTableRow(props: FleetTableRowProps): ReactElement {
  const { visible, selected, now, history, theme, rowRef } = props;
  const { row } = visible;
  const session = row.kind === 'session';
  return (
    <tr
      ref={rowRef}
      role="row"
      aria-level={visible.depth + 1}
      aria-expanded={visible.hasChildren ? visible.expanded : undefined}
      aria-selected={selected}
      data-kind={row.kind}
      data-state={row.state}
      tabIndex={selected ? 0 : -1}
      onClick={() => {
        props.onSelect(row.key);
      }}
      onKeyDown={(event) => {
        props.onKey(event, row.key);
      }}
    >
      <td role="gridcell" className="col-state">
        <StateBadge state={row.state} />
      </td>
      <td role="gridcell" className="col-surface">
        <SurfaceBadge surface={row.surface} />
        {row.place === null ? null : (
          <>
            {' '}
            <PlaceBadge place={row.place} />
          </>
        )}
      </td>
      <td role="gridcell" className="col-title" title={row.detail}>
        <span style={{ paddingLeft: `${(visible.depth * 1.2).toString()}em` }}>
          <Twisty visible={visible} onToggle={props.onToggle} />
          <span className="row-title">{row.title}</span>
        </span>{' '}
        <span className="muted row-detail">{row.detail}</span>
      </td>
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
        <RowActions row={row} tabIndex={selected ? 0 : -1} onAction={props.onAction} />
      </td>
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
              rowRef={selected ? props.selectedRef : undefined}
              onSelect={props.onSelect}
              onKey={props.onKey}
              onToggle={props.onToggle}
              onAction={props.onAction}
            />
          );
        })}
      </tbody>
    </table>
  );
}
