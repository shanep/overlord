import { describe, expect, it } from 'vitest';

import type { HitEntry, ReputationIndex } from './store.js';
import { emptyIndex } from './store.js';
import {
  dayOf,
  MEAN_WEIGHT,
  RECENT_HITS,
  reputationScore,
  SCORE_DAMPING,
  summarize,
  TOP_TERMS,
} from './summarize.js';

// Noon UTC is the same calendar day in every time zone from UTC-11 to UTC+11.
const DAY1 = Date.UTC(2026, 9, 1, 12);
const DAY2 = Date.UTC(2026, 9, 2, 12);

interface Said {
  readonly mean?: HitEntry;
  readonly kind?: readonly string[];
}

function put(
  index: ReputationIndex,
  id: string,
  prompt: { readonly sessionId: string; readonly at: number },
  said: Said = {},
): void {
  index.prompts.set(id, prompt);
  if (said.mean !== undefined) {
    index.hits.set(id, said.mean);
  }
  if (said.kind !== undefined) {
    index.kind.set(id, { terms: said.kind, excerpt: said.kind.join(' ') });
  }
}

function hit(target: HitEntry['target'], ...terms: string[]): HitEntry {
  return { terms, target, excerpt: terms.join(' ') };
}

const title = (sessionId: string): string => `title ${sessionId}`;

describe('reputationScore', () => {
  it('is 0 with nothing said, leans with each side and weighs mean prompts more', () => {
    expect(reputationScore({ kind: 0, mean: 0 })).toBe(0);
    expect(reputationScore({ kind: 1, mean: 0 })).toBe(1 / (1 + SCORE_DAMPING));
    expect(reputationScore({ kind: 0, mean: 1 })).toBe(
      -MEAN_WEIGHT / (MEAN_WEIGHT + SCORE_DAMPING),
    );
    expect(reputationScore({ kind: MEAN_WEIGHT, mean: 1 })).toBe(0);
    expect(reputationScore({ kind: 10_000, mean: 0 })).toBeGreaterThan(0.99);
    expect(reputationScore({ kind: 0, mean: 10_000 })).toBeLessThan(-0.99);
  });
});

describe('dayOf', () => {
  it('gives the local date padded', () => {
    expect(dayOf(DAY1)).toBe('2026-10-01');
    expect(dayOf(Date.UTC(2026, 0, 5, 12))).toBe('2026-01-05');
    expect(dayOf(Date.UTC(2026, 11, 25, 12))).toBe('2026-12-25');
  });
});

describe('summarize', () => {
  it('is empty for an empty index', () => {
    expect(summarize(emptyIndex(), title)).toStrictEqual({
      prompts: 0,
      kind: 0,
      mean: 0,
      general: 0,
      score: 0,
      byDay: [],
      bySession: [],
      topKind: [],
      topMean: [],
      recent: [],
      scannedAt: null,
    });
  });

  it('totals kind, mean and general prompts by day and by session', () => {
    const index = emptyIndex();
    index.scannedAt = 9;
    put(index, 'a', { sessionId: 's1', at: DAY2 }, { mean: hit('claude', 'idiot') });
    put(
      index,
      'b',
      { sessionId: 's1', at: DAY2 + 1 },
      { mean: hit('general', 'shit', 'fuck'), kind: ['please'] },
    );
    put(index, 'c', { sessionId: 's1', at: DAY1 });
    put(index, 'd', { sessionId: 's2', at: DAY1 }, { mean: hit('general', 'shit') });
    put(index, 'e', { sessionId: 's3', at: DAY1 }, { kind: ['thanks', 'please'] });
    put(index, 'f', { sessionId: 's4', at: DAY1 }, { mean: hit('claude', 'idiot') });
    put(index, 'g', { sessionId: 's4', at: DAY1 });
    put(index, 'h', { sessionId: 's5', at: DAY1 });
    const state = summarize(index, title);
    expect(state).toMatchObject({ prompts: 8, kind: 2, mean: 2, general: 2, scannedAt: 9 });
    expect(state.score).toBe(reputationScore({ kind: 2, mean: 2 }));
    expect(state.byDay).toStrictEqual([
      { date: '2026-10-01', prompts: 6, kind: 1, mean: 1, general: 1 },
      { date: '2026-10-02', prompts: 2, kind: 1, mean: 1, general: 1 },
    ]);
    const meanOnce = reputationScore({ kind: 0, mean: 1 });
    expect(state.bySession).toStrictEqual(
      [
        {
          sessionId: 's1',
          title: 'title s1',
          prompts: 3,
          kind: 1,
          mean: 1,
          general: 1,
          score: reputationScore({ kind: 1, mean: 1 }),
        },
        {
          sessionId: 's4',
          title: 'title s4',
          prompts: 2,
          kind: 0,
          mean: 1,
          general: 0,
          score: meanOnce,
        },
        { sessionId: 's2', title: 'title s2', prompts: 1, kind: 0, mean: 0, general: 1, score: 0 },
        {
          sessionId: 's3',
          title: 'title s3',
          prompts: 1,
          kind: 1,
          mean: 0,
          general: 0,
          score: reputationScore({ kind: 1, mean: 0 }),
        },
      ].toSorted((left, right) => left.score - right.score || right.prompts - left.prompts),
    );
    expect(state.topKind).toStrictEqual([
      { term: 'please', count: 2 },
      { term: 'thanks', count: 1 },
    ]);
    expect(state.topMean).toStrictEqual([
      { term: 'idiot', count: 2 },
      { term: 'shit', count: 2 },
      { term: 'fuck', count: 1 },
    ]);
    expect(state.recent.map((item) => item.id)).toStrictEqual([
      'b:general',
      'b:kind',
      'a:mean',
      'd:general',
      'e:kind',
      'f:mean',
    ]);
    expect(state.recent[1]).toStrictEqual({
      id: 'b:kind',
      sessionId: 's1',
      at: DAY2 + 1,
      tone: 'kind',
      terms: ['please'],
      excerpt: 'please',
    });
  });

  it('breaks session ties by id', () => {
    const index = emptyIndex();
    put(index, 'a', { sessionId: 'zz', at: DAY1 }, { mean: hit('claude', 'x') });
    put(index, 'b', { sessionId: 'aa', at: DAY1 }, { mean: hit('claude', 'x') });
    expect(summarize(index, title).bySession.map((row) => row.sessionId)).toStrictEqual([
      'aa',
      'zz',
    ]);
  });

  it('keeps the top terms and the newest hits only', () => {
    const index = emptyIndex();
    for (let count = 0; count < RECENT_HITS + 1; count += 1) {
      put(
        index,
        `p${String(count)}`,
        { sessionId: 's', at: DAY1 + count },
        { mean: hit('general', `t${String(count % 12)}`) },
      );
    }
    const state = summarize(index, title);
    expect(state.recent).toHaveLength(RECENT_HITS);
    expect(state.recent[0]?.id).toBe('p50:general');
    expect(state.recent.at(-1)?.id).toBe('p1:general');
    expect(state.topMean).toHaveLength(TOP_TERMS);
    expect(state.topMean.slice(0, 4)).toStrictEqual([
      { term: 't0', count: 5 },
      { term: 't1', count: 5 },
      { term: 't2', count: 5 },
      { term: 't10', count: 4 },
    ]);
  });

  it('skips hits whose prompt is missing', () => {
    const index = emptyIndex();
    index.hits.set('lost', hit('claude', 'x'));
    index.kind.set('lost', { terms: ['please'], excerpt: 'please' });
    expect(summarize(index, title)).toMatchObject({ recent: [], mean: 0, kind: 0 });
  });
});
