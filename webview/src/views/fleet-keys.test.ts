import { describe, expect, it } from 'vitest';

import { fleetState } from '../../test/fixtures.js';

import { keyCommand } from './fleet-keys.js';
import type { VisibleRow } from './fleet-rows.js';
import { buildFleetTree, flattenTree } from './fleet-rows.js';

const rows: readonly VisibleRow[] = flattenTree(buildFleetTree(fleetState), new Set(['a:s1:a1']));

function rowAt(index: number): VisibleRow {
  const row = rows[index];
  if (row === undefined) {
    throw new Error('missing row');
  }
  return row;
}

describe('keyCommand', () => {
  it('moves the selection with arrows, Home and End', () => {
    expect(keyCommand(rows, 's:s1', 'ArrowDown')).toStrictEqual({ type: 'select', key: 'a:s1:a1' });
    expect(keyCommand(rows, 'a:s1:a1', 'ArrowUp')).toStrictEqual({ type: 'select', key: 's:s1' });
    expect(keyCommand(rows, 's:s2', 'Home')).toStrictEqual({ type: 'select', key: 's:s1' });
    expect(keyCommand(rows, 's:s1', 'End')).toStrictEqual({ type: 'select', key: 's:s3' });
  });

  it('stops at the ends', () => {
    expect(keyCommand(rows, 's:s1', 'ArrowUp')).toBeNull();
    expect(keyCommand(rows, 's:s3', 'ArrowDown')).toBeNull();
  });

  it('expands a collapsed row, then steps into it', () => {
    expect(keyCommand(rows, 'a:s1:a1', 'ArrowRight')).toStrictEqual({
      type: 'expand',
      key: 'a:s1:a1',
    });
    expect(keyCommand(rows, 's:s1', 'ArrowRight')).toStrictEqual({
      type: 'select',
      key: 'a:s1:a1',
    });
    expect(keyCommand(rows, 's:s2', 'ArrowRight')).toBeNull();
  });

  it('collapses an expanded row, then steps out to the parent', () => {
    expect(keyCommand(rows, 's:s1', 'ArrowLeft')).toStrictEqual({ type: 'collapse', key: 's:s1' });
    expect(keyCommand(rows, 'a:s1:a1', 'ArrowLeft')).toStrictEqual({
      type: 'select',
      key: 's:s1',
    });
    expect(keyCommand(rows, 's:s2', 'ArrowLeft')).toBeNull();
  });

  it('opens with Enter and interrupts active sessions with k', () => {
    expect(keyCommand(rows, 's:s2', 'Enter')).toStrictEqual({ type: 'open', row: rowAt(2).row });
    expect(keyCommand(rows, 's:s1', 'k')).toStrictEqual({ type: 'interrupt', row: rowAt(0).row });
    expect(keyCommand(rows, 's:s3', 'k')).toBeNull();
  });

  it('ignores other keys and unknown rows', () => {
    expect(keyCommand(rows, 's:s1', 'x')).toBeNull();
    expect(keyCommand(rows, 'missing', 'ArrowDown')).toBeNull();
  });
});
