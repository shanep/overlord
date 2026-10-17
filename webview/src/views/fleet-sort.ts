// Sorting the fleet tree by any column, siblings at every level. Rows that
// tie keep start order, so a tie never reshuffles between updates.

import type { SortState } from '../components/data-table.js';
import { STATE_RANK, SURFACE_LABELS } from '../labels.js';

import type { FleetNode, FleetRow } from './fleet-rows.js';
import { elapsedMs, placeLabel, rowCallsPerMinute } from './fleet-rows.js';

type Sorter = (row: FleetRow, now: number) => number | string;

const SORTERS: Readonly<Record<string, Sorter>> = {
  started: (row) => row.startedAt,
  state: (row) => STATE_RANK[row.state],
  surface: (row) => `${SURFACE_LABELS[row.surface]} ${placeLabel(row)}`,
  title: (row) => row.title.toLowerCase(),
  health: (row) => row.health?.score ?? -1,
  progress: (row) => {
    const tasks = row.progress?.tasks ?? null;
    return tasks === null ? -1 : tasks.done / tasks.total;
  },
  left: (row) => row.progress?.tasks?.estimate?.msLeft ?? -1,
  model: (row) => row.model ?? '',
  effort: (row) => row.effort ?? '',
  elapsed: elapsedMs,
  tool: (row) => row.currentTool ?? '',
  calls: rowCallsPerMinute,
  tokens: (row) => row.tokensIn + row.tokensOut,
  cache: (row) => row.cacheHit ?? -1,
  context: (row) => row.contextFill ?? -1,
  cost: (row) => row.costUsd ?? -1,
};

function compareValues(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a).localeCompare(String(b));
}

/** Rows that tie keep start order, so a tie never reshuffles between updates. */
function compareRows(a: FleetRow, b: FleetRow): number {
  return a.startedAt - b.startedAt || a.key.localeCompare(b.key);
}

/**
 * Sort siblings at every level. Project rows keep their order, so Unassigned
 * stays on top. An unknown column leaves the order alone.
 */
export function sortTree(
  nodes: readonly FleetNode[],
  sort: SortState,
  now: number,
): readonly FleetNode[] {
  const sorter = SORTERS[sort.column];
  if (sorter === undefined) {
    return nodes;
  }
  const direction = sort.descending ? -1 : 1;
  const sortLevel = (level: readonly FleetNode[]): FleetNode[] => {
    const sortedChildren = level.map((node) => ({
      row: node.row,
      children: sortLevel(node.children),
    }));
    return sortedChildren.every((node) => node.row.kind === 'project')
      ? sortedChildren
      : sortedChildren.toSorted(
          (a, b) =>
            direction * compareValues(sorter(a.row, now), sorter(b.row, now)) ||
            compareRows(a.row, b.row),
        );
  };
  return sortLevel(nodes);
}
