import { describe, expect, it } from 'vitest';

import type { ApiRequest } from '../../shared/model.js';
import { EventBus } from '../bus.js';

import {
  decode,
  decodeLogs,
  decodeMetrics,
  decodeTraces,
  eventName,
  TelemetryDecoder,
  toApiRequest,
} from './decode.js';
import type { ApiRequestRecord, TelemetryRecord } from './records.js';

type Scalar = string | number | boolean;

function kv(key: string, value: Scalar): { key: string; value: Record<string, Scalar> } {
  if (typeof value === 'string') {
    return { key, value: { stringValue: value } };
  }
  if (typeof value === 'boolean') {
    return { key, value: { boolValue: value } };
  }
  return Number.isInteger(value)
    ? { key, value: { intValue: String(value) } }
    : { key, value: { doubleValue: value } };
}

function kvs(
  attributes: Readonly<Record<string, Scalar>>,
): { key: string; value: Record<string, Scalar> }[] {
  return Object.entries(attributes).map(([key, value]) => kv(key, value));
}

const NANOS = '1700000000000000000';
const MS = 1_700_000_000_000;

function logs(
  records: readonly unknown[],
  resource: Readonly<Record<string, Scalar>> = {},
): unknown {
  return {
    resourceLogs: [
      { resource: { attributes: kvs(resource) }, scopeLogs: [{ logRecords: records }] },
    ],
  };
}

function logRecord(name: string, attributes: Readonly<Record<string, Scalar>>): unknown {
  return {
    timeUnixNano: NANOS,
    body: { stringValue: `claude_code.${name}` },
    attributes: kvs({ 'event.name': name, ...attributes }),
  };
}

function spans(list: readonly unknown[]): unknown {
  return { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: list }] }] };
}

function llmSpan(attributes: Readonly<Record<string, Scalar>>): unknown {
  return {
    traceId: 't1',
    spanId: 's1',
    parentSpanId: 'p1',
    name: 'claude_code.llm_request',
    startTimeUnixNano: NANOS,
    endTimeUnixNano: '1700000000250000000',
    attributes: kvs(attributes),
  };
}

const apiAttributes = {
  'session.id': 'sess',
  model: 'claude-opus-5',
  cost_usd: 0.0125,
  duration_ms: 900,
  input_tokens: 10,
  output_tokens: 20,
  cache_read_tokens: 30,
  cache_creation_tokens: 40,
  request_id: 'req_1',
  query_source: 'repl_main_thread',
  'event.sequence': 7,
  'event.timestamp': '2026-10-15T12:00:00.000Z',
};

function apiRecord(overrides: Partial<ApiRequestRecord>): ApiRequestRecord {
  const [decoded] = decodeLogs(logs([logRecord('api_request', apiAttributes)]), 0) ?? [];
  if (decoded?.kind !== 'api_request') {
    throw new Error('expected an api_request record');
  }
  return { ...decoded, ...overrides };
}

function setup(maxTracked?: number): {
  decoder: TelemetryDecoder;
  requests: ApiRequest[];
  records: TelemetryRecord[];
  errors: string[];
} {
  const bus = new EventBus();
  const decoder = new TelemetryDecoder(
    maxTracked === undefined
      ? { bus, now: (): number => 1 }
      : { bus, now: (): number => 1, maxTracked },
  );
  const requests: ApiRequest[] = [];
  const records: TelemetryRecord[] = [];
  const errors: string[] = [];
  bus.on('request.recorded', (request) => requests.push(request));
  bus.on('source.error', (error) => errors.push(`${error.source}: ${error.message}`));
  decoder.onRecord((record) => records.push(record));
  return { decoder, requests, records, errors };
}

describe('decodeMetrics', () => {
  it('decodes sum, gauge and histogram points', () => {
    const body = {
      resourceMetrics: [
        {
          resource: {
            attributes: kvs({ 'service.name': 'claude-code', 'session.id': 'res-sess' }),
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.cost.usage',
                  unit: 'USD',
                  sum: {
                    dataPoints: [
                      {
                        attributes: kvs({ model: 'opus', 'session.id': 'sess' }),
                        timeUnixNano: NANOS,
                        startTimeUnixNano: '1699999999000000000',
                        asDouble: 0.25,
                      },
                      { attributes: [], asInt: '3' },
                      { attributes: [] },
                    ],
                  },
                },
                {
                  name: 'claude_code.active_time.total',
                  gauge: { dataPoints: [{ asInt: 12, timeUnixNano: NANOS }] },
                },
                {
                  name: 'some.histogram',
                  histogram: { dataPoints: [{ sum: '4.5' }, { count: 2 }] },
                },
                { name: 'claude_code.empty' },
              ],
            },
            {},
          ],
        },
        {},
      ],
    };
    const records = decodeMetrics(body, 5);
    expect(records).toStrictEqual([
      {
        kind: 'metric',
        name: 'claude_code.cost.usage',
        metricType: 'sum',
        unit: 'USD',
        value: 0.25,
        time: MS,
        startTime: MS - 1000,
        sessionId: 'sess',
        attributes: { model: 'opus', 'session.id': 'sess' },
        resource: { 'service.name': 'claude-code', 'session.id': 'res-sess' },
      },
      {
        kind: 'metric',
        name: 'claude_code.cost.usage',
        metricType: 'sum',
        unit: 'USD',
        value: 3,
        time: 5,
        startTime: null,
        sessionId: 'res-sess',
        attributes: {},
        resource: { 'service.name': 'claude-code', 'session.id': 'res-sess' },
      },
      {
        kind: 'metric',
        name: 'claude_code.active_time.total',
        metricType: 'gauge',
        unit: null,
        value: 12,
        time: MS,
        startTime: null,
        sessionId: 'res-sess',
        attributes: {},
        resource: { 'service.name': 'claude-code', 'session.id': 'res-sess' },
      },
      {
        kind: 'metric',
        name: 'some.histogram',
        metricType: 'histogram',
        unit: null,
        value: 4.5,
        time: 5,
        startTime: null,
        sessionId: 'res-sess',
        attributes: {},
        resource: { 'service.name': 'claude-code', 'session.id': 'res-sess' },
      },
    ]);
  });

  it('accepts an empty export and rejects a wrong shape', () => {
    expect(decodeMetrics({}, 0)).toStrictEqual([]);
    expect(decodeMetrics({ resourceMetrics: 'x' }, 0)).toBeNull();
    expect(decodeMetrics(null, 0)).toBeNull();
  });
});

describe('eventName', () => {
  it('prefers a claude_code body and falls back to event.name', () => {
    expect(eventName({ stringValue: 'claude_code.api_request' }, {})).toBe('api_request');
    expect(eventName({ stringValue: 'other' }, { 'event.name': 'tool_result' })).toBe(
      'tool_result',
    );
    expect(eventName(undefined, { 'event.name': 'claude_code.user_prompt' })).toBe('user_prompt');
    expect(eventName(undefined, { 'event.name': '' })).toBeNull();
    expect(eventName(undefined, {})).toBeNull();
  });
});

describe('decodeLogs', () => {
  it('decodes an api_request event', () => {
    const records = decodeLogs(
      logs([logRecord('api_request', apiAttributes)], { 'service.name': 'cc' }),
      1,
    );
    expect(records).toHaveLength(1);
    expect(records?.[0]).toStrictEqual({
      kind: 'api_request',
      time: Date.parse('2026-10-15T12:00:00.000Z'),
      sessionId: 'sess',
      attributes: { 'event.name': 'api_request', ...apiAttributes },
      resource: { 'service.name': 'cc' },
      model: 'claude-opus-5',
      costUsd: 0.0125,
      durationMs: 900,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      requestId: 'req_1',
      querySource: 'repl_main_thread',
      sequence: 7,
    });
  });

  it('defaults missing api_request fields', () => {
    const [record] = decodeLogs(logs([logRecord('api_request', {})]), 1) ?? [];
    expect(record).toMatchObject({
      kind: 'api_request',
      time: MS,
      sessionId: null,
      model: null,
      costUsd: null,
      durationMs: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      requestId: null,
      querySource: null,
      sequence: null,
    });
  });

  it('decodes api_error, tool_result, tool_decision and user_prompt', () => {
    const records = decodeLogs(
      logs([
        logRecord('api_error', {
          model: 'm',
          error: 'overloaded',
          status_code: 529,
          duration_ms: 50,
          attempt: 2,
          request_id: 'req_2',
        }),
        logRecord('tool_result', {
          tool_name: 'Bash',
          tool_use_id: 'toolu_1',
          success: 'false',
          duration_ms: 12,
          error_type: 'ShellError',
          decision_source: 'hook',
        }),
        logRecord('tool_decision', {
          tool_name: 'Edit',
          tool_use_id: 'toolu_2',
          decision: 'reject',
          source: 'user_reject',
        }),
        logRecord('user_prompt', { prompt_length: 42, 'prompt.id': 'p-1' }),
        logRecord('permission_mode_changed', { to_mode: 'plan' }),
      ]),
      1,
    );
    expect(records?.map((record) => record.kind)).toStrictEqual([
      'api_error',
      'tool_result',
      'tool_decision',
      'user_prompt',
      'event',
    ]);
    expect(records?.[0]).toMatchObject({
      model: 'm',
      error: 'overloaded',
      statusCode: 529,
      durationMs: 50,
      attempt: 2,
      requestId: 'req_2',
    });
    expect(records?.[1]).toMatchObject({
      toolName: 'Bash',
      toolUseId: 'toolu_1',
      success: false,
      durationMs: 12,
      errorType: 'ShellError',
      decisionSource: 'hook',
    });
    expect(records?.[2]).toMatchObject({
      toolName: 'Edit',
      toolUseId: 'toolu_2',
      decision: 'reject',
      source: 'user_reject',
    });
    expect(records?.[3]).toMatchObject({ promptLength: 42, promptId: 'p-1' });
    expect(records?.[4]).toMatchObject({ kind: 'event', name: 'permission_mode_changed' });
  });

  it('picks the event time from the timestamp, then the record, then now', () => {
    const records = decodeLogs(
      logs([
        {
          body: { stringValue: 'claude_code.x' },
          attributes: kvs({ 'event.timestamp': 'bad' }),
          observedTimeUnixNano: NANOS,
        },
        { body: { stringValue: 'claude_code.x' }, timeUnixNano: '0' },
      ]),
      77,
    );
    expect(records?.map((record) => record.time)).toStrictEqual([MS, 77]);
  });

  it('skips records without an event name and rejects a wrong shape', () => {
    expect(decodeLogs(logs([{ body: { stringValue: 'hello' } }]), 0)).toStrictEqual([]);
    expect(decodeLogs({ resourceLogs: [{ scopeLogs: [{}] }, {}] }, 0)).toStrictEqual([]);
    expect(decodeLogs({}, 0)).toStrictEqual([]);
    expect(decodeLogs({ resourceLogs: [{ scopeLogs: 5 }] }, 0)).toBeNull();
  });
});

describe('decodeTraces', () => {
  it('decodes llm_request spans', () => {
    const records = decodeTraces(
      spans([
        llmSpan({
          'session.id': 'sess',
          request_id: 'req_1',
          model: 'opus',
          ttft_ms: 120,
          duration_ms: 240,
          agent_id: 'a1',
          parent_agent_id: 'a0',
          success: true,
        }),
      ]),
      0,
    );
    expect(records).toStrictEqual([
      {
        kind: 'llm_request',
        time: MS + 250,
        sessionId: 'sess',
        attributes: {
          'session.id': 'sess',
          request_id: 'req_1',
          model: 'opus',
          ttft_ms: 120,
          duration_ms: 240,
          agent_id: 'a1',
          parent_agent_id: 'a0',
          success: true,
        },
        resource: {},
        traceId: 't1',
        spanId: 's1',
        parentSpanId: 'p1',
        startTime: MS,
        endTime: MS + 250,
        requestId: 'req_1',
        model: 'opus',
        ttftMs: 120,
        durationMs: 240,
        agentId: 'a1',
        parentAgentId: 'a0',
        success: true,
      },
    ]);
  });

  it('falls back to gen_ai.response.id and the span length', () => {
    const [record] = decodeTraces(spans([llmSpan({ 'gen_ai.response.id': 'req_9' })]), 0) ?? [];
    expect(record).toMatchObject({
      requestId: 'req_9',
      durationMs: 250,
      ttftMs: null,
      success: null,
    });
    const [open] =
      decodeTraces(spans([{ name: 'claude_code.llm_request', startTimeUnixNano: NANOS }]), 0) ?? [];
    expect(open).toMatchObject({ durationMs: null, time: MS, endTime: null, requestId: null });
    const [late] =
      decodeTraces(spans([{ name: 'claude_code.llm_request', endTimeUnixNano: NANOS }]), 0) ?? [];
    expect(late).toMatchObject({ durationMs: null, startTime: null });
  });

  it('keeps other spans generic', () => {
    const records = decodeTraces(
      spans([{ name: 'claude_code.tool', parentSpanId: '' }, { name: 'claude_code.interaction' }]),
      9,
    );
    expect(records).toStrictEqual([
      {
        kind: 'span',
        name: 'claude_code.tool',
        time: 9,
        sessionId: null,
        attributes: {},
        resource: {},
        traceId: null,
        spanId: null,
        parentSpanId: null,
        startTime: null,
        endTime: null,
      },
      {
        kind: 'span',
        name: 'claude_code.interaction',
        time: 9,
        sessionId: null,
        attributes: {},
        resource: {},
        traceId: null,
        spanId: null,
        parentSpanId: null,
        startTime: null,
        endTime: null,
      },
    ]);
  });

  it('accepts an empty export and rejects a wrong shape', () => {
    expect(decodeTraces({ resourceSpans: [{}, { scopeSpans: [{}] }] }, 0)).toStrictEqual([]);
    expect(decodeTraces({}, 0)).toStrictEqual([]);
    expect(decodeTraces({ resourceSpans: [{ scopeSpans: [{ spans: [{}] }] }] }, 0)).toBeNull();
  });
});

describe('decode', () => {
  it('routes by signal', () => {
    expect(decode('metrics', { resourceMetrics: [] }, 0)).toStrictEqual([]);
    expect(decode('logs', logs([logRecord('x', {})]), 0)).toHaveLength(1);
    expect(decode('traces', spans([{ name: 'n' }]), 0)).toHaveLength(1);
    expect(decode('metrics', logs([logRecord('x', {})]), 0)).toStrictEqual([]);
    expect(decode('logs', { resourceLogs: 1 }, 0)).toBeNull();
    expect(decode('traces', { resourceSpans: 1 }, 0)).toBeNull();
  });
});

describe('toApiRequest', () => {
  it('builds an ApiRequest keyed by request id', () => {
    expect(toApiRequest(apiRecord({}), 33)).toStrictEqual({
      messageId: 'req_1',
      requestId: 'req_1',
      sessionId: 'sess',
      agentId: 'sess',
      model: 'claude-opus-5',
      timestamp: Date.parse('2026-10-15T12:00:00.000Z'),
      usage: { input: 10, output: 20, cacheRead: 30, cacheCreation: 40, thinking: 0 },
      ttftMs: 33,
      durationMs: 900,
      costUsd: 0.0125,
    });
  });

  it('falls back when ids and model are missing', () => {
    const request = toApiRequest(
      apiRecord({ requestId: null, model: null, time: 5, attributes: { agent_id: 'a1' } }),
      null,
    );
    expect(request).toMatchObject({
      messageId: 'otel:sess:5:7',
      requestId: null,
      agentId: 'a1',
      model: 'unknown',
      ttftMs: null,
    });
    expect(
      toApiRequest(apiRecord({ requestId: null, sequence: null, time: 5 }), null)?.messageId,
    ).toBe('otel:sess:5:0');
    expect(toApiRequest(apiRecord({ sessionId: null }), null)).toBeNull();
  });
});

describe('TelemetryDecoder', () => {
  it('emits requests and passes every record to onRecord', () => {
    const { decoder, requests, records } = setup();
    const count = decoder.ingest(
      'logs',
      logs([
        logRecord('api_request', apiAttributes),
        logRecord('tool_result', { tool_name: 'Read' }),
      ]),
    );
    expect(count).toBe(2);
    expect(requests.map((request) => request.messageId)).toStrictEqual(['req_1']);
    expect(records.map((record) => record.kind)).toStrictEqual(['api_request', 'tool_result']);
  });

  it('does not emit requests without a session', () => {
    const { decoder, requests, records } = setup();
    decoder.ingest('logs', logs([logRecord('api_request', { request_id: 'r' })]));
    expect(requests).toStrictEqual([]);
    expect(records).toHaveLength(1);
  });

  it('reports an invalid export', () => {
    const { decoder, errors } = setup();
    expect(decoder.ingest('traces', 'nope')).toBe(-1);
    expect(errors).toStrictEqual(['otel: invalid OTLP traces export']);
  });

  it('adds time to first token when the span follows the event', () => {
    const { decoder, requests } = setup();
    decoder.ingest('logs', logs([logRecord('api_request', apiAttributes)]));
    decoder.ingest('traces', spans([llmSpan({ request_id: 'req_1', ttft_ms: 80 })]));
    decoder.ingest('traces', spans([llmSpan({ request_id: 'req_1', ttft_ms: 99 })]));
    expect(requests.map((request) => request.ttftMs)).toStrictEqual([null, 80]);
    expect(requests[1]?.messageId).toBe('req_1');
  });

  it('adds time to first token when the span comes first', () => {
    const { decoder, requests } = setup();
    decoder.ingest('traces', spans([llmSpan({ request_id: 'req_1', ttft_ms: 55 })]));
    decoder.ingest('logs', logs([logRecord('api_request', apiAttributes)]));
    expect(requests.map((request) => request.ttftMs)).toStrictEqual([55]);
  });

  it('ignores spans without a request id or ttft', () => {
    const { decoder, requests, records } = setup();
    decoder.ingest('logs', logs([logRecord('api_request', apiAttributes)]));
    decoder.ingest('traces', spans([llmSpan({ ttft_ms: 5 }), llmSpan({ request_id: 'req_1' })]));
    expect(requests).toHaveLength(1);
    expect(records).toHaveLength(3);
  });

  it('does not track requests without an id', () => {
    const { decoder, requests } = setup();
    const withoutId = Object.fromEntries(
      Object.entries(apiAttributes).filter(([key]) => key !== 'request_id'),
    );
    decoder.ingest('logs', logs([logRecord('api_request', withoutId)]));
    decoder.ingest('traces', spans([llmSpan({ request_id: 'otel:sess:0:7', ttft_ms: 5 })]));
    expect(requests.map((request) => request.ttftMs)).toStrictEqual([null]);
  });

  it('forgets the oldest ids past its limit', () => {
    const { decoder, requests } = setup(2);
    for (const id of ['a', 'b', 'c']) {
      decoder.ingest(
        'logs',
        logs([logRecord('api_request', { ...apiAttributes, request_id: id })]),
      );
    }
    decoder.ingest('traces', spans([llmSpan({ request_id: 'a', ttft_ms: 1 })]));
    decoder.ingest('traces', spans([llmSpan({ request_id: 'b', ttft_ms: 2 })]));
    decoder.ingest('traces', spans([llmSpan({ request_id: 'c', ttft_ms: 3 })]));
    expect(requests.map((request) => [request.messageId, request.ttftMs])).toStrictEqual([
      ['a', null],
      ['b', null],
      ['c', null],
      ['b', 2],
      ['c', 3],
    ]);
  });

  it('refreshes an id it sees again so it is not evicted first', () => {
    const { decoder, requests } = setup(2);
    for (const id of ['a', 'b', 'a', 'c']) {
      decoder.ingest(
        'logs',
        logs([logRecord('api_request', { ...apiAttributes, request_id: id })]),
      );
    }
    decoder.ingest('traces', spans([llmSpan({ request_id: 'a', ttft_ms: 1 })]));
    decoder.ingest('traces', spans([llmSpan({ request_id: 'b', ttft_ms: 2 })]));
    expect(requests.slice(4).map((request) => [request.messageId, request.ttftMs])).toStrictEqual([
      ['a', 1],
    ]);
  });

  it('keeps 2000 ids by default and stops listening on unsubscribe', () => {
    const bus = new EventBus();
    const decoder = new TelemetryDecoder({ bus });
    const requests: ApiRequest[] = [];
    bus.on('request.recorded', (request) => requests.push(request));
    for (let index = 0; index <= 2000; index += 1) {
      decoder.ingest(
        'logs',
        logs([logRecord('api_request', { ...apiAttributes, request_id: `r${String(index)}` })]),
      );
    }
    decoder.ingest('traces', spans([llmSpan({ request_id: 'r0', ttft_ms: 1 })]));
    decoder.ingest('traces', spans([llmSpan({ request_id: 'r1', ttft_ms: 1 })]));
    expect(requests.at(-1)?.messageId).toBe('r1');
    expect(requests).toHaveLength(2002);
    const seen: TelemetryRecord[] = [];
    const off = decoder.onRecord((record) => seen.push(record));
    off();
    decoder.ingest('traces', spans([{ name: 'n' }]));
    expect(seen).toStrictEqual([]);
  });
});
