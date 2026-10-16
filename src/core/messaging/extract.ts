// Messages between agents and sessions, pulled from one transcript file.
// A send is a SendMessage tool call made by the file's owner. A delivery is a
// record whose `origin` says another agent, a session, the launching agent or
// a finished background agent put it there. Ids come from the record, so a
// rescan of the same file always gives the same messages.

import { z } from 'zod';

import type { AgentMessage } from '../../shared/protocol.js';
import { SEND_MESSAGE_TOOL } from '../hooks/rules.js';
import { parseTimestamp } from '../transcripts/schemas.js';

import type { MessageBlock, MessageOrigin, MessageRecord } from './records.js';
import { mayHoldMessage, parseMessageRecord } from './records.js';
import { messageBody, preview, tagText, textKey } from './text.js';

/** The address Claude Code uses for a session's main conversation. */
export const MAIN = 'main';

/** A send to this address goes to every teammate. Older versions only. */
export const BROADCAST = '*';

export interface FileContext {
  readonly sessionId: string;
  /** Who wrote this transcript: MAIN or the subagent's id. */
  readonly owner: string;
  /** Who launched the owner, for messages from the coordinator. */
  readonly parent: string;
}

export interface ExtractedMessage {
  readonly message: AgentMessage;
  /** Hash of the full text, so a delivery can be matched to its send. */
  readonly textKey: string;
}

interface Delivery {
  readonly origin: MessageOrigin;
  readonly text: string;
  readonly id: string;
  readonly at: number;
}

const sendInputSchema = z.object({
  to: z.string(),
  message: z.unknown(),
  summary: z.string().nullish().catch(null),
});

const structuredSchema = z.object({ type: z.string() });

// Hook and rule denials say so; a failed send ("Not sent", success false) does not.
const BLOCKED_TEXT = /\b(?:denied|blocked)\b|\bhook\b/iu;

/** Agent task notifications only; background shell commands and monitors are not messages. */
const AGENT_SUMMARY = 'Agent "';

function textOf(content: string | readonly MessageBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

function resultText(block: Extract<MessageBlock, { type: 'tool_result' }>): string {
  const { content } = block;
  return typeof content === 'string'
    ? content
    : content.flatMap((part) => (part.text === null ? [] : [part.text])).join('\n');
}

function sendText(input: z.infer<typeof sendInputSchema>): string {
  if (typeof input.message === 'string') {
    return input.message;
  }
  const structured = structuredSchema.safeParse(input.message);
  return structured.success ? structured.data.type : 'message';
}

function build(fields: Omit<AgentMessage, 'blocked' | 'preview'>, text: string): ExtractedMessage {
  return {
    message: { ...fields, preview: preview(messageBody(text)), blocked: false },
    textKey: textKey(messageBody(text)),
  };
}

function isBlocked(block: Extract<MessageBlock, { type: 'tool_result' }>): boolean {
  return block.is_error === true && BLOCKED_TEXT.test(resultText(block));
}

function toSend(
  block: Extract<MessageBlock, { type: 'tool_use' }>,
  at: number,
  context: FileContext,
): { readonly toolUseId: string; readonly entry: ExtractedMessage } | null {
  const input = sendInputSchema.safeParse(block.input);
  if (!input.success) {
    return null;
  }
  const text = sendText(input.data);
  const sent = build(
    {
      id: `${context.sessionId}:${block.id}`,
      at,
      sessionId: context.sessionId,
      from: context.owner,
      to: input.data.to,
      kind: input.data.to === BROADCAST ? 'broadcast' : 'send',
    },
    text,
  );
  const summary = input.data.summary ?? '';
  const entry =
    summary.trim() === ''
      ? sent
      : { ...sent, message: { ...sent.message, preview: preview(summary) } };
  return { toolUseId: block.id, entry };
}

/** An agent goes by its id; a session goes by its name, as SendMessage addresses it. */
function peerName(origin: MessageOrigin): string {
  const from = origin.from ?? 'unknown';
  if (origin.senderTaskId !== null || from === 'unknown') {
    return from;
  }
  return origin.name ?? from;
}

function peerMessage(delivery: Delivery, context: FileContext): ExtractedMessage {
  const { origin } = delivery;
  const text = origin.body ?? origin.handbackReportText ?? delivery.text;
  return build(
    {
      id: delivery.id,
      at: delivery.at,
      sessionId: context.sessionId,
      from: peerName(origin),
      to: context.owner,
      kind: origin.handback === true ? 'hand-back' : 'receive',
    },
    text,
  );
}

function notification(delivery: Delivery, context: FileContext): ExtractedMessage | null {
  const summary = tagText(delivery.text, 'summary') ?? '';
  const taskId = tagText(delivery.text, 'task-id');
  if (taskId === null || !summary.startsWith(AGENT_SUMMARY)) {
    return null;
  }
  return build(
    {
      id: delivery.id,
      at: delivery.at,
      sessionId: context.sessionId,
      from: taskId,
      to: context.owner,
      kind: 'task-notification',
    },
    summary,
  );
}

function fromDelivery(delivery: Delivery, context: FileContext): ExtractedMessage | null {
  switch (delivery.origin.kind) {
    case 'peer': {
      return peerMessage(delivery, context);
    }
    case 'coordinator': {
      const received = peerMessage(delivery, context);
      return { ...received, message: { ...received.message, from: context.parent } };
    }
    case 'task-notification': {
      return notification(delivery, context);
    }
    default: {
      return null;
    }
  }
}

class FileExtractor {
  private readonly found: ExtractedMessage[] = [];
  /** SendMessage tool use id to message id, so the tool result can mark it blocked. */
  private readonly sends = new Map<string, string>();
  private readonly blocked = new Set<string>();

  constructor(private readonly context: FileContext) {}

  add(record: MessageRecord, lineNumber: number): void {
    const at = parseTimestamp(record.timestamp) ?? 0;
    const local = record.uuid ?? `${this.context.owner}:${String(lineNumber)}`;
    const id = `${this.context.sessionId}:${local}`;
    if (record.type === 'assistant') {
      this.addSends(record.message.content, at);
      return;
    }
    if (record.type === 'attachment') {
      this.addDelivery(record.attachment.origin, { text: record.attachment.prompt, id, at });
      return;
    }
    const { content } = record.message;
    this.addDelivery(record.origin, { text: textOf(content), id, at });
    if (typeof content !== 'string') {
      this.markResults(content);
    }
  }

  messages(): ExtractedMessage[] {
    return this.found.map((entry) =>
      this.blocked.has(entry.message.id)
        ? { ...entry, message: { ...entry.message, blocked: true } }
        : entry,
    );
  }

  private addSends(blocks: readonly MessageBlock[], at: number): void {
    for (const block of blocks) {
      const sent =
        block.type === 'tool_use' && block.name === SEND_MESSAGE_TOOL
          ? toSend(block, at, this.context)
          : null;
      if (sent !== null) {
        this.sends.set(sent.toolUseId, sent.entry.message.id);
        this.found.push(sent.entry);
      }
    }
  }

  private addDelivery(origin: MessageOrigin | null, rest: Omit<Delivery, 'origin'>): void {
    const received = origin === null ? null : fromDelivery({ ...rest, origin }, this.context);
    if (received !== null) {
      this.found.push(received);
    }
  }

  private markResults(blocks: readonly MessageBlock[]): void {
    for (const block of blocks) {
      const messageId =
        block.type === 'tool_result' ? this.sends.get(block.tool_use_id) : undefined;
      if (messageId !== undefined && block.type === 'tool_result' && isBlocked(block)) {
        this.blocked.add(messageId);
      }
    }
  }
}

/** Every message in one transcript file, in file order. */
export function extractMessages(
  lines: readonly string[],
  context: FileContext,
): ExtractedMessage[] {
  const extractor = new FileExtractor(context);
  for (const [index, line] of lines.entries()) {
    const record = mayHoldMessage(line) ? parseMessageRecord(line) : null;
    if (record !== null) {
      extractor.add(record, index + 1);
    }
  }
  return extractor.messages();
}
