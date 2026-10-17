// Newline-delimited JSON between the hook script and the extension. The script
// sends one request per connection and the server answers with the output the
// script prints on stdout. Hand-written guards instead of zod keep the hook
// bundle small, since it starts once per hook event.

import { CLAUDE_CODE } from '../../shared/agents.js';

export type HookOutput = Readonly<Record<string, unknown>>;

export interface HookRequestMessage {
  readonly id: string;
  readonly event: unknown;
  /** The relay's --agent value. Relays from before the flag leave it out, which means Claude Code. */
  readonly agent?: string;
  /** The relay's --event value, for agents whose stdin does not name the event. */
  readonly hook?: string;
}

/** A request as the server reads it, with the defaults filled in. */
export interface HookRequest {
  readonly id: string;
  readonly event: unknown;
  readonly agent: string;
  readonly hook: string | null;
}

export interface HookReplyMessage {
  readonly id: string;
  readonly output: HookOutput;
}

/** Largest line either side accepts. Write tool inputs can carry whole files. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export function encodeMessage(message: HookRequestMessage | HookReplyMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function parseRequestLine(line: string): HookRequest | null {
  const value = parseJson(line);
  if (!isRecord(value) || typeof value['id'] !== 'string' || !('event' in value)) {
    return null;
  }
  return {
    id: value['id'],
    event: value['event'],
    agent: nonEmpty(value['agent']) ?? CLAUDE_CODE,
    hook: nonEmpty(value['hook']),
  };
}

export function parseReplyLine(line: string): HookReplyMessage | null {
  const value = parseJson(line);
  if (!isRecord(value) || typeof value['id'] !== 'string') {
    return null;
  }
  const output = value['output'];
  if (!isRecord(output)) {
    return null;
  }
  return { id: value['id'], output };
}

export function isEmptyOutput(output: HookOutput): boolean {
  return Object.keys(output).length === 0;
}

/** Splits a byte stream into lines. Throws once a single line grows past the cap. */
export class LineDecoder {
  private buffer = '';

  constructor(private readonly maxLineBytes: number = MAX_LINE_BYTES) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    // split always returns at least one element: the unfinished tail.
    this.buffer = parts.splice(-1, 1).join('');
    if (this.buffer.length > this.maxLineBytes) {
      this.buffer = '';
      throw new RangeError(`hook message longer than ${String(this.maxLineBytes)} bytes`);
    }
    return parts.filter((part) => part.trim() !== '');
  }
}
