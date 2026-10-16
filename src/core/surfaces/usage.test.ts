import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { emptyClimate, estimateClimate } from './climate.js';
import { makeScratchHome } from './test-helpers/scratch-home.js';
import { EMPTY_USAGE, parseStatsCache, readUsageHistory } from './usage.js';

const SAMPLE = {
  version: 5,
  lastComputedDate: '2026-10-14',
  dailyActivity: [
    { date: '2026-10-02', messageCount: 10, sessionCount: 2, toolCallCount: 4 },
    { date: '2026-10-01', messageCount: 5, sessionCount: 1, toolCallCount: 3 },
  ],
  dailyModelTokens: [
    { date: '2026-10-02', tokensByModel: { 'claude-opus-5': 900 } },
    { date: '2026-10-03', tokensByModel: { 'claude-sonnet-5': 40, 'claude-opus-5': 2 } },
  ],
  dailyModelTokensVersion: 5,
  modelUsage: {
    'claude-opus-5': {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
      webSearchRequests: 5,
      costUSD: 6.5,
      contextWindow: 0,
      maxOutputTokens: 0,
    },
  },
  totalSessions: 983,
  totalMessages: 125_730,
  longestSession: {
    sessionId: 'long-1',
    timestamp: '2026-09-28T18:58:40.097Z',
    duration: 112_382_251,
    messageCount: 1788,
  },
  firstSessionDate: '2026-01-25T20:12:05.322Z',
  hourCounts: { '0': 5, '7': 6 },
};

describe('EMPTY_USAGE', () => {
  it('is all zeros', () => {
    expect(EMPTY_USAGE).toStrictEqual({
      days: [],
      hourCounts: {},
      totalSessions: 0,
      totalMessages: 0,
      climate: emptyClimate(),
    });
  });
});

describe('parseStatsCache', () => {
  it('merges activity and tokens per day, sorted by date', () => {
    const history = parseStatsCache(SAMPLE);
    expect(history.usage).toStrictEqual({
      days: [
        { date: '2026-10-01', messages: 5, sessions: 1, toolCalls: 3, tokensByModel: {} },
        {
          date: '2026-10-02',
          messages: 10,
          sessions: 2,
          toolCalls: 4,
          tokensByModel: { 'claude-opus-5': 900 },
        },
        {
          date: '2026-10-03',
          messages: 0,
          sessions: 0,
          toolCalls: 0,
          tokensByModel: { 'claude-sonnet-5': 40, 'claude-opus-5': 2 },
        },
      ],
      hourCounts: { '0': 5, '7': 6 },
      totalSessions: 983,
      totalMessages: 125_730,
      climate: estimateClimate(history.modelUsage),
    });
    expect(history.usage.climate.models.map((row) => row.model)).toStrictEqual(['claude-opus-5']);
  });

  it('keeps model totals, the longest session and file metadata', () => {
    const history = parseStatsCache(SAMPLE);
    expect(history.modelUsage).toStrictEqual({
      'claude-opus-5': {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
        webSearchRequests: 5,
        costUsd: 6.5,
      },
    });
    expect(history.longestSession).toStrictEqual({
      sessionId: 'long-1',
      at: '2026-09-28T18:58:40.097Z',
      durationMs: 112_382_251,
      messages: 1788,
    });
    expect(history.firstSessionDate).toBe('2026-01-25T20:12:05.322Z');
    expect(history.lastComputedDate).toBe('2026-10-14');
    expect(history.formatVersion).toBe(5);
  });

  it('defaults everything for an empty object', () => {
    expect(parseStatsCache({})).toStrictEqual({
      usage: EMPTY_USAGE,
      modelUsage: {},
      longestSession: null,
      firstSessionDate: null,
      lastComputedDate: null,
      formatVersion: null,
    });
  });

  it('survives odd values field by field', () => {
    const history = parseStatsCache({
      version: 'five',
      lastComputedDate: 7,
      firstSessionDate: false,
      dailyActivity: [
        { date: '2026-01-01', messageCount: -3, sessionCount: 'x', toolCallCount: 2 },
        { messageCount: 1 },
        'junk',
      ],
      dailyModelTokens: [{ date: '2026-01-01', tokensByModel: 'bad' }, { tokensByModel: {} }],
      hourCounts: { '3': 'many', '4': 2 },
      modelUsage: 'bad',
      totalSessions: -1,
      totalMessages: 'lots',
      longestSession: { sessionId: 's', duration: 'long' },
    });
    expect(history).toStrictEqual({
      usage: {
        days: [{ date: '2026-01-01', messages: 0, sessions: 0, toolCalls: 2, tokensByModel: {} }],
        hourCounts: { '3': 0, '4': 2 },
        totalSessions: 0,
        totalMessages: 0,
        climate: emptyClimate(),
      },
      modelUsage: {},
      longestSession: { sessionId: 's', at: null, durationMs: 0, messages: 0 },
      firstSessionDate: null,
      lastComputedDate: null,
      formatVersion: null,
    });
  });

  it('treats a longest session without an id as missing', () => {
    expect(parseStatsCache({ longestSession: { duration: 3 } }).longestSession).toBeNull();
    expect(parseStatsCache({ longestSession: null }).longestSession).toBeNull();
  });

  it('throws when the file is not an object', () => {
    expect(() => parseStatsCache([])).toThrow(new Error('stats-cache.json is not an object'));
    expect(() => parseStatsCache(null)).toThrow(new Error('stats-cache.json is not an object'));
    expect(() => parseStatsCache('x')).toThrow(new Error('stats-cache.json is not an object'));
  });

  it('never throws on any object and returns sorted unique days', () => {
    fc.assert(
      fc.property(fc.object(), (value) => {
        const days = parseStatsCache(value).usage.days.map((day) => day.date);
        expect(days).toStrictEqual([...new Set(days)].toSorted((a, b) => a.localeCompare(b)));
      }),
    );
  });

  it('keeps every valid day from generated activity', () => {
    const day = fc.record({
      date: fc.constantFrom('2026-01-01', '2026-01-02', '2026-01-03'),
      messageCount: fc.nat(),
      sessionCount: fc.nat(),
      toolCallCount: fc.nat(),
    });
    fc.assert(
      fc.property(fc.array(day), (dailyActivity) => {
        const result = parseStatsCache({ dailyActivity }).usage.days;
        const unique = new Set(dailyActivity.map((entry) => entry.date));
        expect(result).toHaveLength(unique.size);
        for (const entry of result) {
          const last = dailyActivity.findLast((candidate) => candidate.date === entry.date);
          expect(entry.messages).toBe(last?.messageCount);
        }
      }),
    );
  });
});

describe('readUsageHistory', () => {
  it('returns null history and no error when the file is missing', async () => {
    const home = await makeScratchHome();
    await expect(readUsageHistory(home.paths)).resolves.toStrictEqual({
      history: null,
      errors: [],
    });
    await home.cleanup();
  });

  it('reads the file', async () => {
    const home = await makeScratchHome();
    await home.writeJson('.claude/stats-cache.json', SAMPLE);
    const result = await readUsageHistory(home.paths);
    expect(result.errors).toStrictEqual([]);
    expect(result.history).toStrictEqual(parseStatsCache(SAMPLE));
    await home.cleanup();
  });

  it('reports a broken file', async () => {
    const home = await makeScratchHome();
    await home.writeText('.claude/stats-cache.json', '[1,2]');
    await expect(readUsageHistory(home.paths)).resolves.toStrictEqual({
      history: null,
      errors: [
        {
          source: 'stats-cache',
          message: 'stats-cache.json is not an object',
          path: home.paths.statsCache,
        },
      ],
    });
    await home.cleanup();
  });
});
