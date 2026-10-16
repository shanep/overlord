import { describe, expect, it } from 'vitest';

import type { ApiRequest, ToolCall } from '../../shared/model.js';

import type { HealthInput } from './health.js';
import { assessHealth } from './health.js';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A request at minute `at` that read `prompt` tokens, `hit` of them from the cache. */
function request(at: number, prompt: number, hit = 1, model = 'claude-opus-5-5'): ApiRequest {
  const cacheRead = Math.round(prompt * hit);
  return {
    messageId: `m${at.toString()}`,
    requestId: null,
    sessionId: 's1',
    agentId: 's1',
    model,
    timestamp: T0 + at * MINUTE,
    usage: { input: prompt - cacheRead, output: 100, cacheRead, cacheCreation: 0, thinking: 0 },
    ttftMs: null,
    durationMs: null,
    costUsd: null,
  };
}

function call(at: number, ok: boolean | null, name = 'Bash'): ToolCall {
  return {
    id: `t${at.toString()}`,
    sessionId: 's1',
    agentId: 's1',
    name,
    input: {},
    startedAt: T0 + at * MINUTE,
    endedAt: ok === null ? null : T0 + at * MINUTE + 1000,
    ok,
    resultPreview: null,
  };
}

function input(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    startedAt: T0,
    updatedAt: T0 + HOUR,
    requests: [request(1, 40_000), request(2, 50_000)],
    toolCalls: [call(1, true)],
    compactions: [],
    ...overrides,
  };
}

function ids(health: ReturnType<typeof assessHealth>): string[] {
  return health.signals.map((signal) => `${signal.id}:${signal.level}`);
}

describe('assessHealth', () => {
  it('reports a fresh session as healthy with its numbers', () => {
    const health = assessHealth(input());
    expect(health.level).toBe('good');
    expect(health.signals).toStrictEqual([]);
    expect(health.metrics).toStrictEqual({
      contextTokens: 50_000,
      contextWindow: 1_000_000,
      compactions: 0,
      turns: 2,
      recentToolErrors: 0,
      recentToolCalls: 1,
      recentCacheHit: 1,
    });
  });

  it('has no context numbers before the first request', () => {
    const health = assessHealth(input({ requests: [], toolCalls: [] }));
    expect(health.level).toBe('good');
    expect(health.metrics.contextTokens).toBeNull();
    expect(health.metrics.contextWindow).toBeNull();
    expect(health.metrics.recentCacheHit).toBeNull();
  });

  it('flags a large context by size on a 1M window, using the latest request', () => {
    const watch = assessHealth(input({ requests: [request(2, 350_000), request(1, 900_000)] }));
    expect(ids(watch)).toStrictEqual(['context:watch']);
    expect(watch.signals[0]?.finding).toBe('350K tokens in context, 35% of a 1M window.');
    expect(watch.signals[0]?.title).toBe('The context is getting large');
    expect(watch.signals[0]?.why).not.toContain('compacts on its own');

    const degraded = assessHealth(input({ requests: [request(1, 550_000)] }));
    expect(ids(degraded)).toStrictEqual(['context:degraded']);
    expect(degraded.signals[0]?.title).toBe('The context is very large');
    expect(degraded.signals[0]?.actions[0]).toContain('/compact');
  });

  it('flags a context close to a 200K limit by how full it is', () => {
    const model = 'claude-opus-4-6';
    const watch = assessHealth(input({ requests: [request(1, 130_000, 1, model)] }));
    expect(ids(watch)).toStrictEqual(['context:watch']);
    expect(watch.signals[0]?.finding).toBe('130K tokens in context, 65% of a 200K window.');

    const degraded = assessHealth(input({ requests: [request(1, 170_000, 1, model)] }));
    expect(ids(degraded)).toStrictEqual(['context:degraded']);
    expect(degraded.signals[0]?.why).toContain('compacts on its own soon');
  });

  it('flags one compaction to watch and more to act on', () => {
    const once = assessHealth(input({ compactions: [T0] }));
    expect(ids(once)).toStrictEqual(['compactions:watch']);
    expect(once.signals[0]?.finding).toBe('Compacted 1 time.');
    expect(once.signals[0]?.title).toBe('Compacted once');

    const twice = assessHealth(input({ compactions: [T0, T0 + MINUTE] }));
    expect(ids(twice)).toStrictEqual(['compactions:degraded']);
    expect(twice.signals[0]?.title).toBe('Compacted more than once');
  });

  it('flags a run of failed tool calls among the latest finished ones and names the worst tool', () => {
    const old = Array.from({ length: 10 }, (_, index) => call(index, false));
    const recent = [
      ...Array.from({ length: 16 }, (_, index) => call(20 + index, true)),
      call(40, false, 'Edit'),
      call(41, false, 'Bash'),
      call(42, false, 'Bash'),
      call(43, false, 'Bash'),
      call(44, null),
    ];
    const watch = assessHealth(input({ toolCalls: [...recent, ...old] }));
    expect(ids(watch)).toStrictEqual(['tool-errors:watch']);
    expect(watch.signals[0]?.finding).toBe('4 of the last 20 tool calls failed, 3 of them Bash.');
    expect(watch.metrics.recentToolErrors).toBe(4);
    expect(watch.metrics.recentToolCalls).toBe(20);

    const many = [
      ...Array.from({ length: 7 }, (_, index) => call(index, false, 'Read')),
      call(9, false, 'Grep'),
    ];
    const degraded = assessHealth(input({ toolCalls: many }));
    expect(ids(degraded)).toStrictEqual(['tool-errors:degraded']);
    expect(degraded.signals[0]?.finding).toBe('8 of the last 8 tool calls failed, 7 of them Read.');

    const few = Array.from({ length: 3 }, (_, index) => call(index, false));
    expect(assessHealth(input({ toolCalls: few })).signals).toStrictEqual([]);
  });

  it('flags a cache that keeps missing on big prompts', () => {
    const cold = Array.from({ length: 12 }, (_, index) => request(index, 60_000, 0.2));
    const health = assessHealth(input({ requests: cold }));
    expect(ids(health)).toStrictEqual(['cache:watch']);
    expect(health.signals[0]?.finding).toBe(
      'Only 20% of the prompt came from the cache over the last 10 turns.',
    );
  });

  it('leaves the cache alone when the evidence is thin or explained', () => {
    const cold = (count: number, prompt: number): ApiRequest[] =>
      Array.from({ length: count }, (_, index) => request(index, prompt, 0.2));
    // Too few turns to judge.
    expect(assessHealth(input({ requests: cold(4, 60_000) })).signals).toStrictEqual([]);
    // Prompts too small for a miss to matter.
    expect(assessHealth(input({ requests: cold(10, 10_000) })).signals).toStrictEqual([]);
    // Mostly hits.
    const warm = Array.from({ length: 10 }, (_, index) => request(index, 60_000, 0.9));
    expect(assessHealth(input({ requests: warm })).signals).toStrictEqual([]);
    // A compaction rebuilt the prompt during these turns.
    const compacted = assessHealth(
      input({ requests: cold(10, 60_000), compactions: [T0 + MINUTE] }),
    );
    expect(ids(compacted)).toStrictEqual(['compactions:watch']);
    // An empty prompt has no hit rate at all.
    const empty = assessHealth(input({ requests: cold(10, 0) }));
    expect(empty.metrics.recentCacheHit).toBeNull();
  });

  it('flags a session active for hours or days', () => {
    const hours = assessHealth(input({ updatedAt: T0 + 9 * HOUR }));
    expect(ids(hours)).toStrictEqual(['age:watch']);
    expect(hours.signals[0]?.finding).toBe(
      'Active over 9 hours, from its first turn to its latest.',
    );
    const days = assessHealth(input({ updatedAt: T0 + 50 * HOUR }));
    expect(days.signals[0]?.finding).toBe('Active over 2 days, from its first turn to its latest.');
  });

  it('puts the worst signal first and takes its level', () => {
    const health = assessHealth(
      input({
        updatedAt: T0 + 9 * HOUR,
        compactions: [T0, T0 + MINUTE],
        requests: [request(1, 350_000)],
      }),
    );
    expect(health.level).toBe('degraded');
    expect(ids(health)).toStrictEqual(['compactions:degraded', 'context:watch', 'age:watch']);
  });
});
