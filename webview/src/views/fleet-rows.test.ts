import { describe, expect, it } from 'vitest';

import type { FleetState } from '../../../src/shared/protocol.js';
import { agent, fleetState, NOW, session } from '../../test/fixtures.js';

import type { FleetNode, FleetRow } from './fleet-rows.js';
import {
  buildFleetTree,
  DEFAULT_SORT,
  elapsedMs,
  filterTree,
  flattenTree,
  isSortState,
  normalizeRatio,
  rowCallsPerMinute,
  rowMatches,
  sortTree,
} from './fleet-rows.js';

function keys(nodes: readonly FleetNode[]): string[] {
  return nodes.map((node) => node.row.key);
}

function firstRow(nodes: readonly FleetNode[]): FleetRow {
  const node = nodes[0];
  if (node === undefined) {
    throw new Error('no rows');
  }
  return node.row;
}

function only(state: Partial<FleetState>): FleetState {
  return { ...fleetState, ...state };
}

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
      sessionId: 's1',
      agentId: 's1',
      sessionTitle: 'Refactor parser',
      sessionActive: true,
      state: 'running',
      surface: 'cli',
      title: 'Refactor parser',
      detail: '/Users/dev/repos/s1',
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
    });
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
      currentTool: 'Grep',
      toolCalls: 12,
      effort: null,
      contextFill: null,
      costUsd: null,
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

  it('sorts by state rank by default, waiting first', () => {
    expect(keys(sortTree(tree, DEFAULT_SORT, NOW))).toStrictEqual(['s:s2', 's:s1', 's:s3']);
  });

  it.each([
    ['surface', ['s:s1', 's:s2', 's:s3']],
    ['title', ['s:s3', 's:s1', 's:s2']],
    ['model', ['s:s3', 's:s1', 's:s2']],
    ['effort', ['s:s2', 's:s1', 's:s3']],
    ['elapsed', ['s:s1', 's:s2', 's:s3']],
    ['tool', ['s:s2', 's:s3', 's:s1']],
    ['calls', ['s:s3', 's:s2', 's:s1']],
    ['tokens', ['s:s3', 's:s1', 's:s2']],
    ['cache', ['s:s3', 's:s1', 's:s2']],
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

describe('isSortState', () => {
  it('accepts only a column name and a direction', () => {
    expect(isSortState({ column: 'cost', descending: true })).toBe(true);
    expect(isSortState({ column: 'cost' })).toBe(false);
    expect(isSortState({ column: 3, descending: true })).toBe(false);
    expect(isSortState('cost')).toBe(false);
  });
});
