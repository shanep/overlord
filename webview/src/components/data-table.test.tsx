import { render, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { expectAccessible } from '../../test/render.js';

import type { Column } from './data-table.js';
import { ariaSort, cellClass, DataTable, nextSort, sortRows } from './data-table.js';

interface Row {
  readonly name: string;
  readonly size: number;
}

const rows: readonly Row[] = [
  { name: 'beta', size: 2 },
  { name: 'alpha', size: 10 },
  { name: 'gamma', size: 1 },
];

const columns: readonly Column<Row>[] = [
  { id: 'name', header: 'Name', cell: (row) => row.name, sortValue: (row) => row.name },
  {
    id: 'size',
    header: 'Size',
    cell: (row) => row.size,
    sortValue: (row) => row.size,
    numeric: true,
  },
  { id: 'note', header: 'Note', cell: () => 'n' },
];

function names(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('td')?.textContent ?? '');
}

describe('sortRows', () => {
  it('sorts strings and numbers in both directions', () => {
    expect(
      sortRows(rows, columns, { column: 'name', descending: false }).map((row) => row.name),
    ).toStrictEqual(['alpha', 'beta', 'gamma']);
    expect(
      sortRows(rows, columns, { column: 'size', descending: true }).map((row) => row.size),
    ).toStrictEqual([10, 2, 1]);
  });

  it('leaves rows alone with no sort or an unsortable column', () => {
    expect(sortRows(rows, columns, null)).toBe(rows);
    expect(sortRows(rows, columns, { column: 'note', descending: false })).toBe(rows);
    expect(sortRows(rows, columns, { column: 'missing', descending: false })).toBe(rows);
  });

  it('compares numbers as numbers and anything mixed as text', () => {
    const mixed: readonly Column<Row>[] = [
      {
        id: 'mixed',
        header: 'M',
        cell: () => '',
        sortValue: (row) => (row.size > 1 ? row.size : row.name),
      },
    ];
    expect(
      sortRows(rows, mixed, { column: 'mixed', descending: false }).map((row) => row.name),
    ).toStrictEqual(['beta', 'alpha', 'gamma']);
  });
});

const cell = (): string => '';

describe('cellClass', () => {
  it('marks numbers and wrapping text, and nothing else', () => {
    expect(cellClass({ id: 'a', header: 'A', cell })).toBeUndefined();
    expect(cellClass({ id: 'a', header: 'A', cell, numeric: true })).toBe('num');
    expect(cellClass({ id: 'a', header: 'A', cell, wrap: true })).toBe('wrap');
    expect(cellClass({ id: 'a', header: 'A', cell, numeric: true, wrap: true })).toBe('num wrap');
  });
});

describe('nextSort and ariaSort', () => {
  it('flips the current column and starts others ascending', () => {
    expect(nextSort(null, 'a')).toStrictEqual({ column: 'a', descending: false });
    expect(nextSort({ column: 'a', descending: false }, 'a')).toStrictEqual({
      column: 'a',
      descending: true,
    });
    expect(nextSort({ column: 'a', descending: true }, 'b')).toStrictEqual({
      column: 'b',
      descending: false,
    });
  });

  it('reports aria-sort values', () => {
    expect(ariaSort(null, 'a')).toBe('none');
    expect(ariaSort({ column: 'b', descending: false }, 'a')).toBe('none');
    expect(ariaSort({ column: 'a', descending: false }, 'a')).toBe('ascending');
    expect(ariaSort({ column: 'a', descending: true }, 'a')).toBe('descending');
  });
});

describe('DataTable', () => {
  it('sorts when a header button is clicked and marks aria-sort', async () => {
    const { getByRole, container } = render(
      <main>
        <DataTable caption="Files" columns={columns} rows={rows} rowKey={(row) => row.name} />
      </main>,
    );
    const table = getByRole('table', { name: 'Files' });
    expect(names(table)).toStrictEqual(['beta', 'alpha', 'gamma']);
    const nameHeader = getByRole('columnheader', { name: 'Name' });
    expect(nameHeader.getAttribute('aria-sort')).toBe('none');
    expect(getByRole('columnheader', { name: 'Note' }).hasAttribute('aria-sort')).toBe(false);
    await userEvent.click(getByRole('button', { name: 'Name' }));
    expect(names(table)).toStrictEqual(['alpha', 'beta', 'gamma']);
    expect(nameHeader.getAttribute('aria-sort')).toBe('ascending');
    await userEvent.click(getByRole('button', { name: 'Name' }));
    expect(names(table)).toStrictEqual(['gamma', 'beta', 'alpha']);
    expect(nameHeader.getAttribute('aria-sort')).toBe('descending');
    expect(getByRole('columnheader', { name: 'Size' }).className).toBe('num');
    await expectAccessible(container);
  });

  it('starts from an initial sort', () => {
    const { getByRole } = render(
      <DataTable
        caption="Files"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.name}
        initialSort={{ column: 'size', descending: false }}
      />,
    );
    expect(names(getByRole('table'))).toStrictEqual(['gamma', 'beta', 'alpha']);
  });

  it('shows an empty message across all columns', () => {
    const { getByText, rerender } = render(
      <DataTable
        caption="Files"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.name}
        empty="No files."
      />,
    );
    expect(getByText('No files.').getAttribute('colspan')).toBe('3');
    rerender(<DataTable caption="Files" columns={columns} rows={[]} rowKey={(row) => row.name} />);
    expect(getByText('Nothing here.')).toBeDefined();
  });
});
