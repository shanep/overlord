// Per-session activity over the last N minutes, one bucket per minute, for
// the fleet view sparklines. Old buckets are pruned as new data arrives.
// cspell:words sparkline

import type { ApiRequest, TokenUsage, ToolCall } from '../../shared/model.js';

export interface SessionSparkline {
  /** Oldest minute first. The last entry is the current minute. */
  readonly tokensPerMinute: readonly number[];
  readonly toolCallsPerMinute: readonly number[];
  readonly costPerMinute: readonly number[];
}

export interface SparklineOptions {
  /** How many minutes each series covers. Defaults to 30. */
  readonly minutes?: number | undefined;
  readonly clock?: (() => number) | undefined;
}

interface Bucket {
  tokens: number;
  toolCalls: number;
  cost: number;
}

const MINUTE_MS = 60_000;
const DEFAULT_MINUTES = 30;

/** Every token the request moved, cached or not, so busy sessions stand out. */
export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
}

function minuteOf(at: number): number {
  return Math.floor(at / MINUTE_MS);
}

export class SparklineTracker {
  private readonly minutes: number;
  private readonly clock: () => number;
  private readonly sessions = new Map<string, Map<number, Bucket>>();

  constructor(options: SparklineOptions = {}) {
    const minutes = options.minutes ?? DEFAULT_MINUTES;
    if (!Number.isInteger(minutes) || minutes < 1) {
      throw new RangeError(`minutes must be a whole number of at least 1, got ${String(minutes)}.`);
    }
    this.minutes = minutes;
    this.clock = options.clock ?? Date.now;
  }

  recordRequest(request: ApiRequest): void {
    this.add(request.sessionId, request.timestamp, {
      tokens: totalTokens(request.usage),
      toolCalls: 0,
      cost: request.costUsd ?? 0,
    });
  }

  /** Takes back a request recorded earlier, so a newer copy of it can replace it. */
  forgetRequest(request: ApiRequest): void {
    this.add(request.sessionId, request.timestamp, {
      tokens: -totalTokens(request.usage),
      toolCalls: 0,
      cost: -(request.costUsd ?? 0),
    });
  }

  recordToolCall(call: ToolCall): void {
    this.add(call.sessionId, call.startedAt, { tokens: 0, toolCalls: 1, cost: 0 });
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  series(sessionId: string, now: number = this.clock()): SessionSparkline {
    const buckets = this.sessions.get(sessionId);
    const first = minuteOf(now) - this.minutes + 1;
    const tokensPerMinute: number[] = [];
    const toolCallsPerMinute: number[] = [];
    const costPerMinute: number[] = [];
    for (let offset = 0; offset < this.minutes; offset += 1) {
      const bucket = buckets?.get(first + offset);
      tokensPerMinute.push(bucket?.tokens ?? 0);
      toolCallsPerMinute.push(bucket?.toolCalls ?? 0);
      costPerMinute.push(bucket?.cost ?? 0);
    }
    return { tokensPerMinute, toolCallsPerMinute, costPerMinute };
  }

  private add(sessionId: string, at: number, delta: Bucket): void {
    const oldest = minuteOf(this.clock()) - this.minutes + 1;
    const minute = minuteOf(at);
    let buckets = this.sessions.get(sessionId);
    if (buckets === undefined) {
      buckets = new Map();
      this.sessions.set(sessionId, buckets);
    }
    const bucket = buckets.get(minute) ?? { tokens: 0, toolCalls: 0, cost: 0 };
    bucket.tokens += delta.tokens;
    bucket.toolCalls += delta.toolCalls;
    bucket.cost += delta.cost;
    buckets.set(minute, bucket);
    // Pruning here also drops the bucket just written when it is already too old.
    for (const key of buckets.keys()) {
      if (key < oldest) {
        buckets.delete(key);
      }
    }
  }
}
