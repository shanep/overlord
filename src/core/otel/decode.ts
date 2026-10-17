// Turns OTLP JSON exports into typed records, and api_request events (joined
// with llm_request span timings when traces are on) into ApiRequest entries
// on the event bus.

import type { ApiRequest } from '../../shared/model.js';
import type { EventBus } from '../bus.js';

import type { Attributes, OtlpLogRecord, OtlpMetric, OtlpSpan } from './otlp.js';
import {
  anyValue,
  attributesOf,
  readBool,
  logsRequestSchema,
  metricsRequestSchema,
  nanosToMs,
  readNumber,
  readString,
  toNumber,
  tracesRequestSchema,
} from './otlp.js';
import type {
  ApiRequestRecord,
  LlmRequestSpanRecord,
  MetricPointRecord,
  TelemetryRecord,
} from './records.js';

export type OtlpSignal = 'metrics' | 'logs' | 'traces';

/** One agent's reading of an OTLP export: its records, or null when the body is not valid OTLP. */
export type TelemetryDecode = (
  signal: OtlpSignal,
  body: unknown,
  now: number,
) => TelemetryRecord[] | null;

const EVENT_PREFIX = 'claude_code.';

function sessionOf(attributes: Attributes, resource: Attributes): string | null {
  return readString(attributes, 'session.id') ?? readString(resource, 'session.id');
}

interface PointTimes {
  readonly attributes?: readonly unknown[] | undefined;
  readonly timeUnixNano?: unknown;
  readonly startTimeUnixNano?: unknown;
}

function metricPoints(metric: OtlpMetric, resource: Attributes, now: number): MetricPointRecord[] {
  const records: MetricPointRecord[] = [];
  const push = (
    metricType: MetricPointRecord['metricType'],
    point: PointTimes,
    value: number | null,
  ): void => {
    if (value === null) {
      return;
    }
    const attributes = attributesOf(point.attributes);
    records.push({
      kind: 'metric',
      name: metric.name,
      metricType,
      unit: metric.unit ?? null,
      value,
      time: nanosToMs(point.timeUnixNano) ?? now,
      startTime: nanosToMs(point.startTimeUnixNano),
      sessionId: sessionOf(attributes, resource),
      attributes,
      resource,
    });
  };
  for (const point of metric.sum?.dataPoints ?? []) {
    push('sum', point, toNumber(point.asDouble ?? point.asInt));
  }
  for (const point of metric.gauge?.dataPoints ?? []) {
    push('gauge', point, toNumber(point.asDouble ?? point.asInt));
  }
  for (const point of metric.histogram?.dataPoints ?? []) {
    push('histogram', point, toNumber(point.sum));
  }
  return records;
}

/** Records from an ExportMetricsServiceRequest, or null when the body is not one. */
export function decodeMetrics(body: unknown, now: number): MetricPointRecord[] | null {
  const parsed = metricsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const records: MetricPointRecord[] = [];
  for (const group of parsed.data.resourceMetrics ?? []) {
    const resource = attributesOf(group.resource?.attributes);
    for (const scope of group.scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        records.push(...metricPoints(metric, resource, now));
      }
    }
  }
  return records;
}

/** The short event name ("api_request"), from the log body or the event.name attribute. */
export function eventName(body: unknown, attributes: Attributes): string | null {
  const fromBody = anyValue(body);
  if (typeof fromBody === 'string' && fromBody.startsWith(EVENT_PREFIX)) {
    return fromBody.slice(EVENT_PREFIX.length);
  }
  const fromAttribute = readString(attributes, 'event.name');
  if (fromAttribute === null || fromAttribute === '') {
    return null;
  }
  return fromAttribute.startsWith(EVENT_PREFIX)
    ? fromAttribute.slice(EVENT_PREFIX.length)
    : fromAttribute;
}

function eventTime(record: OtlpLogRecord, attributes: Attributes, now: number): number {
  const stamp = Date.parse(readString(attributes, 'event.timestamp') ?? '');
  if (Number.isFinite(stamp)) {
    return stamp;
  }
  return nanosToMs(record.timeUnixNano) ?? nanosToMs(record.observedTimeUnixNano) ?? now;
}

function count(attributes: Attributes, key: string): number {
  return readNumber(attributes, key) ?? 0;
}

function logRecord(
  record: OtlpLogRecord,
  resource: Attributes,
  now: number,
): TelemetryRecord | null {
  const attributes = attributesOf(record.attributes);
  const name = eventName(record.body, attributes);
  if (name === null) {
    return null;
  }
  const base = {
    time: eventTime(record, attributes, now),
    sessionId: sessionOf(attributes, resource),
    attributes,
    resource,
  };
  const text = (key: string): string | null => readString(attributes, key);
  const number = (key: string): number | null => readNumber(attributes, key);
  switch (name) {
    case 'api_request': {
      return {
        ...base,
        kind: 'api_request',
        model: text('model'),
        costUsd: number('cost_usd'),
        durationMs: number('duration_ms'),
        inputTokens: count(attributes, 'input_tokens'),
        outputTokens: count(attributes, 'output_tokens'),
        cacheReadTokens: count(attributes, 'cache_read_tokens'),
        cacheCreationTokens: count(attributes, 'cache_creation_tokens'),
        requestId: text('request_id'),
        querySource: text('query_source'),
        sequence: number('event.sequence'),
      };
    }
    case 'api_error': {
      return {
        ...base,
        kind: 'api_error',
        model: text('model'),
        error: text('error'),
        statusCode: number('status_code'),
        durationMs: number('duration_ms'),
        attempt: number('attempt'),
        requestId: text('request_id'),
      };
    }
    case 'tool_result': {
      return {
        ...base,
        kind: 'tool_result',
        toolName: text('tool_name'),
        toolUseId: text('tool_use_id'),
        success: readBool(attributes, 'success'),
        durationMs: number('duration_ms'),
        errorType: text('error_type'),
        decisionSource: text('decision_source'),
      };
    }
    case 'tool_decision': {
      return {
        ...base,
        kind: 'tool_decision',
        toolName: text('tool_name'),
        toolUseId: text('tool_use_id'),
        decision: text('decision'),
        source: text('source'),
      };
    }
    case 'user_prompt': {
      return {
        ...base,
        kind: 'user_prompt',
        promptLength: number('prompt_length'),
        promptId: text('prompt.id'),
      };
    }
    default: {
      return { ...base, kind: 'event', name };
    }
  }
}

/** Records from an ExportLogsServiceRequest, or null when the body is not one. */
export function decodeLogs(body: unknown, now: number): TelemetryRecord[] | null {
  const parsed = logsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const records: TelemetryRecord[] = [];
  for (const group of parsed.data.resourceLogs ?? []) {
    const resource = attributesOf(group.resource?.attributes);
    for (const scope of group.scopeLogs ?? []) {
      for (const record of scope.logRecords ?? []) {
        const decoded = logRecord(record, resource, now);
        if (decoded !== null) {
          records.push(decoded);
        }
      }
    }
  }
  return records;
}

function spanRecord(span: OtlpSpan, resource: Attributes, now: number): TelemetryRecord {
  const attributes = attributesOf(span.attributes);
  const startTime = nanosToMs(span.startTimeUnixNano);
  const endTime = nanosToMs(span.endTimeUnixNano);
  const base = {
    time: endTime ?? startTime ?? now,
    sessionId: sessionOf(attributes, resource),
    attributes,
    resource,
    traceId: span.traceId ?? null,
    spanId: span.spanId ?? null,
    parentSpanId:
      span.parentSpanId === undefined || span.parentSpanId === '' ? null : span.parentSpanId,
    startTime,
    endTime,
  };
  if (span.name !== `${EVENT_PREFIX}llm_request`) {
    return { ...base, kind: 'span', name: span.name };
  }
  const elapsed = startTime !== null && endTime !== null ? endTime - startTime : null;
  return {
    ...base,
    kind: 'llm_request',
    requestId: readString(attributes, 'request_id') ?? readString(attributes, 'gen_ai.response.id'),
    model: readString(attributes, 'model'),
    ttftMs: readNumber(attributes, 'ttft_ms'),
    durationMs: readNumber(attributes, 'duration_ms') ?? elapsed,
    agentId: readString(attributes, 'agent_id'),
    parentAgentId: readString(attributes, 'parent_agent_id'),
    success: readBool(attributes, 'success'),
  };
}

/** Records from an ExportTraceServiceRequest, or null when the body is not one. */
export function decodeTraces(body: unknown, now: number): TelemetryRecord[] | null {
  const parsed = tracesRequestSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const records: TelemetryRecord[] = [];
  for (const group of parsed.data.resourceSpans ?? []) {
    const resource = attributesOf(group.resource?.attributes);
    for (const scope of group.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        records.push(spanRecord(span, resource, now));
      }
    }
  }
  return records;
}

/** Claude Code's exports, with claude_code.* event names. */
export const decode: TelemetryDecode = (signal, body, now) => {
  if (signal === 'metrics') {
    return decodeMetrics(body, now);
  }
  return signal === 'logs' ? decodeLogs(body, now) : decodeTraces(body, now);
};

/** The shared ApiRequest for an api_request event. Null when the event has no session id. */
export function toApiRequest(record: ApiRequestRecord, ttftMs: number | null): ApiRequest | null {
  if (record.sessionId === null) {
    return null;
  }
  const fallbackId = `otel:${record.sessionId}:${String(record.time)}:${String(record.sequence ?? 0)}`;
  return {
    messageId: record.requestId ?? fallbackId,
    requestId: record.requestId,
    sessionId: record.sessionId,
    agentId: readString(record.attributes, 'agent_id') ?? record.sessionId,
    model: record.model ?? 'unknown',
    timestamp: record.time,
    usage: {
      input: record.inputTokens,
      output: record.outputTokens,
      cacheRead: record.cacheReadTokens,
      cacheCreation: record.cacheCreationTokens,
      thinking: 0,
    },
    ttftMs,
    durationMs: record.durationMs,
    costUsd: record.costUsd,
  };
}

export interface TelemetryDecoderOptions {
  readonly bus: EventBus;
  readonly now?: () => number;
  /** How many request ids to remember for joining span timings to requests. */
  readonly maxTracked?: number;
  /** The agent's decoder from its telemetry facet. Claude Code's when left out. */
  readonly decode?: TelemetryDecode;
}

type Callback = (record: TelemetryRecord) => void;

/**
 * Feeds decoded exports to the bus and to onRecord listeners. The decoding is
 * the agent's. Joining span timings onto requests is shared.
 */
export class TelemetryDecoder {
  private readonly bus: EventBus;
  private readonly decode: TelemetryDecode;
  private readonly now: () => number;
  private readonly maxTracked: number;
  private readonly listeners = new Set<Callback>();
  private readonly requests = new Map<string, ApiRequest>();
  private readonly ttfts = new Map<string, number>();

  constructor(options: TelemetryDecoderOptions) {
    this.bus = options.bus;
    this.now = options.now ?? Date.now;
    this.maxTracked = options.maxTracked ?? 2000;
    this.decode = options.decode ?? decode;
  }

  onRecord(callback: Callback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Decodes one export body. Returns how many records it held, or -1 when it was not valid OTLP. */
  ingest(signal: OtlpSignal, body: unknown): number {
    const records = this.decode(signal, body, this.now());
    if (records === null) {
      this.bus.emit('source.error', { source: 'otel', message: `invalid OTLP ${signal} export` });
      return -1;
    }
    for (const record of records) {
      if (record.kind === 'api_request') {
        this.recordRequest(record);
      } else if (record.kind === 'llm_request') {
        this.recordSpan(record);
      }
      for (const listener of this.listeners) {
        listener(record);
      }
    }
    return records.length;
  }

  private recordRequest(record: ApiRequestRecord): void {
    const ttft = record.requestId === null ? undefined : this.ttfts.get(record.requestId);
    const request = toApiRequest(record, ttft ?? null);
    if (request === null) {
      return;
    }
    if (request.requestId !== null) {
      this.remember(this.requests, request.requestId, request);
    }
    this.bus.emit('request.recorded', request);
  }

  private recordSpan(record: LlmRequestSpanRecord): void {
    if (record.requestId === null || record.ttftMs === null) {
      return;
    }
    const known = this.requests.get(record.requestId);
    if (known === undefined) {
      this.remember(this.ttfts, record.requestId, record.ttftMs);
      return;
    }
    if (known.ttftMs === null) {
      const updated: ApiRequest = { ...known, ttftMs: record.ttftMs };
      this.requests.set(record.requestId, updated);
      this.bus.emit('request.recorded', updated);
    }
  }

  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    for (const oldest of map.keys()) {
      if (map.size <= this.maxTracked) {
        break;
      }
      map.delete(oldest);
    }
  }
}
