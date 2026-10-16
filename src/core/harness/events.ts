// Event shapes a harness session produces, plus small pure helpers the mapper
// uses to build them.

import { z } from 'zod';

import type { PermissionMode, TokenUsage } from '../../shared/model.js';
import type { EventName, OverlordEvents } from '../bus.js';

import type { SdkUsage } from './messages.js';

/** Any event the bus carries, with its payload tied to its name. */
type BusEvent = {
  readonly [K in EventName]: { readonly name: K; readonly payload: OverlordEvents[K] };
}[EventName];

/** The end of one turn, from the SDK result message. */
export interface TurnResult {
  readonly ok: boolean;
  readonly subtype: string;
  readonly text: string | null;
  /** Running total for the whole session so far, as the SDK reports it. */
  readonly costUsd: number;
  readonly turns: number;
  readonly durationMs: number;
  readonly usage: TokenUsage;
}

export type SessionEvent =
  BusEvent | { readonly name: 'turn.result'; readonly payload: TurnResult };

/** What the CLI reported in its init message. SessionSummary has no slot for tools or MCP. */
export interface SessionInfo {
  readonly model: string;
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly permissionMode: string;
  readonly mcpServers: readonly { readonly name: string; readonly status: string }[];
  readonly version: string | null;
}

export type EndReason = 'completed' | 'failed' | 'stopped';

const permissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'manual',
]);

export function parsePermissionMode(value: string): PermissionMode | null {
  const parsed = permissionModeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function toTokenUsage(usage: SdkUsage): TokenUsage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreation: usage.cache_creation_input_tokens ?? 0,
    thinking: 0,
  };
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheCreation: left.cacheCreation + right.cacheCreation,
    thinking: left.thinking + right.thinking,
  };
}

const PREVIEW_CHARS = 200;

export function preview(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}...` : text;
}

/** The rate limit event's resetsAt is in epoch seconds; the bus wants milliseconds. */
export function toEpochMs(value?: number): number | null {
  if (value === undefined) {
    return null;
  }
  return value < 1e12 ? value * 1000 : value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
