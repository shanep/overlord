// A compact table with optional sorting on any column that has a sort key.

import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';

export interface Column<T> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
  /** Present when the column can sort. */
  readonly sortValue?: (row: T) => string | number;
  readonly numeric?: boolean;
  /** Let long text wrap instead of widening the table. */
  readonly wrap?: boolean;
}

/** The class for a column's cells: num for numbers, wrap for long text. */
export function cellClass<T>(column: Column<T>): string | undefined {
  const names = [column.numeric === true ? 'num' : '', column.wrap === true ? 'wrap' : ''];
  const joined = names.filter((name) => name !== '').join(' ');
  return joined === '' ? undefined : joined;
}

export interface SortState {
  readonly column: string;
  readonly descending: boolean;
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a).localeCompare(String(b));
}

/** Rows sorted by `sort`, or unchanged when the column has no sort key. */
export function sortRows<T>(
  rows: readonly T[],
  columns: readonly Column<T>[],
  sort: SortState | null,
): readonly T[] {
  const sortValue = columns.find((column) => column.id === sort?.column)?.sortValue;
  if (sort === null || sortValue === undefined) {
    return rows;
  }
  const direction = sort.descending ? -1 : 1;
  return rows.toSorted((a, b) => direction * compareValues(sortValue(a), sortValue(b)));
}

/** Clicking the sorted column flips direction, another column sorts ascending. */
export function nextSort(current: SortState | null, column: string): SortState {
  if (current?.column === column) {
    return { column, descending: !current.descending };
  }
  return { column, descending: false };
}

export function ariaSort(
  sort: SortState | null,
  column: string,
): 'ascending' | 'descending' | 'none' {
  if (sort?.column !== column) {
    return 'none';
  }
  return sort.descending ? 'descending' : 'ascending';
}

export function SortHeader(props: {
  readonly label: string;
  readonly column: string;
  readonly sort: SortState | null;
  readonly onSort: (column: string) => void;
}): ReactElement {
  const state = ariaSort(props.sort, props.column);
  const arrow = { ascending: ' ▲', descending: ' ▼', none: '' }[state];
  return (
    <button
      type="button"
      className="sort-button"
      onClick={() => {
        props.onSort(props.column);
      }}
    >
      {props.label}
      <span aria-hidden="true">{arrow}</span>
    </button>
  );
}

export interface DataTableProps<T> {
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly initialSort?: SortState;
  readonly empty?: string;
}

export function DataTable<T>(props: DataTableProps<T>): ReactElement {
  const { caption, columns, rows, rowKey } = props;
  const [sort, setSort] = useState<SortState | null>(props.initialSort ?? null);
  const sorted = sortRows(rows, columns, sort);
  return (
    <table className="grid">
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.id}
              scope="col"
              className={cellClass(column)}
              aria-sort={column.sortValue === undefined ? undefined : ariaSort(sort, column.id)}
            >
              {column.sortValue === undefined ? (
                column.header
              ) : (
                <SortHeader
                  label={column.header}
                  column={column.id}
                  sort={sort}
                  onSort={(id) => {
                    setSort(nextSort(sort, id));
                  }}
                />
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="muted">
              {props.empty ?? 'Nothing here.'}
            </td>
          </tr>
        ) : (
          sorted.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.id} className={cellClass(column)}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
