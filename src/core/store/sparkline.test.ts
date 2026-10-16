// cspell:words sparkline
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiRequest, ToolCall } from '../../shared/model.js';

import { SparklineTracker, totalTokens } from './sparkline.js';

const MINUTE = 60_000;
const NOW = 1000 * MINUTE + 30_000;

function request(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    messageId: 'm1',
    requestId: null,
    sessionId: 's1',
    agentId: 's1',
    model: 'claude-opus-5-5',
    timestamp: NOW,
    usage: { input: 1, output: 2, cacheRead: 4, cacheCreation: 8, thinking: 16 },
    ttftMs: null,
    durationMs: null,
    costUsd: 0.5,
    ...overrides,
  };
}

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 't1',
    sessionId: 's1',
    agentId: 's1',
    name: 'Bash',
    input: {},
    startedAt: NOW,
    endedAt: null,
    ok: null,
    resultPreview: null,
    ...overrides,
  };
}

function tracker(minutes: number, clock: () => number = () => NOW): SparklineTracker {
  return new SparklineTracker({ minutes, clock });
}

describe('totalTokens', () => {
  it('adds input, output and both cache counts but not thinking', () => {
    expect(totalTokens({ input: 1, output: 2, cacheRead: 4, cacheCreation: 8, thinking: 16 })).toBe(
      15,
    );
  });
});

describe('SparklineTracker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a window that is not a positive whole number', () => {
    expect(() => new SparklineTracker({ minutes: 0 })).toThrow(
      new RangeError('minutes must be a whole number of at least 1, got 0.'),
    );
    expect(() => new SparklineTracker({ minutes: 2.5 })).toThrow(RangeError);
  });

  it('defaults to a 30 minute window and the system clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const sparks = new SparklineTracker();
    sparks.recordRequest(request());
    const series = sparks.series('s1');
    expect(series.tokensPerMinute).toHaveLength(30);
    expect(series.tokensPerMinute.at(-1)).toBe(15);
    expect(series.tokensPerMinute.slice(0, -1).every((value) => value === 0)).toBe(true);
  });

  it('returns zeros for an unknown session', () => {
    expect(tracker(3).series('nope', NOW)).toStrictEqual({
      tokensPerMinute: [0, 0, 0],
      toolCallsPerMinute: [0, 0, 0],
      costPerMinute: [0, 0, 0],
    });
  });

  it('buckets requests and tool calls by minute, oldest first', () => {
    const sparks = tracker(3);
    sparks.recordRequest(request({ timestamp: NOW }));
    sparks.recordRequest(request({ messageId: 'm2', timestamp: NOW - MINUTE, costUsd: null }));
    sparks.recordRequest(request({ messageId: 'm3', timestamp: NOW - 2 * MINUTE, costUsd: 2 }));
    sparks.recordToolCall(toolCall());
    sparks.recordToolCall(toolCall({ id: 't2' }));
    sparks.recordToolCall(toolCall({ id: 't3', startedAt: NOW - 2 * MINUTE }));
    expect(sparks.series('s1', NOW)).toStrictEqual({
      tokensPerMinute: [15, 15, 15],
      toolCallsPerMinute: [1, 0, 2],
      costPerMinute: [2, 0, 0.5],
    });
  });

  it('keeps sessions apart', () => {
    const sparks = tracker(1);
    sparks.recordToolCall(toolCall({ sessionId: 's2' }));
    expect(sparks.series('s1', NOW).toolCallsPerMinute).toStrictEqual([0]);
    expect(sparks.series('s2', NOW).toolCallsPerMinute).toStrictEqual([1]);
  });

  it('ignores data older than the window', () => {
    const sparks = tracker(2);
    const oldestMinuteStart = Math.floor(NOW / MINUTE) * MINUTE - MINUTE;
    sparks.recordToolCall(toolCall({ startedAt: oldestMinuteStart }));
    sparks.recordToolCall(toolCall({ startedAt: oldestMinuteStart - 1 }));
    expect(sparks.series('s1', NOW).toolCallsPerMinute).toStrictEqual([1, 0]);
    expect(sparks.series('s1', NOW - MINUTE).toolCallsPerMinute).toStrictEqual([0, 1]);
  });

  it('prunes buckets that fall out of the window as time moves on', () => {
    let now = NOW;
    const sparks = tracker(2, () => now);
    sparks.recordToolCall(toolCall({ startedAt: NOW }));
    now = NOW + MINUTE;
    sparks.recordToolCall(toolCall({ startedAt: now }));
    expect(sparks.series('s1', NOW).toolCallsPerMinute).toStrictEqual([0, 1]);
    now = NOW + 2 * MINUTE;
    sparks.recordToolCall(toolCall({ startedAt: now }));
    expect(sparks.series('s1', NOW).toolCallsPerMinute).toStrictEqual([0, 0]);
    expect(sparks.series('s1', now).toolCallsPerMinute).toStrictEqual([1, 1]);
  });

  it('takes back a forgotten request', () => {
    const sparks = tracker(1);
    sparks.recordRequest(request());
    sparks.recordRequest(request({ messageId: 'm2', costUsd: 0.25 }));
    sparks.forgetRequest(request());
    sparks.forgetRequest(request({ messageId: 'm3', costUsd: null, usage: request().usage }));
    expect(sparks.series('s1', NOW)).toStrictEqual({
      tokensPerMinute: [0],
      toolCallsPerMinute: [0],
      costPerMinute: [0.25],
    });
  });

  it('forgets a removed session', () => {
    const sparks = tracker(1);
    sparks.recordToolCall(toolCall());
    sparks.removeSession('s1');
    expect(sparks.series('s1', NOW).toolCallsPerMinute).toStrictEqual([0]);
  });
});
