import { describe, expect, it } from 'vitest';

import { summarize } from './summarize.js';
import { HOME, measureOf } from './test-helpers/fixtures.js';

const NONE = { history: [], tracked: new Map<string, number>(), now: 0 };

describe('summarize', () => {
  it('drops sessions with no requests and sorts rows by cost', () => {
    const cheap = measureOf({ sessionId: 'cheap', title: 'Cheap' });
    const dear = measureOf({
      sessionId: 'dear',
      title: 'Dear',
      peakContext: 300_000,
      requests: 4,
      contextTokens: 400_000,
      cost: { input: 0, output: 1, cacheRead: 3, cacheWrite: 0 },
      subagentUsd: 1,
    });
    const empty = measureOf({ sessionId: 'empty', requests: 0 });
    const state = summarize({
      measures: [cheap, empty, dear],
      history: [],
      tracked: new Map(),
      now: 2000,
      installed: new Set(['handoff']),
      home: HOME,
      scannedAt: 9,
      plan: null,
    });
    expect(state).toMatchObject({
      sessions: 2,
      totalUsd: 5.36,
      cacheReadUsd: 3.05,
      largestContext: 300_000,
      scannedAt: 9,
    });
    expect(state.averageContext).toBeCloseTo(550_000 / 14);
    expect(state.tips.map((tip) => tip.id)).toStrictEqual(['context-reread', 'huge-context']);
    expect(state.suggestions.find((item) => item.id === 'handoff')?.installed).toBe(true);
    expect(state.rows).toStrictEqual([
      {
        sessionId: 'dear',
        title: 'Dear',
        updatedAt: 1000,
        prompts: 3,
        requests: 4,
        peakContext: 300_000,
        averageContext: 100_000,
        costUsd: 5,
        cacheReadShare: 0.6,
        tips: ['context-reread', 'huge-context'],
      },
      expect.objectContaining({ sessionId: 'cheap', costUsd: 0.36, tips: [] }),
    ]);
  });

  it('is empty with no sessions', () => {
    const state = summarize({
      ...NONE,
      measures: [],
      installed: new Set(),
      home: HOME,
      scannedAt: null,
      plan: null,
    });
    expect(state).toMatchObject({ sessions: 0, averageContext: 0, largestContext: 0, rows: [] });
  });

  it('keeps the 200 most expensive sessions', () => {
    const measures = Array.from({ length: 205 }, (_, n) =>
      measureOf({ sessionId: `s${n.toString()}`, subagentUsd: n }),
    );
    const state = summarize({
      ...NONE,
      measures,
      installed: new Set(),
      home: HOME,
      scannedAt: null,
      plan: null,
    });
    expect(state.rows).toHaveLength(200);
    expect(state.rows[0]?.sessionId).toBe('s204');
    expect(state.sessions).toBe(205);
  });
});
