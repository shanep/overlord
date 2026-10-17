import { describe, expect, it } from 'vitest';

import type { FleetState } from '../../../src/shared/protocol.js';
import { agent, fleetState, NOW, projectFleet, session } from '../../test/fixtures.js';

import { filterTree, rowMatches } from './fleet-filter.js';
import type { FleetNode, FleetRow } from './fleet-rows.js';
import {
  buildFleetTree,
  collapsedGroupOf,
  DEFAULT_SORT,
  elapsedMs,
  flattenTree,
  isSortState,
  nextFleetSort,
  normalizeRatio,
  rowCallsPerMinute,
  projectKey,
} from './fleet-rows.js';
import { sortTree } from './fleet-sort.js';

function keys(nodes: readonly FleetNode[]): string[] {
  return nodes.map((node) => node.row.key);
}

function idleNode(base: FleetRow, key: string, startedAt: number): FleetNode {
  return { row: { ...base, key, startedAt, state: 'idle' }, children: [] };
}

function firstRow(nodes: readonly FleetNode[]): FleetRow {
  const node = nodes[0];
  if (node === undefined) {
    throw new Error('no rows');
  }
  return node.row;
}

function sessionRows(state: FleetState): FleetRow[] {
  return buildFleetTree(state).map((node) => node.row);
}

function only(state: Partial<FleetState>): FleetState {
  return { ...fleetState, ...state };
}

describe('buildFleetTree grouped by project', () => {
  it('puts Unassigned first, then projects with sessions by name', () => {
    const tree = buildFleetTree(projectFleet, true);
    expect(keys(tree)).toStrictEqual(['p:', 'p:m1', 'p:git:/r/web']);
    expect(tree.map((node) => keys(node.children))).toStrictEqual([['s:s2'], ['s:s3'], ['s:s1']]);
    expect(projectKey(null)).toBe('p:');
  });

  it('marks sessions that need a project, and not ignored or unchecked ones', () => {
    expect(sessionRows(projectFleet).map((row) => [row.projectId, row.needsProject])).toStrictEqual(
      [
        ['git:/r/web', false],
        [null, true],
        ['m1', false],
      ],
    );
    const ignored = only({
      sessionProjects: { s2: { projectId: null, folder: '/notes', ignored: true } },
    });
    expect(sessionRows(ignored).map((row) => row.needsProject)).toStrictEqual([
      false,
      false,
      false,
    ]);
  });

  it('sums each project and takes its most urgent state', () => {
    const [unassigned, course, web] = buildFleetTree(projectFleet, true).map((node) => node.row);
    expect(unassigned).toMatchObject({
      kind: 'project',
      title: 'Unassigned',
      detail: '1 session',
      projectId: null,
      needsProject: true,
      manualProjectId: null,
      sessionActive: false,
    });
    expect(course).toMatchObject({
      title: 'Course',
      state: 'done',
      manualProjectId: 'm1',
      projectFolder: null,
    });
    expect(web).toMatchObject({
      title: 'web',
      detail: '/r/web',
      projectFolder: '/r/web',
      state: 'running',
      tokensIn: 98_000,
      tokensOut: 3400,
      toolCalls: 46,
      costUsd: 1.25,
      cacheHit: null,
    });
    const both = only({
      ...projectFleet,
      sessionProjects: {},
      sessions: [session({ id: 'x', costUsd: null }), session({ id: 'y', costUsd: null })],
      agents: [],
    });
    expect(buildFleetTree(both, true).map((node) => node.row)).toMatchObject([
      { key: 'p:', detail: '2 sessions', costUsd: null, needsProject: false },
    ]);
  });

  it('lists a project in the workspace even with no sessions', () => {
    const state = only({ ...projectFleet, workspaceProjects: ['m2', 'git:/r/web'] });
    const tree = buildFleetTree(state, true);
    expect(keys(tree)).toStrictEqual(['p:', 'p:m1', 'p:m2', 'p:git:/r/web']);
    expect(tree.map((node) => node.row.inWorkspace)).toStrictEqual([false, false, true, true]);
    expect(tree[2]).toMatchObject({
      row: { title: 'Empty', detail: '0 sessions', state: 'done', startedAt: 0 },
      children: [],
    });
    expect(keys(buildFleetTree(state))).toStrictEqual(['s:s1', 's:s2', 's:s3']);
  });

  it('keeps a project in the workspace when hide done hides all its sessions', () => {
    const state = only({ ...projectFleet, workspaceProjects: ['m1', 'm2'] });
    const result = filterTree(buildFleetTree(state, true), { text: '', hideDone: true });
    expect(keys(result)).toStrictEqual(['p:', 'p:m1', 'p:m2', 'p:git:/r/web']);
    expect(result[1]?.children).toStrictEqual([]);
    const away = filterTree(buildFleetTree(projectFleet, true), { text: '', hideDone: true });
    expect(keys(away)).toStrictEqual(['p:', 'p:git:/r/web']);
    const typed = filterTree(buildFleetTree(state, true), { text: 'web', hideDone: true });
    expect(keys(typed)).toStrictEqual(['p:git:/r/web']);
  });

  it('puts a session whose project is gone in Unassigned', () => {
    const state = only({
      ...projectFleet,
      sessionProjects: { s1: { projectId: 'gone', folder: '/x', ignored: false } },
    });
    expect(keys(buildFleetTree(state, true))).toStrictEqual(['p:']);
  });

  it('keeps project order when sorting and sorts the sessions inside', () => {
    const tree = buildFleetTree(projectFleet, true);
    const sortedTree = sortTree(tree, { column: 'title', descending: true }, NOW);
    expect(keys(sortedTree)).toStrictEqual(['p:', 'p:m1', 'p:git:/r/web']);
  });

  it('matches a project on its name and folder only', () => {
    const tree = buildFleetTree(projectFleet, true);
    const web = firstRow(tree.slice(2));
    expect(rowMatches(web, '/r/web')).toBe(true);
    expect(rowMatches(web, 'cli')).toBe(false);
    expect(rowMatches(firstRow(tree), 'unassigned')).toBe(true);
  });

  it('finds the collapsed project row hiding a session', () => {
    const tree = buildFleetTree(projectFleet, true);
    expect(collapsedGroupOf(tree, 's:s2', new Set(['p:']))).toBe('p:');
    expect(collapsedGroupOf(tree, 's:s2', new Set())).toBeNull();
    expect(collapsedGroupOf(tree, 'p:', new Set(['p:']))).toBeNull();
    expect(collapsedGroupOf(buildFleetTree(projectFleet), 's:s2', new Set(['s:s2']))).toBeNull();
  });
});

describe('buildFleetTree', () => {
  const tree = buildFleetTree(fleetState);

  it('makes one node per session with subagents nested by parent', () => {
    expect(keys(tree)).toStrictEqual(['s:s1', 's:s2', 's:s3']);
    const s1 = tree[0];
    expect(keys(s1?.children ?? [])).toStrictEqual(['a:s1:a1']);
    expect(keys(s1?.children[0]?.children ?? [])).toStrictEqual(['a:s1:a2']);
    expect(tree[1]?.children).toStrictEqual([]);
  });

  it('fills session rows from the summary and the main thread', () => {
    const row = firstRow(tree);
    expect(row).toStrictEqual({
      key: 's:s1',
      kind: 'session',
      agent: 'claude-code',
      sessionId: 's1',
      agentId: 's1',
      sessionTitle: 'Refactor parser',
      sessionActive: true,
      state: 'running',
      surface: 'cli',
      place: 'vscode',
      title: 'Refactor parser',
      detail: '/Users/dev/repos/s1',
      summary: null,
      failure: null,
      model: 'claude-opus-4-7',
      effort: 'high',
      startedAt: NOW - 600_000,
      endedAt: null,
      currentTool: 'Edit',
      toolCalls: 46,
      tokensIn: 98_000,
      tokensOut: 3400,
      cacheHit: 80_000 / 98_000,
      contextFill: 0.82,
      costUsd: 1.25,
      projectId: null,
      needsProject: false,
      manualProjectId: null,
      projectFolder: null,
      inWorkspace: false,
      health: null,
      launched: false,
      progress: fleetState.progress['s1'],
    });
    const health = { level: 'watch', score: 0.4, signals: [] } as const;
    const worn = buildFleetTree({ ...fleetState, health: { s1: health } });
    expect(firstRow(worn).health).toBe(health);
  });

  it('fills agent rows from the agent and inherits the session surface', () => {
    const row = tree[0]?.children[0]?.row;
    expect(row).toMatchObject({
      key: 'a:s1:a1',
      kind: 'agent',
      sessionId: 's1',
      agentId: 'a1',
      sessionTitle: 'Refactor parser',
      title: 'Explore',
      detail: 'Find parser tests',
      surface: 'cli',
      place: null,
      currentTool: 'Grep',
      toolCalls: 12,
      effort: null,
      contextFill: null,
      costUsd: 0.3,
    });
  });

  it('marks finished sessions inactive with an end time', () => {
    const row = tree[2]?.row;
    expect(row?.sessionActive).toBe(false);
    expect(row?.endedAt).toBe(NOW - 60_000);
    expect(row?.cacheHit).toBeNull();
    expect(row?.toolCalls).toBe(0);
    expect(row?.currentTool).toBeNull();
  });

  it('uses the cwd when the title is empty', () => {
    const state = only({ sessions: [session({ id: 'z', title: '' })], agents: [] });
    expect(firstRow(buildFleetTree(state)).title).toBe('/Users/dev/repos/z');
  });

  it('falls back to a running subagent tool when the main thread is idle', () => {
    const state = only({
      sessions: [session({ id: 'z' })],
      agents: [
        agent({ id: 'z', sessionId: 'z', currentTool: null }),
        agent({ id: 'b', sessionId: 'z', parentAgentId: 'z', currentTool: 'WebFetch' }),
      ],
    });
    expect(firstRow(buildFleetTree(state)).currentTool).toBe('WebFetch');
  });

  it('puts orphans at the top level and survives parent cycles', () => {
    const state = only({
      sessions: [session({ id: 'z' })],
      agents: [
        agent({ id: 'orphan', sessionId: 'z', parentAgentId: 'gone' }),
        agent({ id: 'c1', sessionId: 'z', parentAgentId: 'c2' }),
        agent({ id: 'c2', sessionId: 'z', parentAgentId: 'c1' }),
        agent({ id: 'other', sessionId: 'elsewhere' }),
      ],
    });
    const node = buildFleetTree(state)[0];
    expect(keys(node?.children ?? [])).toStrictEqual(['a:z:orphan', 'a:z:c1']);
    expect(keys(node?.children[1]?.children ?? [])).toStrictEqual(['a:z:c2']);
    expect(node?.children[1]?.children[0]?.children).toStrictEqual([]);
  });
});

describe('row metrics', () => {
  const row = firstRow(buildFleetTree(fleetState));

  it('measures elapsed time to now or to the end', () => {
    expect(elapsedMs(row, NOW)).toBe(600_000);
    expect(elapsedMs({ ...row, endedAt: NOW - 300_000 }, NOW)).toBe(300_000);
  });

  it('averages tool calls per minute', () => {
    expect(rowCallsPerMinute(row, NOW)).toBeCloseTo(4.6);
  });
});

describe('sortTree', () => {
  const tree = buildFleetTree(fleetState);

  it('keeps start order by default, oldest first', () => {
    expect(keys(sortTree(tree, DEFAULT_SORT, NOW))).toStrictEqual(['s:s3', 's:s2', 's:s1']);
  });

  it('keeps a row in place when its state changes', () => {
    const before = keys(sortTree(tree, DEFAULT_SORT, NOW));
    const flipped = tree.map((node) => ({
      ...node,
      row: { ...node.row, state: 'running' as const },
    }));
    expect(keys(sortTree(flipped, DEFAULT_SORT, NOW))).toStrictEqual(before);
  });

  it('breaks ties by start time, then key, whatever order rows arrive in', () => {
    const base = firstRow(tree);
    const nodes = [idleNode(base, 's:b', 2), idleNode(base, 's:c', 1), idleNode(base, 's:a', 2)];
    const expected = ['s:c', 's:a', 's:b'];
    expect(keys(sortTree(nodes, { column: 'state', descending: false }, NOW))).toStrictEqual(
      expected,
    );
    expect(
      keys(sortTree(nodes.toReversed(), { column: 'state', descending: true }, NOW)),
    ).toStrictEqual(expected);
  });

  it.each([
    ['surface', ['s:s1', 's:s2', 's:s3']],
    ['title', ['s:s3', 's:s1', 's:s2']],
    ['model', ['s:s3', 's:s1', 's:s2']],
    ['effort', ['s:s2', 's:s3', 's:s1']],
    ['elapsed', ['s:s1', 's:s2', 's:s3']],
    ['tool', ['s:s3', 's:s2', 's:s1']],
    ['calls', ['s:s3', 's:s2', 's:s1']],
    ['tokens', ['s:s3', 's:s2', 's:s1']],
    ['cache', ['s:s3', 's:s2', 's:s1']],
    ['context', ['s:s3', 's:s1', 's:s2']],
    ['cost', ['s:s3', 's:s2', 's:s1']],
  ])('sorts ascending by %s', (column, expected) => {
    expect(keys(sortTree(tree, { column, descending: false }, NOW))).toStrictEqual(expected);
  });

  it('sorts descending and sorts children too', () => {
    const state = only({
      sessions: [session({ id: 'z' })],
      agents: [
        agent({ id: 'b', sessionId: 'z', agentType: 'Beta' }),
        agent({ id: 'a', sessionId: 'z', agentType: 'Alpha' }),
      ],
    });
    const sorted = sortTree(buildFleetTree(state), { column: 'title', descending: false }, NOW);
    expect(keys(sorted[0]?.children ?? [])).toStrictEqual(['a:z:a', 'a:z:b']);
    const reversed = sortTree(tree, { column: 'cost', descending: true }, NOW);
    expect(keys(reversed)).toStrictEqual(['s:s1', 's:s2', 's:s3']);
  });

  it('leaves the order alone for an unknown column', () => {
    expect(sortTree(tree, { column: 'nope', descending: false }, NOW)).toBe(tree);
  });
});

describe('filterTree', () => {
  const tree = buildFleetTree(fleetState);

  it('keeps everything for an empty filter', () => {
    expect(filterTree(tree, { text: '  ', hideDone: false })).toStrictEqual(tree);
  });

  it('keeps a matching session with its whole subtree', () => {
    const result = filterTree(tree, { text: 'PARSER', hideDone: false });
    expect(keys(result)).toStrictEqual(['s:s1']);
    expect(keys(result[0]?.children ?? [])).toStrictEqual(['a:s1:a1']);
    expect(keys(result[0]?.children[0]?.children ?? [])).toStrictEqual(['a:s1:a2']);
  });

  it('keeps a session for a matching descendant, with only that branch', () => {
    const result = filterTree(tree, { text: 'fixtures', hideDone: false });
    expect(keys(result)).toStrictEqual(['s:s1']);
    expect(keys(result[0]?.children ?? [])).toStrictEqual(['a:s1:a1']);
    expect(keys(result[0]?.children[0]?.children ?? [])).toStrictEqual(['a:s1:a2']);
  });

  it('hides done rows at every level', () => {
    const result = filterTree(tree, { text: '', hideDone: true });
    expect(keys(result)).toStrictEqual(['s:s1', 's:s2']);
    expect(result[0]?.children[0]?.children).toStrictEqual([]);
  });

  it('matches on surface label, state, model and tool', () => {
    const row = firstRow(tree);
    expect(rowMatches(row, 'cli')).toBe(true);
    expect(rowMatches(row, 'running')).toBe(true);
    expect(rowMatches(row, 'opus')).toBe(true);
    expect(rowMatches(row, 'edit')).toBe(true);
    expect(rowMatches(row, 'zzz')).toBe(false);
    expect(rowMatches({ ...row, model: null, currentTool: null }, 'refactor')).toBe(true);
  });

  it('matches on where the session runs', () => {
    expect(rowMatches(firstRow(tree), 'vs code')).toBe(true);
    expect(rowMatches({ ...firstRow(tree), place: null }, 'vs code')).toBe(false);
    expect(keys(filterTree(tree, { text: 'background', hideDone: false }))).toStrictEqual(['s:s2']);
  });
});

describe('flattenTree', () => {
  const tree = buildFleetTree(fleetState);

  it('lists expanded rows depth first with depth and parent', () => {
    const rows = flattenTree(tree, new Set());
    expect(rows.map((row) => [row.row.key, row.depth, row.parentKey, row.expanded])).toStrictEqual([
      ['s:s1', 0, null, true],
      ['a:s1:a1', 1, 's:s1', true],
      ['a:s1:a2', 2, 'a:s1:a1', false],
      ['s:s2', 0, null, false],
      ['s:s3', 0, null, false],
    ]);
    expect(rows.map((row) => row.hasChildren)).toStrictEqual([true, true, false, false, false]);
  });

  it('skips the children of collapsed rows', () => {
    const rows = flattenTree(tree, new Set(['a:s1:a1']));
    expect(rows.map((row) => row.row.key)).toStrictEqual(['s:s1', 'a:s1:a1', 's:s2', 's:s3']);
    expect(rows[1]?.expanded).toBe(false);
    expect(rows[1]?.hasChildren).toBe(true);
  });
});

describe('normalizeRatio', () => {
  it('reads values over 1 as percents', () => {
    expect(normalizeRatio(null)).toBeNull();
    expect(normalizeRatio(0.64)).toBeCloseTo(0.64);
    expect(normalizeRatio(64)).toBeCloseTo(0.64);
  });
});

describe('nextFleetSort', () => {
  it('goes ascending, then descending, then back to start order', () => {
    const first = nextFleetSort(DEFAULT_SORT, 'cost');
    expect(first).toStrictEqual({ column: 'cost', descending: false });
    const second = nextFleetSort(first, 'cost');
    expect(second).toStrictEqual({ column: 'cost', descending: true });
    expect(nextFleetSort(second, 'cost')).toBe(DEFAULT_SORT);
  });

  it('starts a new column ascending', () => {
    expect(nextFleetSort({ column: 'cost', descending: true }, 'title')).toStrictEqual({
      column: 'title',
      descending: false,
    });
  });
});

describe('isSortState', () => {
  it('accepts only a column name and a direction', () => {
    expect(isSortState({ column: 'cost', descending: true })).toBe(true);
    expect(isSortState({ column: 'cost' })).toBe(false);
    expect(isSortState({ column: 3, descending: true })).toBe(false);
    expect(isSortState('cost')).toBe(false);
  });
});
