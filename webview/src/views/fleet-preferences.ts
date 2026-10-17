// The Fleet's choices that survive the panel closing: sort, filter, Hide
// done, folded rows, grouping, the working on line and the agent filter.

import type { SortState } from '../components/data-table.js';
import { isBoolean, isString, isStringArray } from '../guards.js';
import { usePersistentState } from '../vscode-context.js';

import { DEFAULT_SORT, isSortState } from './fleet-rows.js';

const NO_KEYS: readonly string[] = [];

export function useFleetPreferences(): {
  readonly sort: SortState;
  readonly setSort: (next: SortState) => void;
  readonly filter: string;
  readonly setFilter: (next: string) => void;
  readonly hideDone: boolean;
  readonly setHideDone: (next: boolean) => void;
  readonly collapsed: readonly string[];
  readonly setCollapsed: (next: readonly string[]) => void;
  readonly grouped: boolean;
  readonly setGrouped: (next: boolean) => void;
  readonly showSummary: boolean;
  readonly setShowSummary: (next: boolean) => void;
  /** The agent whose sessions the fleet shows, or empty for every agent. */
  readonly agent: string;
  readonly setAgent: (next: string) => void;
} {
  const [sort, setSort] = usePersistentState<SortState>('fleet.sort', DEFAULT_SORT, isSortState);
  const [filter, setFilter] = usePersistentState('fleet.filter', '', isString);
  const [hideDone, setHideDone] = usePersistentState('fleet.hideDone', false, isBoolean);
  const [collapsed, setCollapsed] = usePersistentState('fleet.collapsed', NO_KEYS, isStringArray);
  const [grouped, setGrouped] = usePersistentState('fleet.groupByProject', true, isBoolean);
  const [showSummary, setShowSummary] = usePersistentState('fleet.showSummary', true, isBoolean);
  const [agent, setAgent] = usePersistentState('fleet.agent', '', isString);
  return {
    sort,
    setSort,
    filter,
    setFilter,
    hideDone,
    setHideDone,
    collapsed,
    setCollapsed,
    grouped,
    setGrouped,
    showSummary,
    setShowSummary,
    agent,
    setAgent,
  };
}
