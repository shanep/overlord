// The htop view: every session and its subagents in one sortable,
// filterable tree, with live stats, pending permissions and row actions.

import type { KeyboardEvent, ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { PermissionRequest } from '../../../src/shared/model.js';
import type { FleetState } from '../../../src/shared/protocol.js';
import { useChartTheme } from '../charts/chart-theme.js';
import { useNow } from '../clock.js';
import { ConfirmBar } from '../components/confirm-bar.js';
import type { SortState } from '../components/data-table.js';
import { EmptyState } from '../components/empty-state.js';
import { isBoolean, isString, isStringArray } from '../guards.js';
import { usePersistentState, usePostAction } from '../vscode-context.js';

import type { PermissionChoice } from './fleet-header.js';
import { FleetHeader, PermissionBanner } from './fleet-header.js';
import { historySamples, useRowHistory } from './fleet-history.js';
import type { FleetCommand } from './fleet-keys.js';
import { keyCommand } from './fleet-keys.js';
import type { FleetRow, VisibleRow } from './fleet-rows.js';
import {
  buildFleetTree,
  DEFAULT_SORT,
  filterTree,
  flattenTree,
  isSortState,
  nextFleetSort,
  sortTree,
} from './fleet-rows.js';
import type { RowAction } from './fleet-table.js';
import { FleetTable } from './fleet-table.js';

interface PendingConfirm {
  readonly kind: 'interrupt' | 'stop';
  readonly row: FleetRow;
}

const NO_KEYS: readonly string[] = [];

function useFleetPreferences(): {
  readonly sort: SortState;
  readonly setSort: (next: SortState) => void;
  readonly filter: string;
  readonly setFilter: (next: string) => void;
  readonly hideDone: boolean;
  readonly setHideDone: (next: boolean) => void;
  readonly collapsed: readonly string[];
  readonly setCollapsed: (next: readonly string[]) => void;
} {
  const [sort, setSort] = usePersistentState<SortState>('fleet.sort', DEFAULT_SORT, isSortState);
  const [filter, setFilter] = usePersistentState('fleet.filter', '', isString);
  const [hideDone, setHideDone] = usePersistentState('fleet.hideDone', false, isBoolean);
  const [collapsed, setCollapsed] = usePersistentState('fleet.collapsed', NO_KEYS, isStringArray);
  return { sort, setSort, filter, setFilter, hideDone, setHideDone, collapsed, setCollapsed };
}

export function FleetView(props: { readonly state: FleetState }): ReactElement {
  const { state } = props;
  const post = usePostAction();
  const now = useNow();
  const theme = useChartTheme();
  const preferences = useFleetPreferences();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const selectedRef = useRef<HTMLTableRowElement>(null);
  const navigating = useRef(false);
  /** The row key of the focused terminal's session, until that row is selected and scrolled to. */
  const following = useRef<string | null>(null);

  const tree = useMemo(() => buildFleetTree(state), [state]);
  const history = useRowHistory(historySamples(tree), state);
  const filtered = filterTree(tree, { text: preferences.filter, hideDone: preferences.hideDone });
  const rows = flattenTree(
    sortTree(filtered, preferences.sort, now),
    new Set(preferences.collapsed),
  );
  const selectedKey = rows.some((row) => row.row.key === selected)
    ? selected
    : (rows[0]?.row.key ?? null);

  // Follow the focused terminal: select its session and bring the row into
  // view, but leave keyboard focus in the terminal.
  useEffect(() => {
    if (state.activeSessionId !== null) {
      following.current = `s:${state.activeSessionId}`;
      setSelected(following.current);
    }
  }, [state.activeSessionId]);

  useEffect(() => {
    if (navigating.current) {
      navigating.current = false;
      selectedRef.current?.focus();
    } else if (following.current === selectedKey) {
      following.current = null;
      selectedRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedKey]);

  const setExpanded = (key: string, expanded: boolean): void => {
    const others = preferences.collapsed.filter((item) => item !== key);
    preferences.setCollapsed(expanded ? others : [...others, key]);
  };

  // A session opens where it runs (its terminal tab, or an attach tab for a
  // background session). A subagent has no terminal, so it opens its view.
  const activate = (row: FleetRow): void => {
    setSelected(row.key);
    post(
      row.kind === 'session'
        ? { type: 'openSession', sessionId: row.sessionId }
        : { type: 'openAgent', sessionId: row.sessionId, agentId: row.agentId },
    );
  };

  const onAction = (row: FleetRow, action: RowAction): void => {
    setSelected(row.key);
    if (action === 'open') {
      post({ type: 'openAgent', sessionId: row.sessionId, agentId: row.agentId });
    } else {
      setConfirm({ kind: action, row });
    }
  };

  const runCommand = (command: FleetCommand): void => {
    switch (command.type) {
      case 'select': {
        navigating.current = true;
        setSelected(command.key);
        break;
      }
      case 'expand':
      case 'collapse': {
        setExpanded(command.key, command.type === 'expand');
        break;
      }
      case 'open': {
        activate(command.row);
        break;
      }
      case 'interrupt': {
        setConfirm({ kind: 'interrupt', row: command.row });
        break;
      }
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTableRowElement>, key: string): void => {
    if (event.target !== event.currentTarget) {
      return;
    }
    const command = keyCommand(rows, key, event.key);
    if (command !== null) {
      event.preventDefault();
      runCommand(command);
    }
  };

  const closeConfirm = (): void => {
    setConfirm(null);
    selectedRef.current?.focus();
  };

  const onResolve = (request: PermissionRequest, choice: PermissionChoice): void => {
    if (choice === 'always') {
      post({ type: 'alwaysAllowPermission', requestId: request.id });
      return;
    }
    post({
      type: 'resolvePermission',
      requestId: request.id,
      decision:
        choice === 'allow'
          ? { behavior: 'allow', ruleId: null }
          : { behavior: 'deny', message: 'Denied from Overlord', ruleId: null },
    });
  };

  return (
    <section className="fleet" aria-label="Fleet">
      <FleetHeader state={state} now={now} />
      {state.pendingPermissions.length > 0 ? (
        <PermissionBanner
          requests={state.pendingPermissions}
          sessions={state.sessions}
          onResolve={onResolve}
        />
      ) : null}
      <div className="toolbar">
        <label className="filter">
          <span className="visually-hidden">Filter</span>
          <input
            type="search"
            placeholder="Filter sessions"
            value={preferences.filter}
            onChange={(event) => {
              preferences.setFilter(event.target.value);
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={preferences.hideDone}
            onChange={(event) => {
              preferences.setHideDone(event.target.checked);
            }}
          />
          Hide done
        </label>
        <span className="spacer" />
        <span className="muted fleet-keys">
          <kbd>{'↑'}</kbd> <kbd>{'↓'}</kbd> move, <kbd>Enter</kbd> open, <kbd>k</kbd> interrupt
        </span>
      </div>
      {confirm === null ? null : (
        <ConfirmBar
          message={`${confirm.kind === 'stop' ? 'Stop' : 'Interrupt'} "${confirm.row.sessionTitle}"?`}
          confirmLabel={confirm.kind === 'stop' ? 'Stop' : 'Interrupt'}
          onConfirm={() => {
            post({ type: confirm.kind, sessionId: confirm.row.sessionId });
            closeConfirm();
          }}
          onCancel={closeConfirm}
        />
      )}
      {rows.length === 0 ? (
        <EmptyState title="No sessions" detail="Nothing matches, or nothing is running." />
      ) : (
        <FleetTable
          rows={rows}
          selectedKey={selectedKey}
          historyByKey={history}
          selectedRef={selectedRef}
          sort={preferences.sort}
          onSort={(column) => {
            preferences.setSort(nextFleetSort(preferences.sort, column));
          }}
          now={now}
          theme={theme}
          onSelect={setSelected}
          onActivate={activate}
          onKey={onKey}
          onToggle={(visible: VisibleRow) => {
            setExpanded(visible.row.key, !visible.expanded);
          }}
          onAction={onAction}
        />
      )}
    </section>
  );
}
