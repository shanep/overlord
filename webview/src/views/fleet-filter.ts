// Filtering the fleet tree: the text a person types in the filter box, and
// Hide done.

import { SURFACE_LABELS } from '../labels.js';

import type { FleetNode, FleetRow } from './fleet-rows.js';
import { placeLabel } from './fleet-rows.js';

export interface FleetFilter {
  readonly text: string;
  readonly hideDone: boolean;
}

/** Case insensitive match on the text a person would type to find a row. A project matches on its name and folder. */
export function rowMatches(row: FleetRow, needle: string): boolean {
  if (row.kind === 'project') {
    return `${row.title} ${row.detail}`.toLowerCase().includes(needle);
  }
  const haystack = [
    row.title,
    row.detail,
    row.summary ?? '',
    row.model ?? '',
    row.state,
    SURFACE_LABELS[row.surface],
    placeLabel(row),
    row.currentTool ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Keep a node when it matches, with its whole subtree, or when any
 * descendant matches, with just the matching branches. Hide done drops
 * done rows at every level first, except a project in the workspace, which
 * stays with its done sessions hidden.
 */
export function filterTree(nodes: readonly FleetNode[], filter: FleetFilter): FleetNode[] {
  const needle = filter.text.trim().toLowerCase();
  const visit = (level: readonly FleetNode[], inherited: boolean): FleetNode[] =>
    level.flatMap((node) => {
      if (filter.hideDone && node.row.state === 'done' && !node.row.inWorkspace) {
        return [];
      }
      const matched = inherited || rowMatches(node.row, needle);
      const children = visit(node.children, matched);
      return matched || children.length > 0 ? [{ row: node.row, children }] : [];
    });
  return visit(nodes, needle === '');
}
