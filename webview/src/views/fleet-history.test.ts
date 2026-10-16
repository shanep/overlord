import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fleetState } from '../../test/fixtures.js';

import type { HistorySample } from './fleet-history.js';
import {
  appendHistory,
  deltas,
  HISTORY_CAP,
  historySamples,
  useRowHistory,
} from './fleet-history.js';
import { buildFleetTree } from './fleet-rows.js';

describe('appendHistory', () => {
  it('adds one sample per row and drops rows that went away', () => {
    const first = appendHistory(
      new Map(),
      [
        { key: 'a', value: 1 },
        { key: 'b', value: 5 },
      ],
      3,
    );
    expect([...first.entries()]).toStrictEqual([
      ['a', [1]],
      ['b', [5]],
    ]);
    const second = appendHistory(first, [{ key: 'a', value: 2 }], 3);
    expect([...second.entries()]).toStrictEqual([['a', [1, 2]]]);
  });

  it('keeps only the last cap samples', () => {
    let history: ReadonlyMap<string, readonly number[]> = new Map();
    for (let value = 1; value <= 5; value += 1) {
      history = appendHistory(history, [{ key: 'a', value }], 3);
    }
    expect(history.get('a')).toStrictEqual([3, 4, 5]);
    expect(HISTORY_CAP).toBe(30);
  });
});

describe('deltas', () => {
  it('returns growth between samples, never negative', () => {
    expect(deltas([])).toStrictEqual([]);
    expect(deltas([4])).toStrictEqual([]);
    expect(deltas([1, 4, 4, 2, 10])).toStrictEqual([3, 0, 0, 8]);
  });
});

describe('historySamples', () => {
  it('samples total tokens for every row in the tree', () => {
    const samples = historySamples(buildFleetTree(fleetState));
    expect(samples.map((sample) => sample.key)).toStrictEqual([
      's:s1',
      'a:s1:a1',
      'a:s1:a2',
      's:s2',
      's:s3',
    ]);
    expect(samples[0]?.value).toBe(101_400);
    expect(samples[4]?.value).toBe(0);
  });
});

describe('useRowHistory', () => {
  it('appends only when the source changes', () => {
    const samples: readonly HistorySample[] = [{ key: 'a', value: 1 }];
    const first = { id: 1 };
    const { result, rerender } = renderHook(
      (props: { samples: readonly HistorySample[]; source: object }) =>
        useRowHistory(props.samples, props.source),
      { initialProps: { samples, source: first } },
    );
    expect(result.current.get('a')).toStrictEqual([1]);
    rerender({ samples: [{ key: 'a', value: 9 }], source: first });
    expect(result.current.get('a')).toStrictEqual([1]);
    rerender({ samples: [{ key: 'a', value: 3 }], source: { id: 2 } });
    expect(result.current.get('a')).toStrictEqual([1, 3]);
  });
});
