// The model calls of one Copilot session and what they used and cost.
//
// Each assistant.message is one model call. events.jsonl in 1.0.89 carries no
// per call tokens (assistant.usage is ephemeral), so a call starts with zero
// usage and picks up per call numbers only when a version writes them. The
// totals come later: session.usage_checkpoint has the cost so far, and
// session.shutdown has tokens and cost per agent and model. Whatever those
// totals hold beyond what the calls already report goes on the latest
// matching call, so the session adds up without counting anything twice.
// cspell:words Aiu

import type { ApiRequest, TokenUsage } from '../../../shared/model.js';
import { ZERO_USAGE } from '../../../shared/model.js';
import { addUsage } from '../../transcripts/text.js';

import type { AssistantUsage, ModelMetric, Shutdown } from './events.js';
import { nanoAiuToUsd } from './models.js';

const UNKNOWN_MODEL = 'unknown';

/** One model call, with the nano-AIU it has been charged, or null before any cost was known. */
export interface Call {
  request: ApiRequest;
  nanoAiu: number | null;
}

/** Totals for one model, and one thread when the event names it. */
export interface Bucket {
  readonly threadId: string | null;
  readonly model: string;
  readonly usage: TokenUsage | null;
  readonly nanoAiu: number | null;
}

function minus(total: TokenUsage, seen: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, total.input - seen.input),
    output: Math.max(0, total.output - seen.output),
    cacheRead: Math.max(0, total.cacheRead - seen.cacheRead),
    cacheCreation: Math.max(0, total.cacheCreation - seen.cacheCreation),
    thinking: Math.max(0, total.thinking - seen.thinking),
  };
}

function isZero(usage: TokenUsage): boolean {
  return usage.input + usage.output + usage.cacheRead + usage.cacheCreation + usage.thinking === 0;
}

/**
 * Copilot's inputTokens counts cache reads too, while the shared model keeps
 * uncached input apart, so the uncached part comes from tokenDetails when it
 * is there. Reasoning tokens are part of output and also kept as thinking.
 */
function metricUsage(metric: ModelMetric): TokenUsage | null {
  const usage = metric.usage;
  if (usage === null || usage === undefined) {
    return null;
  }
  const uncached = metric.tokenDetails?.input?.tokenCount;
  return {
    input: uncached ?? Math.max(0, usage.inputTokens - usage.cacheReadTokens),
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheCreation: usage.cacheWriteTokens,
    thinking: usage.reasoningTokens,
  };
}

/** What an assistant.message says about its call. */
export interface MessageCall {
  readonly messageId: string;
  readonly apiCallId: string | null | undefined;
  readonly agentId: string;
  readonly model: string | null;
  readonly outputTokens: number | null | undefined;
  readonly at: number;
}

/** One bucket per model in a modelMetrics map. */
function bucketsOf(
  threadId: string | null,
  metrics: Readonly<Record<string, ModelMetric>>,
): Bucket[] {
  return Object.entries(metrics).map(([model, metric]) => ({
    threadId,
    model,
    usage: metricUsage(metric),
    nanoAiu: metric.totalNanoAiu ?? null,
  }));
}

/**
 * The totals a session.shutdown reports, per agent and model when it breaks
 * them down by agent and per model otherwise. threadFor maps an agentMetrics
 * key to a thread, or to null when no thread has it.
 */
export function shutdownBuckets(
  data: Shutdown,
  threadFor: (key: string) => string | null,
): Bucket[] {
  const agents = Object.entries(data.agentMetrics ?? {});
  if (agents.length === 0) {
    return bucketsOf(null, data.modelMetrics);
  }
  return agents.flatMap(([key, metrics]) => bucketsOf(threadFor(key), metrics.modelMetrics));
}

function sumUsage(calls: readonly Call[]): TokenUsage {
  let total = ZERO_USAGE;
  for (const call of calls) {
    total = addUsage(total, call.request.usage);
  }
  return total;
}

function sumNano(calls: readonly Call[]): number {
  let total = 0;
  for (const call of calls) {
    total += call.nanoAiu ?? 0;
  }
  return total;
}

export class CallLedger {
  private readonly sessionId: string;
  private readonly calls = new Map<string, Call>();
  /** A checkpoint or shutdown said what the session cost, even when that was nothing. */
  private costKnown = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Records an assistant.message as a call, keeping what the totals already put on it. */
  recordMessage(message: MessageCall): ApiRequest {
    const known = this.calls.get(message.messageId);
    const fresh: ApiRequest = {
      messageId: message.messageId,
      requestId: null,
      sessionId: this.sessionId,
      agentId: message.agentId,
      model: UNKNOWN_MODEL,
      timestamp: message.at,
      usage: { ...ZERO_USAGE, output: message.outputTokens ?? 0 },
      ttftMs: null,
      durationMs: null,
      costUsd: null,
    };
    const base = known?.request ?? fresh;
    const request: ApiRequest = {
      ...base,
      requestId: message.apiCallId ?? base.requestId,
      agentId: message.agentId,
      model: message.model ?? base.model,
    };
    this.calls.set(message.messageId, { request, nanoAiu: known?.nanoAiu ?? null });
    return request;
  }

  /**
   * Per call usage from assistant.usage, which replaces whatever the call
   * had. It finds its call by provider id, or else takes the thread's newest.
   */
  applyUsage(data: AssistantUsage, threadId: string): ApiRequest | null {
    const calls = [...this.calls.values()];
    const apiCallId = data.apiCallId ?? null;
    const call =
      calls.find((entry) => apiCallId !== null && entry.request.requestId === apiCallId) ??
      calls.findLast((entry) => entry.request.agentId === threadId);
    if (call === undefined) {
      return null;
    }
    call.nanoAiu = data.copilotUsage?.totalNanoAiu ?? call.nanoAiu;
    const request = call.request;
    call.request = {
      ...request,
      model: data.model ?? request.model,
      usage: {
        input: Math.max(0, data.inputTokens - data.cacheReadTokens),
        output: data.outputTokens,
        cacheRead: data.cacheReadTokens,
        cacheCreation: data.cacheWriteTokens,
        thinking: data.reasoningTokens,
      },
      ttftMs: data.timeToFirstTokenMs ?? request.ttftMs,
      durationMs: data.duration ?? request.durationMs,
      costUsd: call.nanoAiu === null ? request.costUsd : nanoAiuToUsd(call.nanoAiu),
    };
    return call.request;
  }

  requests(agentId?: string): ApiRequest[] {
    return [...this.calls.values()]
      .map((call) => call.request)
      .filter((request) => agentId === undefined || request.agentId === agentId);
  }

  usage(agentId?: string): TokenUsage {
    return sumUsage(
      [...this.calls.values()].filter(
        (call) => agentId === undefined || call.request.agentId === agentId,
      ),
    );
  }

  /** Dollars from the nano-AIU, or null when nothing has said what the session cost. */
  cost(): number | null {
    const calls = [...this.calls.values()];
    const priced = this.costKnown || calls.some((call) => call.nanoAiu !== null);
    return priced ? nanoAiuToUsd(sumNano(calls)) : null;
  }

  /**
   * Puts what the totals hold beyond what the calls already report on the
   * latest matching call, and returns the calls that changed.
   */
  settle(
    buckets: readonly Bucket[],
    totalNanoAiu: number | null,
    at: number,
    model: string | null,
  ): ApiRequest[] {
    const changed = new Set<Call>();
    for (const bucket of buckets) {
      const call = this.settleBucket(bucket, at);
      if (call !== null) {
        changed.add(call);
      }
    }
    if (totalNanoAiu !== null) {
      this.costKnown = true;
      const nano = Math.max(0, totalNanoAiu - sumNano([...this.calls.values()]));
      if (nano > 0) {
        const call = this.latest(null) ?? this.synthetic(null, model, at);
        this.charge(call, ZERO_USAGE, nano);
        changed.add(call);
      }
    }
    return [...changed].map((call) => call.request);
  }

  private settleBucket(bucket: Bucket, at: number): Call | null {
    const matching = [...this.calls.values()].filter(
      (call) =>
        call.request.model === bucket.model &&
        (bucket.threadId === null || call.request.agentId === bucket.threadId),
    );
    const usage = bucket.usage === null ? ZERO_USAGE : minus(bucket.usage, sumUsage(matching));
    const nano = bucket.nanoAiu === null ? 0 : Math.max(0, bucket.nanoAiu - sumNano(matching));
    if (isZero(usage) && nano === 0) {
      return null;
    }
    const call =
      matching.at(-1) ??
      this.latest(bucket.threadId) ??
      this.synthetic(bucket.threadId, bucket.model, at);
    this.charge(call, usage, nano);
    return call;
  }

  private charge(call: Call, usage: TokenUsage, nanoAiu: number): void {
    const total = (call.nanoAiu ?? 0) + nanoAiu;
    call.nanoAiu = total;
    call.request = {
      ...call.request,
      usage: addUsage(call.request.usage, usage),
      costUsd: nanoAiuToUsd(total),
    };
  }

  private latest(threadId: string | null): Call | undefined {
    return [...this.calls.values()].findLast(
      (call) => threadId === null || call.request.agentId === threadId,
    );
  }

  /** A stand-in call for totals with no model call to put them on, such as a session resumed past its calls. */
  private synthetic(threadId: string | null, model: string | null, at: number): Call {
    const agentId = threadId ?? this.sessionId;
    const id = `${this.sessionId}:totals:${agentId}:${model ?? UNKNOWN_MODEL}`;
    const existing = this.calls.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const call: Call = {
      request: {
        messageId: id,
        requestId: null,
        sessionId: this.sessionId,
        agentId,
        model: model ?? UNKNOWN_MODEL,
        timestamp: at,
        usage: ZERO_USAGE,
        ttftMs: null,
        durationMs: null,
        costUsd: null,
      },
      nanoAiu: null,
    };
    this.calls.set(id, call);
    return call;
  }
}
