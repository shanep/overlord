import { describe, expect, it } from 'vitest';

import type { FrustrationIndex, HitEntry } from './store.js';
import { emptyIndex } from './store.js';
import { dayOf, RECENT_HITS, summarize, TOP_TERMS } from './summarize.js';

// Noon UTC is the same calendar day in every time zone from UTC-11 to UTC+11.
const DAY1 = Date.UTC(2026, 9, 1, 12);
const DAY2 = Date.UTC(2026, 9, 2, 12);

function put(
  index: FrustrationIndex,
  id: string,
  prompt: { readonly sessionId: string; readonly at: number },
  found?: HitEntry,
): void {
  index.prompts.set(id, prompt);
  if (found !== undefined) {
    index.hits.set(id, found);
  }
}

function hit(target: HitEntry['target'], ...terms: string[]): HitEntry {
  return { terms, target, excerpt: terms.join(' ') };
}

const title = (sessionId: string): string => `title ${sessionId}`;

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
      totalPrompts: 0,
      atClaude: 0,
      general: 0,
      byDay: [],
      bySession: [],
      topTerms: [],
      recent: [],
      scannedAt: null,
    });
  });

  it('totals prompts and hits by day and by session', () => {
    const index = emptyIndex();
    index.scannedAt = 9;
    put(index, 'a', { sessionId: 's1', at: DAY2 }, hit('claude', 'idiot'));
    put(index, 'b', { sessionId: 's1', at: DAY2 + 1 }, hit('general', 'shit', 'fuck'));
    put(index, 'c', { sessionId: 's1', at: DAY1 });
    put(index, 'd', { sessionId: 's2', at: DAY1 }, hit('general', 'shit'));
    put(index, 'e', { sessionId: 's3', at: DAY1 });
    put(index, 'f', { sessionId: 's4', at: DAY1 }, hit('claude', 'idiot'));
    put(index, 'g', { sessionId: 's4', at: DAY1 });
    const state = summarize(index, title);
    expect(state.totalPrompts).toBe(7);
    expect(state.atClaude).toBe(2);
    expect(state.general).toBe(2);
    expect(state.scannedAt).toBe(9);
    expect(state.byDay).toStrictEqual([
      { date: '2026-10-01', prompts: 5, atClaude: 1, general: 1 },
      { date: '2026-10-02', prompts: 2, atClaude: 1, general: 1 },
    ]);
    expect(state.bySession).toStrictEqual([
      { sessionId: 's1', title: 'title s1', prompts: 3, hits: 2 },
      { sessionId: 's4', title: 'title s4', prompts: 2, hits: 1 },
      { sessionId: 's2', title: 'title s2', prompts: 1, hits: 1 },
    ]);
    expect(state.topTerms).toStrictEqual([
      { term: 'idiot', count: 2 },
      { term: 'shit', count: 2 },
      { term: 'fuck', count: 1 },
    ]);
    expect(state.recent.map((item) => item.id)).toStrictEqual(['b', 'a', 'd', 'f']);
    expect(state.recent[0]).toStrictEqual({
      id: 'b',
      sessionId: 's1',
      at: DAY2 + 1,
      terms: ['shit', 'fuck'],
      target: 'general',
      excerpt: 'shit fuck',
    });
  });

  it('breaks session ties by id', () => {
    const index = emptyIndex();
    put(index, 'a', { sessionId: 'zz', at: DAY1 }, hit('claude', 'x'));
    put(index, 'b', { sessionId: 'aa', at: DAY1 }, hit('claude', 'x'));
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
        hit('general', `t${String(count % 12)}`),
      );
    }
    const state = summarize(index, title);
    expect(state.recent).toHaveLength(RECENT_HITS);
    expect(state.recent[0]?.id).toBe('p50');
    expect(state.recent.at(-1)?.id).toBe('p1');
    expect(state.topTerms).toHaveLength(TOP_TERMS);
    expect(state.topTerms.slice(0, 4)).toStrictEqual([
      { term: 't0', count: 5 },
      { term: 't1', count: 5 },
      { term: 't2', count: 5 },
      { term: 't10', count: 4 },
    ]);
  });

  it('skips a hit whose prompt is missing', () => {
    const index = emptyIndex();
    index.hits.set('lost', hit('claude', 'x'));
    expect(summarize(index, title).recent).toStrictEqual([]);
    expect(summarize(index, title).atClaude).toBe(0);
  });
});
