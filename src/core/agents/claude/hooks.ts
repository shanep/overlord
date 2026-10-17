// Claude Code's hooks behind the hooks facet. It wraps the Claude modules in
// src/core/hooks where they sit: the settings.json installer, the payload
// schemas and the output builders.

import path from 'node:path';

import { CLAUDE_CODE } from '../../../shared/agents.js';
import { installHooks, isInstalled, uninstallHooks } from '../../hooks/install.js';
import {
  permissionOutput,
  preToolUseDenyOutput,
  withContext,
  withSystemMessage,
} from '../../hooks/mapping.js';
import type {
  EditTools,
  HookAnswer,
  HookEventBase,
  HookNormalizeResult,
  HookToolCall,
  NormalizedHookEvent,
  RawHook,
  SessionStartSource,
} from '../../hooks/normalized.js';
import type { KnownPayload } from '../../hooks/payloads.js';
import { parseHookPayload } from '../../hooks/payloads.js';
import type { HookOutput } from '../../hooks/protocol.js';
import type { AgentDirs, HooksFacet } from '../types.js';

/**
 * Claude's file tools. The coordinator always tried file_path and then
 * notebook_path for each of them, so every tool keeps both, in that order.
 */
const PATH_FIELDS: readonly string[] = ['file_path', 'notebook_path'];

const EDIT_TOOLS: EditTools = {
  Edit: PATH_FIELDS,
  Write: PATH_FIELDS,
  MultiEdit: PATH_FIELDS,
  NotebookEdit: PATH_FIELDS,
};

const SOURCES: ReadonlyMap<string, SessionStartSource> = new Map([
  ['startup', 'new'],
  ['resume', 'resume'],
  ['clear', 'clear'],
  ['compact', 'compact'],
]);

function settingsFile(dirs: AgentDirs): string {
  return path.join(dirs.configDir, 'settings.json');
}

function toolOf(payload: {
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly tool_use_id?: string | null | undefined;
}): HookToolCall {
  return { name: payload.tool_name, input: payload.tool_input, useId: payload.tool_use_id ?? null };
}

type PayloadOf = { readonly [P in KnownPayload as P['hook_event_name']]: P };
type EventName = keyof PayloadOf;

/** One converter per event: the neutral fields plus the kind and the fields that kind adds. */
const CONVERTERS: {
  readonly [N in EventName]: (payload: PayloadOf[N], base: HookEventBase) => NormalizedHookEvent;
} = {
  SessionStart: (payload, base) => ({
    ...base,
    kind: 'session-start',
    source: SOURCES.get(payload.source) ?? 'other',
    model: payload.model ?? null,
    title: payload.session_title ?? null,
  }),
  SessionEnd: (payload, base) => ({ ...base, kind: 'session-end', reason: payload.reason }),
  UserPromptSubmit: (payload, base) => ({
    ...base,
    kind: 'prompt-submit',
    prompt: payload.prompt,
    title: payload.session_title ?? null,
  }),
  PreToolUse: (payload, base) => ({ ...base, kind: 'pre-tool-use', tool: toolOf(payload) }),
  PostToolUse: (payload, base) => ({
    ...base,
    kind: 'post-tool-use',
    tool: toolOf(payload),
    response: payload.tool_response,
  }),
  PostToolUseFailure: (payload, base) => ({
    ...base,
    kind: 'tool-failed',
    tool: toolOf(payload),
    error: payload.error,
  }),
  PermissionRequest: (payload, base) => ({
    ...base,
    kind: 'permission-request',
    tool: toolOf(payload),
  }),
  PermissionDenied: (payload, base) => ({
    ...base,
    kind: 'permission-denied',
    tool: toolOf(payload),
    reason: payload.reason ?? null,
  }),
  SubagentStart: (payload, base) => ({
    ...base,
    kind: 'subagent-start',
    subagent: { id: payload.agent_id, type: payload.agent_type },
  }),
  SubagentStop: (payload, base) => ({
    ...base,
    kind: 'subagent-stop',
    subagent: { id: payload.agent_id, type: payload.agent_type },
    subagentTranscriptPath: payload.agent_transcript_path ?? null,
  }),
  Stop: (payload, base) => ({
    ...base,
    kind: 'stop',
    lastMessage: payload.last_assistant_message ?? null,
  }),
  PreCompact: (payload, base) => ({
    ...base,
    kind: 'compaction',
    phase: 'before',
    trigger: payload.trigger,
  }),
  PostCompact: (payload, base) => ({
    ...base,
    kind: 'compaction',
    phase: 'after',
    trigger: payload.trigger,
  }),
  Notification: (payload, base) => ({
    ...base,
    kind: 'notification',
    message: payload.message,
    title: payload.title ?? null,
  }),
  InstructionsLoaded: (payload, base) => ({
    ...base,
    kind: 'instructions-loaded',
    file: payload.file_path,
    memoryType: payload.memory_type,
    loadReason: payload.load_reason,
    globs: payload.globs ?? [],
    triggerPath: payload.trigger_file_path ?? null,
    parentPath: payload.parent_file_path ?? null,
  }),
};

function convert<N extends EventName>(
  name: N,
  payload: PayloadOf[N],
  base: HookEventBase,
): NormalizedHookEvent {
  return CONVERTERS[name](payload, base);
}

/** Reads a Claude Code hook's stdin. Claude names the event in the payload, so the relay's name is not needed. */
export function normalizeClaudeHook(raw: RawHook): HookNormalizeResult {
  const parsed = parseHookPayload(raw.payload);
  if (!parsed.ok) {
    return parsed;
  }
  const { payload } = parsed.value;
  const subagent = payload.agent_id ?? '';
  const base: HookEventBase = {
    agent: CLAUDE_CODE,
    native: payload.hook_event_name,
    sessionId: payload.session_id,
    subagentId: subagent === '' ? null : subagent,
    cwd: payload.cwd ?? null,
    transcriptPath: payload.transcript_path ?? null,
    timestamp: null,
  };
  const { value } = parsed;
  return {
    ok: true,
    event: value.known
      ? convert(value.payload.hook_event_name, value.payload, base)
      : { ...base, kind: 'other' },
  };
}

/**
 * The JSON a Claude Code hook prints for an answer: a permission decision,
 * else a PreToolUse deny, with any context in hookSpecificOutput and any
 * notice as the systemMessage.
 */
export function answerClaudeHook(event: NormalizedHookEvent, answer: HookAnswer): HookOutput {
  if (answer.decision !== undefined) {
    return permissionOutput(answer.decision);
  }
  const blocked = answer.block === undefined ? null : preToolUseDenyOutput(answer.block);
  const withNote = withContext(blocked, event.native, answer.context ?? null);
  return withSystemMessage(withNote, answer.notice ?? null) ?? {};
}

export const claudeHooks: HooksFacet = {
  install: async (dirs, command) =>
    installHooks({ settingsFile: settingsFile(dirs), hookCommand: command }),
  uninstall: async (dirs) => uninstallHooks({ settingsFile: settingsFile(dirs) }),
  installed: async (dirs) => isInstalled({ settingsFile: settingsFile(dirs) }),
  normalize: normalizeClaudeHook,
  answer: answerClaudeHook,
  editTools: EDIT_TOOLS,
};
