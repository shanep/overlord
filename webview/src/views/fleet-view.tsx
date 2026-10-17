// The htop view: every session and its subagents in one sortable,
// filterable tree, grouped by project, with live stats, pending permissions
// and row actions.

import type { KeyboardEvent, ReactElement } from 'react';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';

import type { PermissionRequest } from '../../../src/shared/model.js';
import type { FleetState } from '../../../src/shared/protocol.js';
import { useChartTheme } from '../charts/chart-theme.js';
import { useNow } from '../clock.js';
import { ConfirmBar } from '../components/confirm-bar.js';
import type { SortState } from '../components/data-table.js';
import { EmptyState } from '../components/empty-state.js';
import { Icon } from '../components/icon.js';
import { isBoolean, isString, isStringArray } from '../guards.js';
import { usePersistentState, usePostAction } from '../vscode-context.js';

import type { ProjectAction, RowEvent } from './fleet-actions.js';
import { filterTree } from './fleet-filter.js';
import type { PermissionChoice } from './fleet-header.js';
import { FleetHeader, PermissionBanner } from './fleet-header.js';
import { historySamples, useRowHistory } from './fleet-history.js';
import type { FleetCommand } from './fleet-keys.js';
import { keyCommand } from './fleet-keys.js';
import type { FleetRow, VisibleRow } from './fleet-rows.js';
import {
  buildFleetTree,
  collapsedGroupOf,
  DEFAULT_SORT,
  flattenTree,
  isSortState,
  nextFleetSort,
  sortTree,
} from './fleet-rows.js';
import { FleetTable } from './fleet-table.js';
import { FleetViewMenu } from './fleet-view-menu.js';

type ConfirmKind = 'interrupt' | 'stop' | 'remove';

interface PendingConfirm {
  readonly kind: ConfirmKind;
  readonly row: FleetRow;
}

/** What the confirm bar asks, its button, and the host action it posts. */
const CONFIRMS = {
  interrupt: { verb: 'Interrupt', action: 'interrupt' },
  stop: { verb: 'Stop', action: 'stop' },
  remove: { verb: 'Remove', action: 'removeSession' },
} as const satisfies Record<
  ConfirmKind,
  { readonly verb: string; readonly action: 'interrupt' | 'stop' | 'removeSession' }
>;

function confirmMessage(confirm: PendingConfirm): string {
  const title = `"${confirm.row.sessionTitle}"`;
  if (confirm.kind !== 'remove') {
    return `${CONFIRMS[confirm.kind].verb} ${title}?`;
  }
  return confirm.row.state === 'running' || confirm.row.state === 'waiting'
    ? `Stop ${title} and remove it from the fleet?`
    : `Remove ${title} from the fleet?`;
}

const NO_KEYS: readonly string[] = [];

/** The host action each project row button posts. */
const PROJECT_ACTIONS = {
  newSession: 'newProjectSession',
  openFolder: 'openProjectFolder',
  setFolder: 'setProjectFolder',
  rename: 'renameProject',
  delete: 'deleteProject',
} as const satisfies Record<ProjectAction, string>;

function useFleetPreferences(): {
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
} {
  const [sort, setSort] = usePersistentState<SortState>('fleet.sort', DEFAULT_SORT, isSortState);
  const [filter, setFilter] = usePersistentState('fleet.filter', '', isString);
  const [hideDone, setHideDone] = usePersistentState('fleet.hideDone', false, isBoolean);
  const [collapsed, setCollapsed] = usePersistentState('fleet.collapsed', NO_KEYS, isStringArray);
  const [grouped, setGrouped] = usePersistentState('fleet.groupByProject', true, isBoolean);
  const [showSummary, setShowSummary] = usePersistentState('fleet.showSummary', true, isBoolean);
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
  };
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

  const tree = useMemo(
    () => buildFleetTree(state, preferences.grouped),
    [state, preferences.grouped],
  );
  const history = useRowHistory(historySamples(tree), state);
  const filtered = filterTree(tree, { text: preferences.filter, hideDone: preferences.hideDone });
  const collapsed = new Set(preferences.collapsed);
  const rows = flattenTree(sortTree(filtered, preferences.sort, now), collapsed);
  const selectedKey = rows.some((row) => row.row.key === selected)
    ? selected
    : (rows[0]?.row.key ?? null);

  const setExpanded = (key: string, expanded: boolean): void => {
    const others = preferences.collapsed.filter((item) => item !== key);
    preferences.setCollapsed(expanded ? others : [...others, key]);
  };

  // Open the project row hiding a session. It runs only when the focused
  // terminal changes, so a project the user folds later stays folded.
  const reveal = useEffectEvent((key: string) => {
    const group = collapsedGroupOf(tree, key, collapsed);
    if (group !== null) {
      setExpanded(group, true);
    }
  });

  // Follow the focused terminal: select its session and bring the row into
  // view, but leave keyboard focus in the terminal.
  useEffect(() => {
    if (state.activeSessionId !== null) {
      following.current = `s:${state.activeSessionId}`;
      setSelected(following.current);
      reveal(following.current);
    }
  }, [state.activeSessionId, state.activeVersion]);

  useEffect(() => {
    if (navigating.current) {
      navigating.current = false;
      selectedRef.current?.focus();
    } else if (following.current === selectedKey) {
      following.current = null;
      selectedRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedKey]);

  // A session opens where it runs (its terminal tab, or an attach tab for a
  // background session). A subagent has no terminal, so it opens its view.
  // A project has nothing to open, so it folds.
  const activate = (row: FleetRow): void => {
    setSelected(row.key);
    if (row.kind === 'project') {
      setExpanded(row.key, collapsed.has(row.key));
      return;
    }
    post(
      row.kind === 'session'
        ? { type: 'openSession', sessionId: row.sessionId }
        : { type: 'openAgent', sessionId: row.sessionId, agentId: row.agentId },
    );
  };

  const onAction = (row: FleetRow, action: RowEvent): void => {
    setSelected(row.key);
    switch (action) {
      case 'open': {
        post({ type: 'openAgent', sessionId: row.sessionId, agentId: row.agentId });
        break;
      }
      case 'context': {
        const agentId = row.kind === 'session' ? null : row.agentId;
        post({ type: 'openContext', sessionId: row.sessionId, agentId });
        break;
      }
      case 'move': {
        post({ type: 'moveSession', sessionId: row.sessionId });
        break;
      }
      case 'relocate': {
        post({ type: 'continueInFolder', sessionId: row.sessionId });
        break;
      }
      case 'combine': {
        post({ type: 'combineSessions', sessionId: row.sessionId });
        break;
      }
      case 'properties': {
        post({ type: 'openProperties', sessionId: row.sessionId });
        break;
      }
      case 'interrupt':
      case 'stop':
      case 'remove': {
        setConfirm({ kind: action, row });
        break;
      }
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
      case 'move': {
        post({ type: 'moveSession', sessionId: command.row.sessionId });
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
        <label
          className="filter"
          data-tip="Show only rows whose title, state, model, tool or folder has this text"
        >
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
        <button
          type="button"
          className="open-project"
          data-tip="Pick a project to start a session in, open in a new window, or add to this one"
          onClick={() => {
            post({ type: 'openProject' });
          }}
        >
          <Icon name="openFolder" />
          <span className="toolbar-label">Open project</span>
        </button>
        <FleetViewMenu
          hiding={preferences.hideDone ? ['done hidden'] : []}
          choices={[
            {
              label: 'Hide done',
              tip: 'Leave out sessions that have finished',
              checked: preferences.hideDone,
              onChange: preferences.setHideDone,
            },
            {
              label: 'Group by project',
              tip: 'Nest sessions under the project they belong to',
              checked: preferences.grouped,
              onChange: preferences.setGrouped,
            },
            {
              label: 'Show working on',
              tip: 'Show a line under each session on what it is doing',
              checked: preferences.showSummary,
              onChange: preferences.setShowSummary,
            },
          ]}
        />
      </div>
      {confirm === null ? null : (
        <ConfirmBar
          message={confirmMessage(confirm)}
          confirmLabel={CONFIRMS[confirm.kind].verb}
          onConfirm={() => {
            post({ type: CONFIRMS[confirm.kind].action, sessionId: confirm.row.sessionId });
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
          showSummary={preferences.showSummary}
          onSelect={setSelected}
          onActivate={activate}
          onKey={onKey}
          onToggle={(visible: VisibleRow) => {
            setExpanded(visible.row.key, !visible.expanded);
          }}
          onAction={onAction}
          onProjectAction={(projectId: string, action: ProjectAction) => {
            post({ type: PROJECT_ACTIONS[action], projectId });
          }}
        />
      )}
    </section>
  );
}
