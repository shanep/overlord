// The Anthropic-compatible route: POST /v1/messages, plus a count_tokens stub
// and a models list. This is the front-end Claude Code uses through
// ANTHROPIC_BASE_URL. Inbound tool definitions, images and sampling controls
// are dropped because the backend does not support them, so a session still
// runs, it just cannot call tools: a one-shot chat, as intended.

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { MODEL_IDS, resolveModelId } from './models.js';
import type { Responder, RouteHandler } from './server.js';
import type { NormalizedChat } from './translate.js';
import { estimateTokens, toConverseRequest } from './translate.js';
import type { ConverseMessage, ConverseResponse, UpstreamConfig } from './upstream.js';
import { callOnce, streamUpstream } from './upstream.js';

const blockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  content: z.unknown().optional(),
});
// Claude Code sends a `system` role inside the messages array (a system
// reminder) alongside the top-level `system` field, so accept it here and fold
// it into the system prompt below. The backend's messages take user/assistant.
const messageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([z.string(), z.array(blockSchema)]),
});
const systemBlockSchema = z.object({ type: z.string(), text: z.string().optional() });
const requestSchema = z.object({
  model: z.string().optional(),
  max_tokens: z.number().int().positive().optional(),
  messages: z.array(messageSchema).min(1),
  system: z.union([z.string(), z.array(systemBlockSchema)]).optional(),
  stream: z.boolean().optional(),
});

type MessageContent = z.infer<typeof messageSchema>['content'];
type SystemPrompt = z.infer<typeof requestSchema>['system'];

function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const part of content as readonly unknown[]) {
    if (part !== null && typeof part === 'object' && 'text' in part) {
      const text = (part as { readonly text: unknown }).text;
      if (typeof text === 'string') {
        parts.push(text);
      }
    }
  }
  return parts.join('');
}

function flattenContent(content: MessageContent): string {
  if (typeof content === 'string') {
    return content;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text !== undefined) {
      parts.push(block.text);
    } else if (block.type === 'tool_result') {
      parts.push(toolResultText(block.content));
    }
    // tool_use, image and other blocks carry nothing the backend can use.
  }
  return parts.join('');
}

function flattenSystem(system: SystemPrompt): string | null {
  if (system === undefined) {
    return null;
  }
  const joined =
    typeof system === 'string' ? system : system.map((block) => block.text ?? '').join('');
  return joined === '' ? null : joined;
}

export type ParseResult =
  | { readonly ok: true; readonly chat: NormalizedChat }
  | { readonly ok: false; readonly status: number; readonly message: string };

export function parseAnthropicRequest(body: unknown): ParseResult {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 400, message: `Invalid messages request: ${parsed.error.message}` };
  }
  const data = parsed.data;
  const messages: ConverseMessage[] = [];
  const systemParts: string[] = [];
  const topSystem = flattenSystem(data.system);
  if (topSystem !== null) {
    systemParts.push(topSystem);
  }
  for (const message of data.messages) {
    const text = flattenContent(message.content);
    if (message.role === 'system') {
      if (text !== '') {
        systemParts.push(text);
      }
    } else {
      messages.push({ role: message.role, content: text });
    }
  }
  return {
    ok: true,
    chat: {
      modelId: resolveModelId(data.model),
      messages,
      systemPrompt: systemParts.length === 0 ? null : systemParts.join('\n\n'),
      maxTokens: data.max_tokens ?? null,
      stream: data.stream ?? false,
    },
  };
}

const STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
]);

function mapStopReason(reason: string): string {
  return STOP_REASONS.has(reason) ? reason : 'end_turn';
}

function errorType(status: number): string {
  if (status === 401) {
    return 'authentication_error';
  }
  if (status === 403) {
    return 'permission_error';
  }
  if (status === 404) {
    return 'not_found_error';
  }
  if (status === 413) {
    return 'request_too_large';
  }
  if (status >= 500) {
    return 'api_error';
  }
  return 'invalid_request_error';
}

export function anthropicError(message: string, status: number): Record<string, unknown> {
  return { type: 'error', error: { type: errorType(status), message } };
}

export function messageBody(response: ConverseResponse, model: string): Record<string, unknown> {
  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: response.content }],
    stop_reason: mapStopReason(response.stop_reason),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
    },
  };
}

async function streamAnthropic(
  config: UpstreamConfig,
  chat: NormalizedChat,
  responder: Responder,
): Promise<void> {
  const sse = responder.beginSse();
  const id = `msg_${randomUUID()}`;
  const inputTokens = estimateTokens(chat);
  const emit = (name: string, data: Readonly<Record<string, unknown>>): void => {
    sse.send(name, JSON.stringify(data));
  };
  emit('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: chat.modelId,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  emit('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  emit('ping', { type: 'ping' });

  let stopReason = 'end_turn';
  let outputTokens: number | null = null;
  let characters = 0;
  for await (const event of streamUpstream(config, toConverseRequest(chat))) {
    if (sse.closed) {
      break;
    }
    switch (event.kind) {
      case 'text': {
        characters += event.text.length;
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: event.text },
        });
        break;
      }
      case 'stop': {
        stopReason = mapStopReason(event.stopReason);
        break;
      }
      case 'usage': {
        outputTokens = event.usage.outputTokens;
        break;
      }
      case 'error': {
        emit('error', anthropicError(event.error.message, event.error.status));
        sse.end();
        return;
      }
      case 'start':
      case 'done': {
        // These carry nothing the Anthropic stream needs.
        break;
      }
    }
  }

  emit('content_block_stop', { type: 'content_block_stop', index: 0 });
  emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens ?? Math.max(1, Math.ceil(characters / 4)) },
  });
  emit('message_stop', { type: 'message_stop' });
  sse.end();
}

export function makeAnthropicHandler(config: UpstreamConfig): RouteHandler {
  return async (body, responder) => {
    const parsed = parseAnthropicRequest(body);
    if (!parsed.ok) {
      responder.json(parsed.status, anthropicError(parsed.message, parsed.status));
      return;
    }
    const chat = parsed.chat;
    if (chat.stream) {
      await streamAnthropic(config, chat, responder);
      return;
    }
    const result = await callOnce(config, toConverseRequest(chat));
    if (result.ok) {
      responder.json(200, messageBody(result.response, chat.modelId));
    } else {
      responder.json(
        result.error.status,
        anthropicError(result.error.message, result.error.status),
      );
    }
  };
}

/** A token counter with no backend: Claude Code uses it only for a context gauge. */
export const countTokensHandler: RouteHandler = (body, responder) => {
  const parsed = parseAnthropicRequest(body);
  responder.json(200, { input_tokens: parsed.ok ? estimateTokens(parsed.chat) : 1 });
};

/** A models list so a client probing GET /v1/models does not abort. */
export const modelsHandler: RouteHandler = (_body, responder) => {
  const data = MODEL_IDS.map((id) => ({ type: 'model', id, display_name: id }));
  responder.json(200, {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  });
};
