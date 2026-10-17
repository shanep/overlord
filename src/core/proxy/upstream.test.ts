import { describe, expect, it } from 'vitest';

import {
  abortError,
  jsonResponse,
  nullBodyResponse,
  sentBody,
  sseResponse,
  stubFetch,
  textResponse,
} from './test-helpers/fixtures.js';
import type {
  ConverseRequest,
  ConverseResponse,
  UpstreamConfig,
  UpstreamEvent,
} from './upstream.js';
import { callOnce, parseSseBlock, streamUpstream } from './upstream.js';

const CONFIG: UpstreamConfig = {
  endpoint: 'https://up.test/api-converse',
  apiKey: 'secret-key',
  timeoutMs: 65_000,
};

const REQUEST: ConverseRequest = {
  model_id: 'global.anthropic.claude-opus-5-5',
  messages: [{ role: 'user', content: 'hi' }],
};

const OK_RESPONSE: ConverseResponse = {
  role: 'assistant',
  content: 'Hi there',
  model_id: 'global.anthropic.claude-opus-5-5',
  usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
  stop_reason: 'end_turn',
  reasoning: null,
};

async function collect(
  stream: AsyncGenerator<UpstreamEvent, void, undefined>,
): Promise<UpstreamEvent[]> {
  const events: UpstreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('callOnce', () => {
  it('returns the parsed response and sends stream:false with the api key', async () => {
    const capture = stubFetch(() => jsonResponse(200, OK_RESPONSE));
    const result = await callOnce(CONFIG, REQUEST);
    expect(result).toStrictEqual({ ok: true, response: OK_RESPONSE });
    expect(sentBody(capture)).toStrictEqual({ ...REQUEST, stream: false });
    const sentHeaders = new Headers(capture.calls[0]?.init.headers);
    expect(sentHeaders.get('x-api-key')).toBe('secret-key');
  });

  it('maps 401 to an auth error using the detail field', async () => {
    stubFetch(() => jsonResponse(401, { detail: 'bad key' }));
    const result = await callOnce(CONFIG, REQUEST);
    expect(result).toStrictEqual({
      ok: false,
      error: { status: 401, code: 'auth', message: 'bad key' },
    });
  });

  it('maps 403 to a model-access error', async () => {
    stubFetch(() => jsonResponse(403, { detail: 'no access' }));
    const result = await callOnce(CONFIG, REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.error.code).toBe('model_access');
  });

  it('maps 422 to a bad-request error and keeps a non-JSON body as the message', async () => {
    stubFetch(() => textResponse(422, 'invalid field'));
    const result = await callOnce(CONFIG, REQUEST);
    expect(result).toStrictEqual({
      ok: false,
      error: { status: 422, code: 'bad_request', message: 'invalid field' },
    });
  });

  it('maps 504 to a fixed timeout message', async () => {
    stubFetch(() => textResponse(504, '<html>Gateway Timeout</html>'));
    const result = await callOnce(CONFIG, REQUEST);
    expect(result).toStrictEqual({
      ok: false,
      error: {
        status: 504,
        code: 'timeout',
        message: 'The backend did not respond within its time limit (about 60 seconds).',
      },
    });
  });

  it('labels an empty error body with the status code', async () => {
    stubFetch(() => textResponse(500, ''));
    const result = await callOnce(CONFIG, REQUEST);
    expect(result).toStrictEqual({
      ok: false,
      error: { status: 500, code: 'upstream', message: 'HTTP 500' },
    });
  });

  it('rejects a 200 body that is not valid JSON', async () => {
    stubFetch(() => new Response('not json', { status: 200 }));
    const result = await callOnce(CONFIG, REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.error.status).toBe(502);
    expect(result.error.code).toBe('upstream');
  });

  it('rejects a 200 body that does not match the schema', async () => {
    stubFetch(() => jsonResponse(200, { unexpected: true }));
    const result = await callOnce(CONFIG, REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.error.status).toBe(502);
  });

  it('maps an aborted request to a timeout', async () => {
    stubFetch(() => {
      throw abortError();
    });
    const result = await callOnce(CONFIG, REQUEST);
    expect(result).toStrictEqual({
      ok: false,
      error: {
        status: 504,
        code: 'timeout',
        message: 'The backend did not respond within 65 seconds.',
      },
    });
  });

  it('maps any other fetch failure to a 502', async () => {
    stubFetch(() => {
      throw new Error('socket hang up');
    });
    const result = await callOnce(CONFIG, REQUEST);
    expect(result).toStrictEqual({
      ok: false,
      error: { status: 502, code: 'upstream', message: 'socket hang up' },
    });
  });
});

describe('streamUpstream', () => {
  it('yields normalized events for a full stream and sends stream:true', async () => {
    const capture = stubFetch(() =>
      sseResponse([
        'event: message_start\ndata: {"role":"assistant"}',
        'event: content_block_delta\ndata: {"contentBlockIndex":0,"type":"text","text":"Hel"}',
        'event: content_block_delta\ndata: {"contentBlockIndex":0,"type":"text","text":"lo"}',
        'event: message_stop\ndata: {"stopReason":"end_turn"}',
        'event: metadata\ndata: {"usage":{"inputTokens":5,"outputTokens":2,"totalTokens":7}}',
        'event: done\ndata: {}',
      ]),
    );
    const events = await collect(streamUpstream(CONFIG, REQUEST));
    expect(events).toStrictEqual([
      { kind: 'start' },
      { kind: 'text', text: 'Hel' },
      { kind: 'text', text: 'lo' },
      { kind: 'stop', stopReason: 'end_turn' },
      { kind: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      { kind: 'done' },
    ]);
    expect(sentBody(capture)).toStrictEqual({ ...REQUEST, stream: true });
  });

  it('yields a single error event for a non-ok status', async () => {
    stubFetch(() => jsonResponse(403, { detail: 'no access' }));
    const events = await collect(streamUpstream(CONFIG, REQUEST));
    expect(events).toStrictEqual([
      { kind: 'error', error: { status: 403, code: 'model_access', message: 'no access' } },
    ]);
  });

  it('yields an error event when the response has no body', async () => {
    stubFetch(() => nullBodyResponse(200));
    const events = await collect(streamUpstream(CONFIG, REQUEST));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
  });

  it('yields a timeout error when the request is aborted', async () => {
    stubFetch(() => {
      throw abortError();
    });
    const events = await collect(streamUpstream(CONFIG, REQUEST));
    expect(events).toStrictEqual([
      {
        kind: 'error',
        error: {
          status: 504,
          code: 'timeout',
          message: 'The backend did not respond within 65 seconds.',
        },
      },
    ]);
  });

  it('yields an error event when reading the body fails mid-stream', async () => {
    const erroringBody: unknown = {
      getReader: (): { read: () => Promise<never> } => ({
        // A reader whose read rejects, to drive the mid-stream error path. This
        // stub mirrors a Web API shape, so it returns a promise without `async`.
        // eslint-disable-next-line @typescript-eslint/promise-function-async
        read: (): Promise<never> => Promise.reject(new Error('mid-stream')),
      }),
    };
    const fakeResponse: unknown = { ok: true, status: 200, body: erroringBody };
    // Response contains `any` members, so the deliberately partial stub cast is
    // not fully typed; that is expected for this fake.
    // type-coverage:ignore-next-line
    stubFetch(() => fakeResponse as Response);
    const events = await collect(streamUpstream(CONFIG, REQUEST));
    expect(events).toStrictEqual([
      { kind: 'error', error: { status: 502, code: 'upstream', message: 'mid-stream' } },
    ]);
  });
});

describe('parseSseBlock', () => {
  it('returns null for a block with no event line', () => {
    expect(parseSseBlock('data: {"x":1}')).toBeNull();
  });

  it('parses text deltas and ignores non-text or malformed deltas', () => {
    expect(
      parseSseBlock('event: content_block_delta\ndata: {"type":"text","text":"hi"}'),
    ).toStrictEqual({ kind: 'text', text: 'hi' });
    expect(parseSseBlock('event: content_block_delta\ndata: {"type":"thinking"}')).toBeNull();
    expect(parseSseBlock('event: content_block_delta\ndata: not-json')).toBeNull();
  });

  it('parses stop and metadata events and rejects malformed ones', () => {
    expect(parseSseBlock('event: message_stop\ndata: {"stopReason":"max_tokens"}')).toStrictEqual({
      kind: 'stop',
      stopReason: 'max_tokens',
    });
    expect(parseSseBlock('event: message_stop\ndata: {}')).toBeNull();
    expect(
      parseSseBlock(
        'event: metadata\ndata: {"usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}',
      ),
    ).toStrictEqual({ kind: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    expect(parseSseBlock('event: metadata\ndata: {"usage":{}}')).toBeNull();
  });

  it('maps start and done, and ignores unknown events', () => {
    expect(parseSseBlock('event: message_start\ndata: {}')).toStrictEqual({ kind: 'start' });
    expect(parseSseBlock('event: done\ndata: {}')).toStrictEqual({ kind: 'done' });
    expect(parseSseBlock('event: content_block_stop\ndata: {"contentBlockIndex":0}')).toBeNull();
  });
});
