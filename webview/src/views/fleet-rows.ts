// Pure logic for the fleet tree: build project, session and subagent rows,
// sort, filter and flatten them for display.

import type {
  AgentNode,
  SessionPlace,
  SessionState,
  SessionSummary,
  Surface,
} from '../../../src/shared/model.js';
import { sessionName } from '../../../src/shared/model.js';
import type { FleetState, ProjectSummary, SessionProject } from '../../../src/shared/protocol.js';
import type { SortState } from '../components/data-table.js';
import { plural } from '../format.js';
import { isBoolean, isRecord, isString } from '../guards.js';
import { PLACE_INFO, STATE_RANK, SURFACE_LABELS } from '../labels.js';
import { cacheHitRatio, callsPerMinute, promptTokens } from '../metrics.js';

import { workingOn } from './working-on.js';

export interface FleetRow {
  readonly key: string;
  readonly kind: 'project' | 'session' | 'agent';
  readonly sessionId: string;
  readonly agentId: string;
  readonly sessionTitle: string;
  /** False once the session is done or failed, so stop and interrupt make no sense. */
  readonly sessionActive: boolean;
  readonly state: SessionState;
  readonly surface: Surface;
  /** Where the session's process runs, null for agents and sessions with no live process. */
  readonly place: SessionPlace | null;
  readonly title: string;
  readonly detail: string;
  /** On a session's row, one line on what it is working on, or null while nothing says. */
  readonly summary: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly currentTool: string | null;
  readonly toolCalls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheHit: number | null;
  readonly contextFill: number | null;
  readonly costUsd: number | null;
  /** The row's project, or null in Unassigned. */
  readonly projectId: string | null;
  /** A session in no project that should get one, or the Unassigned row holding one. */
  readonly needsProject: boolean;
  /** On the row of a project made by hand, its id, since only those can be renamed and deleted. */
  readonly manualProjectId: string | null;
  /** On a project's row, the folder that opens in the window, or null while it has none. */
  readonly projectFolder: string | null;
}

export interface FleetNode {
  readonly row: FleetRow;
  readonly children: readonly FleetNode[];
}

export interface VisibleRow {
  readonly row: FleetRow;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly parentKey: string | null;
}

/**
 * Start order, oldest first. A row keeps its place while its state changes and
 * new sessions join at the bottom, so nothing moves under the pointer.
 */
export const DEFAULT_SORT: SortState = { column: 'started', descending: false };

function isActive(state: SessionState): boolean {
  return state !== 'done' && state !== 'failed';
}

function sessionRow(
  session: SessionSummary,
  agents: readonly AgentNode[],
  place: SessionPlace | null,
  project: SessionProject | undefined,
): FleetRow {
  const main = agents.find((agent) => agent.id === session.id);
  const busy = agents.find((agent) => agent.state === 'running' && agent.currentTool !== null);
  const title = sessionName(session);
  return {
    key: `s:${session.id}`,
    kind: 'session',
    sessionId: session.id,
    agentId: session.id,
    sessionTitle: title,
    sessionActive: isActive(session.state),
    state: session.state,
    surface: session.surface,
    place,
    title,
    detail: session.cwd,
    summary: workingOn(session),
    model: session.model,
    effort: session.effort,
    startedAt: session.startedAt,
    endedAt: isActive(session.state) ? null : session.updatedAt,
    currentTool: main?.currentTool ?? busy?.currentTool ?? null,
    toolCalls: agents.reduce((sum, agent) => sum + agent.toolCallCount, 0),
    tokensIn: promptTokens(session.usage),
    tokensOut: session.usage.output,
    cacheHit: cacheHitRatio(session.usage),
    contextFill: session.contextFill,
    costUsd: session.costUsd,
    projectId: project?.projectId ?? null,
    needsProject: project?.projectId === null && !project.ignored,
    manualProjectId: null,
    projectFolder: null,
  };
}

function agentRow(agent: AgentNode, session: FleetRow): FleetRow {
  return {
    key: `a:${agent.sessionId}:${agent.id}`,
    kind: 'agent',
    sessionId: agent.sessionId,
    agentId: agent.id,
    sessionTitle: session.sessionTitle,
    sessionActive: session.sessionActive,
    state: agent.state,
    surface: session.surface,
    place: null,
    title: agent.agentType,
    detail: agent.description,
    summary: null,
    model: agent.model,
    effort: null,
    startedAt: agent.startedAt,
    endedAt: agent.endedAt,
    currentTool: agent.currentTool,
    toolCalls: agent.toolCallCount,
    tokensIn: promptTokens(agent.usage),
    tokensOut: agent.usage.output,
    cacheHit: cacheHitRatio(agent.usage),
    contextFill: null,
    costUsd: null,
    projectId: session.projectId,
    needsProject: false,
    manualProjectId: null,
    projectFolder: null,
  };
}

interface TreeContext {
  readonly all: readonly AgentNode[];
  readonly visited: Set<string>;
  readonly session: FleetRow;
}

function agentNodes(level: readonly AgentNode[], context: TreeContext): FleetNode[] {
  const nodes: FleetNode[] = [];
  for (const agent of level) {
    if (context.visited.has(agent.id)) {
      continue;
    }
    context.visited.add(agent.id);
    const children = context.all.filter((child) => child.parentAgentId === agent.id);
    nodes.push({ row: agentRow(agent, context.session), children: agentNodes(children, context) });
  }
  return nodes;
}

function sessionNode(
  session: SessionSummary,
  agents: readonly AgentNode[],
  place: SessionPlace | null,
  project: SessionProject | undefined,
): FleetNode {
  const row = sessionRow(session, agents, place, project);
  const subagents = agents.filter((agent) => agent.id !== session.id);
  const ids = new Set(subagents.map((agent) => agent.id));
  const roots = subagents.filter(
    (agent) => agent.parentAgentId === null || !ids.has(agent.parentAgentId),
  );
  const context: TreeContext = { all: subagents, visited: new Set([session.id]), session: row };
  const children = agentNodes(roots, context);
  // Agents in a parent cycle are never reached from a root, so list them at the top.
  const stranded = subagents.filter((agent) => !context.visited.has(agent.id));
  return { row, children: [...children, ...agentNodes(stranded, context)] };
}

/** The key of a project's row. Unassigned, with no project, is "p:". */
export function projectKey(projectId: string | null): string {
  return `p:${projectId ?? ''}`;
}

const UNASSIGNED_TITLE = 'Unassigned';

function total(values: readonly number[]): number {
  let result = 0;
  for (const value of values) {
    result += value;
  }
  return result;
}

/** The most urgent state among rows, done when there are none. */
function mostUrgent(rows: readonly FleetRow[]): SessionState {
  let best: SessionState = 'done';
  for (const row of rows) {
    if (STATE_RANK[row.state] < STATE_RANK[best]) {
      best = row.state;
    }
  }
  return best;
}

/** What a project's row knows about the project itself. Unassigned has none of it. */
function projectFields(
  project: ProjectSummary | null,
): Pick<FleetRow, 'projectId' | 'manualProjectId' | 'projectFolder'> {
  return {
    projectId: project?.id ?? null,
    manualProjectId: project?.kind === 'manual' ? project.id : null,
    projectFolder: project?.folder ?? null,
  };
}

/** A project's row: the most urgent state of its sessions and their totals. */
function projectRow(project: ProjectSummary | null, nodes: readonly FleetNode[]): FleetRow {
  const rows = nodes.map((node) => node.row);
  const title = project?.name ?? UNASSIGNED_TITLE;
  const costs = rows.flatMap((row) => (row.costUsd === null ? [] : [row.costUsd]));
  return {
    key: projectKey(project?.id ?? null),
    kind: 'project',
    sessionId: '',
    agentId: '',
    sessionTitle: title,
    sessionActive: false,
    state: mostUrgent(rows),
    surface: 'cli',
    place: null,
    title,
    detail: project?.folder ?? plural(rows.length, 'session'),
    summary: null,
    model: null,
    effort: null,
    startedAt: Math.min(...rows.map((row) => row.startedAt)),
    endedAt: null,
    currentTool: null,
    toolCalls: total(rows.map((row) => row.toolCalls)),
    tokensIn: total(rows.map((row) => row.tokensIn)),
    tokensOut: total(rows.map((row) => row.tokensOut)),
    cacheHit: null,
    contextFill: null,
    costUsd: costs.length === 0 ? null : total(costs),
    needsProject: rows.some((row) => row.needsProject),
    ...projectFields(project),
  };
}

/**
 * Sessions under one row per project, Unassigned first and the rest by name.
 * A session whose project is not in the list waits in Unassigned.
 */
function groupByProject(sessions: readonly FleetNode[], state: FleetState): FleetNode[] {
  const byId = new Map(state.projects.map((project) => [project.id, project]));
  const groups = new Map<ProjectSummary | null, FleetNode[]>();
  for (const node of sessions) {
    const project = byId.get(node.row.projectId ?? '') ?? null;
    groups.set(project, [...(groups.get(project) ?? []), node]);
  }
  return [...groups]
    .map(([project, children]) => ({ row: projectRow(project, children), children }))
    .toSorted(
      (left, right) =>
        Number(left.row.projectId !== null) - Number(right.row.projectId !== null) ||
        left.row.title.localeCompare(right.row.title),
    );
}

/**
 * One node per session, with its subagents nested by parent agent id. Grouped,
 * the sessions sit under a row for their project.
 */
export function buildFleetTree(state: FleetState, grouped = false): FleetNode[] {
  const sessions = state.sessions.map((session) =>
    sessionNode(
      session,
      state.agents.filter((agent) => agent.sessionId === session.id),
      state.places[session.id] ?? null,
      state.sessionProjects[session.id],
    ),
  );
  return grouped ? groupByProject(sessions, state) : sessions;
}

function placeLabel(row: FleetRow): string {
  return row.place === null ? '' : PLACE_INFO[row.place].label;
}

export function elapsedMs(row: FleetRow, now: number): number {
  return (row.endedAt ?? now) - row.startedAt;
}

export function rowCallsPerMinute(row: FleetRow, now: number): number {
  return callsPerMinute(row.toolCalls, row.startedAt, row.endedAt ?? now);
}

type Sorter = (row: FleetRow, now: number) => number | string;

const SORTERS: Readonly<Record<string, Sorter>> = {
  started: (row) => row.startedAt,
  state: (row) => STATE_RANK[row.state],
  surface: (row) => `${SURFACE_LABELS[row.surface]} ${placeLabel(row)}`,
  title: (row) => row.title.toLowerCase(),
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
 * done rows at every level first.
 */
export function filterTree(nodes: readonly FleetNode[], filter: FleetFilter): FleetNode[] {
  const needle = filter.text.trim().toLowerCase();
  const visit = (level: readonly FleetNode[], inherited: boolean): FleetNode[] =>
    level.flatMap((node) => {
      if (filter.hideDone && node.row.state === 'done') {
        return [];
      }
      const matched = inherited || rowMatches(node.row, needle);
      const children = visit(node.children, matched);
      return matched || children.length > 0 ? [{ row: node.row, children }] : [];
    });
  return visit(nodes, needle === '');
}

interface FlattenContext {
  readonly collapsed: ReadonlySet<string>;
  readonly out: VisibleRow[];
}

function flattenLevel(
  nodes: readonly FleetNode[],
  depth: number,
  parentKey: string | null,
  context: FlattenContext,
): void {
  for (const node of nodes) {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && !context.collapsed.has(node.row.key);
    context.out.push({ row: node.row, depth, hasChildren, expanded, parentKey });
    if (expanded) {
      flattenLevel(node.children, depth + 1, node.row.key, context);
    }
  }
}

/** Rows in display order, skipping children of collapsed rows. */
export function flattenTree(
  nodes: readonly FleetNode[],
  collapsed: ReadonlySet<string>,
): VisibleRow[] {
  const out: VisibleRow[] = [];
  flattenLevel(nodes, 0, null, { collapsed, out });
  return out;
}

/** The collapsed project row hiding the row with this key, or null when it shows. */
export function collapsedGroupOf(
  nodes: readonly FleetNode[],
  key: string,
  collapsed: ReadonlySet<string>,
): string | null {
  const group = nodes.find(
    (node) => node.row.kind === 'project' && node.children.some((child) => child.row.key === key),
  );
  return group !== undefined && collapsed.has(group.row.key) ? group.row.key : null;
}

/** Rate limits may arrive as 0 to 1 or 0 to 100. Read anything over 1 as a percent. */
export function normalizeRatio(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  return value > 1 ? value / 100 : value;
}

/** Header clicks go ascending, descending, then back to start order. */
export function nextFleetSort(current: SortState, column: string): SortState {
  if (current.column === column && current.descending) {
    return DEFAULT_SORT;
  }
  return { column, descending: current.column === column };
}

export function isSortState(value: unknown): value is SortState {
  return isRecord(value) && isString(value['column']) && isBoolean(value['descending']);
}
