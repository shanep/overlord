// Small pure helpers shared by the accumulator pieces.

import type { TokenUsage } from '../../shared/model.js';

import type { RawUsage, ToolResultContent } from './schemas.js';

/** The text parts of a tool result, joined by newlines. Images and documents are skipped. */
export function resultText(content: ToolResultContent): string {
  if (typeof content === 'string') {
    return content;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

/** The first `max` characters, with a trailing ellipsis when cut. */
export function preview(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export interface TaskNotification {
  readonly toolUseId: string;
  readonly status: string;
  /** The one line on how it ended, which holds the error when it failed. */
  readonly summary: string | null;
}

const NOTIFICATION_TAG = '<task-notification>';
const TOOL_USE_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/u;
const STATUS = /<status>([^<]+)<\/status>/u;
const SUMMARY = /<summary>([^<]+)<\/summary>/u;

/**
 * Background agents and tasks report back with a <task-notification> block
 * that names the tool use that started them and how they ended.
 */
export function parseTaskNotification(text: string): TaskNotification | null {
  if (!text.includes(NOTIFICATION_TAG)) {
    return null;
  }
  const toolUseId = TOOL_USE_ID.exec(text)?.[1]?.trim();
  const status = STATUS.exec(text)?.[1]?.trim();
  if (toolUseId === undefined || status === undefined) {
    return null;
  }
  const summary = SUMMARY.exec(text)?.[1]?.trim() ?? null;
  return { toolUseId, status, summary: summary === '' ? null : summary };
}

export function isTaskNotification(text: string): boolean {
  return text.includes(NOTIFICATION_TAG);
}

export function usageFromRaw(raw: RawUsage): TokenUsage {
  return {
    input: raw.input_tokens,
    output: raw.output_tokens,
    cacheRead: raw.cache_read_input_tokens,
    cacheCreation: raw.cache_creation_input_tokens,
    thinking: raw.output_tokens_details?.thinking_tokens ?? 0,
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

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Render an environment snapshot value as one display string. */
export function displayValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (isList(value)) {
    return value.map((item) => displayValue(item)).join(', ');
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return value === null || value === undefined ? '' : JSON.stringify(value);
}
