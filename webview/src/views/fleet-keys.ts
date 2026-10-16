// Keyboard commands for the fleet tree, as a pure function of the visible
// rows, the selected row and the key pressed.

import type { FleetRow, VisibleRow } from './fleet-rows.js';

export type FleetCommand =
  | { readonly type: 'select'; readonly key: string }
  | { readonly type: 'expand'; readonly key: string }
  | { readonly type: 'collapse'; readonly key: string }
  | { readonly type: 'open'; readonly row: FleetRow }
  | { readonly type: 'interrupt'; readonly row: FleetRow };

interface KeyContext {
  readonly rows: readonly VisibleRow[];
  readonly index: number;
  readonly current: VisibleRow;
}

type KeyHandler = (context: KeyContext) => FleetCommand | null;

function selectAt(rows: readonly VisibleRow[], index: number): FleetCommand | null {
  const target = rows[index];
  return target === undefined ? null : { type: 'select', key: target.row.key };
}

const HANDLERS: Readonly<Record<string, KeyHandler>> = {
  ArrowDown: ({ rows, index }) => selectAt(rows, index + 1),
  ArrowUp: ({ rows, index }) => selectAt(rows, index - 1),
  Home: ({ rows }) => selectAt(rows, 0),
  End: ({ rows }) => selectAt(rows, rows.length - 1),
  ArrowRight: ({ rows, index, current }) => {
    if (!current.hasChildren) {
      return null;
    }
    return current.expanded ? selectAt(rows, index + 1) : { type: 'expand', key: current.row.key };
  },
  ArrowLeft: ({ current }) => {
    if (current.expanded) {
      return { type: 'collapse', key: current.row.key };
    }
    return current.parentKey === null ? null : { type: 'select', key: current.parentKey };
  },
  Enter: ({ current }) => ({ type: 'open', row: current.row }),
  k: ({ current }) => (current.row.sessionActive ? { type: 'interrupt', row: current.row } : null),
};

/** The command for `key` on the selected row, or null when the key does nothing. */
export function keyCommand(
  rows: readonly VisibleRow[],
  selectedKey: string,
  key: string,
): FleetCommand | null {
  const handler = HANDLERS[key];
  const index = rows.findIndex((row) => row.row.key === selectedKey);
  const current = rows[index];
  if (handler === undefined || current === undefined) {
    return null;
  }
  return handler({ rows, index, current });
}
