// Claude Code hook payloads as normalized events, so tests can keep writing
// the JSON Claude sends.

import { normalizeClaudeHook } from '../../agents/claude/hooks.js';
import type { HookEventKind, HookEventOf, NormalizedHookEvent } from '../normalized.js';

export function claudeEvent(payload: unknown): NormalizedHookEvent {
  const result = normalizeClaudeHook({ payload, name: null });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.event;
}

function isKind<K extends HookEventKind>(
  event: NormalizedHookEvent,
  kind: K,
): event is HookEventOf<K> {
  return event.kind === kind;
}

/** The event for a payload that must normalize to one kind. */
export function claudeEventOf<K extends HookEventKind>(kind: K, payload: unknown): HookEventOf<K> {
  const event = claudeEvent(payload);
  if (!isKind(event, kind)) {
    throw new Error(`expected a ${kind} event, got ${event.kind}`);
  }
  return event;
}
