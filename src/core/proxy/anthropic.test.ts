import { describe, expect, it } from 'vitest';

import {
  anthropicError,
  countTokensHandler,
  makeAnthropicHandler,
  messageBody,
  modelsHandler,
  parseAnthropicRequest,
} from './anthropic.js';
import {
  fakeResponder,
  jsonResponse,
  parseData,
  sseResponse,
  stubFetch,
} from './test-helpers/fixtures.js';
import type { ConverseResponse, UpstreamConfig } from './upstream.js';

const CONFIG: UpstreamConfig = {
  endpoint: 'https://up.test/api-converse',
  apiKey: 'secret-key',
  timeoutMs: 65_000,
};

function okResponse(stopReason = 'end_turn'): ConverseResponse {
  return {
    role: 'assistant',
    content: 'Hi there',
    model_id: 'global.anthropic.claude-opus-5-5',
    usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    stop_reason: stopReason,
    reasoning: null,
  };
}

function names(events: readonly { readonly name: string | null }[]): (string | null)[] {
  return events.map((event) => event.name);
}

describe('parseAnthropicRequest', () => {
  it('rejects a body with no messages', () => {
    const result = parseAnthropicRequest({});
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.status).toBe(400);
  });

  it('flattens text and tool_result blocks, ignoring tool_use and images', () => {
    const result = parseAnthropicRequest({
      model: 'opus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'tool_use', id: 't1' },
            { type: 'tool_result', content: 'r' },
            { type: 'image', source: {} },
          ],
        },
      ],
    });
    if (!result.ok) {
      throw new Error('expected ok');
    }
    expect(result.chat.messages).toStrictEqual([{ role: 'user', content: 'ar' }]);
  });

  it('reads tool_result array content and ignores non-array content', () => {
    const arrayResult = parseAnthropicRequest({
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', content: [{ type: 'text', text: 'x' }] }],
        },
      ],
    });
    const numberResult = parseAnthropicRequest({
      messages: [{ role: 'user', content: [{ type: 'tool_result', content: 42 }] }],
    });
    if (!arrayResult.ok || !numberResult.ok) {
      throw new Error('expected ok');
    }
    expect(arrayResult.chat.messages[0]?.content).toBe('x');
    expect(numberResult.chat.messages[0]?.content).toBe('');
  });

  it('reads a system prompt as a string or an array of blocks', () => {
    const asString = parseAnthropicRequest({
      system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const asBlocks = parseAnthropicRequest({
      system: [
        { type: 'text', text: 'be ' },
        { type: 'text', text: 'brief' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    if (!asString.ok || !asBlocks.ok) {
      throw new Error('expected ok');
    }
    expect(asString.chat.systemPrompt).toBe('be brief');
    expect(asBlocks.chat.systemPrompt).toBe('be brief');
  });

  it('folds a system-role message into the system prompt (Claude Code shape)', () => {
    const result = parseAnthropicRequest({
      system: 'top',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'system', content: [{ type: 'text', text: 'a reminder' }] },
      ],
    });
    if (!result.ok) {
      throw new Error('expected ok');
    }
    expect(result.chat.messages).toStrictEqual([{ role: 'user', content: 'hi' }]);
    expect(result.chat.systemPrompt).toBe('top\n\na reminder');
  });

  it("strips Claude Code's billing line, which makes the backend drop the system prompt", () => {
    const header = 'x-anthropic-billing-header: cc_version=2.1; cc_entrypoint=cli;';
    const asBlocks = parseAnthropicRequest({
      system: [
        { type: 'text', text: header },
        { type: 'text', text: 'be brief' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const asString = parseAnthropicRequest({
      system: `${header}\nbe brief`,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const only = parseAnthropicRequest({
      system: header,
      messages: [{ role: 'user', content: 'hi' }],
    });
    if (!asBlocks.ok || !asString.ok || !only.ok) {
      throw new Error('expected ok');
    }
    expect(asBlocks.chat.systemPrompt).toBe('be brief');
    expect(asString.chat.systemPrompt).toBe('be brief');
    expect(only.chat.systemPrompt).toBeNull();
  });

  it('treats a missing or empty system prompt as null', () => {
    const missing = parseAnthropicRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const empty = parseAnthropicRequest({
      system: '',
      messages: [{ role: 'user', content: 'hi' }],
    });
    if (!missing.ok || !empty.ok) {
      throw new Error('expected ok');
    }
    expect(missing.chat.systemPrompt).toBeNull();
    expect(empty.chat.systemPrompt).toBeNull();
  });
});

describe('anthropicError and messageBody', () => {
  it('maps status codes to Anthropic error types', () => {
    expect(anthropicError('x', 403)).toStrictEqual({
      type: 'error',
      error: { type: 'permission_error', message: 'x' },
    });
    expect(anthropicError('x', 404)).toMatchObject({ error: { type: 'not_found_error' } });
    expect(anthropicError('x', 413)).toMatchObject({ error: { type: 'request_too_large' } });
    expect(anthropicError('x', 500)).toMatchObject({ error: { type: 'api_error' } });
    expect(anthropicError('x', 400)).toMatchObject({ error: { type: 'invalid_request_error' } });
  });

  it('keeps a known stop reason and defaults an unknown one', () => {
    expect(messageBody(okResponse('tool_use'), 'm')).toMatchObject({ stop_reason: 'tool_use' });
    expect(messageBody(okResponse('weird'), 'm')).toMatchObject({ stop_reason: 'end_turn' });
  });
});

describe('makeAnthropicHandler (non-streaming)', () => {
  it('renders a message object', async () => {
    stubFetch(() => jsonResponse(200, okResponse()));
    const { responder, rec } = fakeResponder();
    await makeAnthropicHandler(CONFIG)(
      { model: 'opus', messages: [{ role: 'user', content: 'hi' }] },
      responder,
    );
    expect(rec.json[0]?.status).toBe(200);
    expect(rec.json[0]?.body).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    });
  });

  it('returns a 400 error body for an invalid request', async () => {
    const { responder, rec } = fakeResponder();
    await makeAnthropicHandler(CONFIG)({ messages: [] }, responder);
    expect(rec.json[0]?.status).toBe(400);
    expect(rec.json[0]?.body).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error' },
    });
  });

  it('forwards an upstream error with its status', async () => {
    stubFetch(() => jsonResponse(401, { detail: 'bad key' }));
    const { responder, rec } = fakeResponder();
    await makeAnthropicHandler(CONFIG)({ messages: [{ role: 'user', content: 'hi' }] }, responder);
    expect(rec.json[0]?.status).toBe(401);
    expect(rec.json[0]?.body).toMatchObject({
      error: { type: 'authentication_error', message: 'bad key' },
    });
  });
});

describe('makeAnthropicHandler (streaming)', () => {
  it('emits the full message event sequence with usage from metadata', async () => {
    stubFetch(() =>
      sseResponse([
        'event: message_start\ndata: {"role":"assistant"}',
        'event: content_block_delta\ndata: {"type":"text","text":"Hello"}',
        'event: message_stop\ndata: {"stopReason":"end_turn"}',
        'event: metadata\ndata: {"usage":{"inputTokens":5,"outputTokens":2,"totalTokens":7}}',
        'event: done\ndata: {}',
      ]),
    );
    const { responder, rec } = fakeResponder();
    await makeAnthropicHandler(CONFIG)(
      { messages: [{ role: 'user', content: 'hi' }], stream: true },
      responder,
    );
    expect(names(rec.events)).toStrictEqual([
      'message_start',
      'content_block_start',
      'ping',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(parseData(rec.events[3]?.data ?? '')).toMatchObject({
      delta: { type: 'text_delta', text: 'Hello' },
    });
    expect(parseData(rec.events[5]?.data ?? '')).toMatchObject({
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    });
    expect(rec.ended).toBe(true);
  });

  it('estimates output tokens when the stream carries no usage metadata', async () => {
    stubFetch(() =>
      sseResponse([
        'event: content_block_delta\ndata: {"type":"text","text":"Hi"}',
        'event: message_stop\ndata: {"stopReason":"end_turn"}',
      ]),
    );
    const { responder, rec } = fakeResponder();
    await makeAnthropicHandler(CONFIG)(
      { messages: [{ role: 'user', content: 'hi' }], stream: true },
      responder,
    );
    const delta = rec.events.find((event) => event.name === 'message_delta');
    expect(parseData(delta?.data ?? '')).toMatchObject({ usage: { output_tokens: 1 } });
  });

  it('emits an error event and stops when the upstream fails', async () => {
    stubFetch(() => jsonResponse(403, { detail: 'no access' }));
    const { responder, rec } = fakeResponder();
    await makeAnthropicHandler(CONFIG)(
      { messages: [{ role: 'user', content: 'hi' }], stream: true },
      responder,
    );
    expect(names(rec.events)).toStrictEqual([
      'message_start',
      'content_block_start',
      'ping',
      'error',
    ]);
    expect(parseData(rec.events[3]?.data ?? '')).toMatchObject({ error: { message: 'no access' } });
    expect(rec.ended).toBe(true);
  });

  it('stops pulling once the client has disconnected', async () => {
    stubFetch(() => sseResponse(['event: content_block_delta\ndata: {"type":"text","text":"x"}']));
    const { responder, rec } = fakeResponder(3);
    await makeAnthropicHandler(CONFIG)(
      { messages: [{ role: 'user', content: 'hi' }], stream: true },
      responder,
    );
    expect(names(rec.events)).not.toContain('content_block_delta');
  });
});

describe('countTokensHandler and modelsHandler', () => {
  it('estimates tokens for a valid body and falls back to one', () => {
    const valid = fakeResponder();
    void countTokensHandler({ messages: [{ role: 'user', content: 'abcdefgh' }] }, valid.responder);
    expect(valid.rec.json[0]?.body).toStrictEqual({ input_tokens: 2 });

    const invalid = fakeResponder();
    void countTokensHandler({ messages: [] }, invalid.responder);
    expect(invalid.rec.json[0]?.body).toStrictEqual({ input_tokens: 1 });
  });

  it('lists the seven models with cursor fields', () => {
    const { responder, rec } = fakeResponder();
    void modelsHandler(undefined, responder);
    const body = rec.json[0]?.body;
    expect(body).toMatchObject({
      has_more: false,
      first_id: 'global.anthropic.claude-opus-5-5',
      last_id: 'google.gemma-4-31b',
    });
    expect(body?.['data']).toHaveLength(7);
  });
});
