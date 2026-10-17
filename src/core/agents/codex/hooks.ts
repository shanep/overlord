// Codex CLI's hooks behind the hooks facet, from the hooks page of the Codex
// docs (learn.chatgpt.com/docs/hooks) for 0.163.0. Overlord's hooks go in
// $CODEX_HOME/hooks.json, never in a [hooks] table of config.toml. That file
// has the same shape as Claude Code's hooks block, so the Claude installer
// merges it: it only adds, finds and removes handlers whose command has
// "overlord-hook" in it, and keeps every other entry as it was.
//
// Codex runs a hook only once the user trusts it in /hooks, and trust is tied
// to a hash of the hook's definition. So the command, the timeouts and the
// events here must not change between versions, or every user has to trust
// the hooks again.
//
// The payloads are snake_case like Claude Code's. A subagent's hooks report
// the parent's session_id, and SessionStart says fork for a forked thread.

import path from 'node:path';

import { z } from 'zod';

import { CODEX } from '../../../shared/agents.js';
import { applyPatchPaths } from '../../hooks/apply-patch.js';
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
import type { HookOutput } from '../../hooks/protocol.js';
import type { AgentDirs, HooksFacet } from '../types.js';

/**
 * The events Overlord listens to. Interrupt is left out, since nothing in
 * Overlord acts on it.
 */
export const CODEX_HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
];

/**
 * Seconds. A permission request waits on the user in the inbox. Codex caps
 * SessionEnd at 3 seconds and warns about anything longer.
 */
export function codexHookTimeout(event: string): number {
  if (event === 'PermissionRequest') {
    return 600;
  }
  return event === 'SessionEnd' ? 3 : 5;
}

/**
 * Events whose output can add text to the model's context. Codex fails a
 * hook run that sends fields its event does not take, so the rest get none.
 */
const CONTEXT_EVENTS: ReadonlySet<string> = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
]);

/** Codex writes files with apply_patch, whose paths sit in the patch text in tool_input.command. */
const EDIT_TOOLS: EditTools = { apply_patch: applyPatchPaths };

const SOURCES: ReadonlyMap<string, SessionStartSource> = new Map([
  ['startup', 'new'],
  ['resume', 'resume'],
  ['clear', 'clear'],
  ['compact', 'compact'],
  ['fork', 'fork'],
]);

const text = z.string().nullish();

const payloadSchema = z.looseObject({
  session_id: z.string(),
  hook_event_name: z.string(),
  cwd: text,
  transcript_path: text,
  model: text,
  agent_id: text,
  agent_type: text,
  source: text,
  reason: text,
  prompt: text,
  trigger: text,
  tool_name: text,
  tool_input: z.unknown().optional(),
  tool_use_id: text,
  tool_response: z.unknown().optional(),
  agent_transcript_path: text,
  last_assistant_message: text,
});

type Payload = z.infer<typeof payloadSchema>;

function hooksFile(dirs: AgentDirs): string {
  return path.join(dirs.configDir, 'hooks.json');
}

function toolOf(payload: Payload): HookToolCall | null {
  const name = payload.tool_name ?? '';
  return name === ''
    ? null
    : { name, input: payload.tool_input ?? {}, useId: payload.tool_use_id ?? null };
}

/** The tool events, or null when the payload names no tool. */
function toolEvent(payload: Payload, base: HookEventBase): NormalizedHookEvent | null {
  const tool = toolOf(payload);
  if (tool === null) {
    return null;
  }
  switch (payload.hook_event_name) {
    case 'PreToolUse': {
      return { ...base, kind: 'pre-tool-use', tool };
    }
    case 'PostToolUse': {
      return { ...base, kind: 'post-tool-use', tool, response: payload.tool_response ?? null };
    }
    case 'PermissionRequest': {
      return { ...base, kind: 'permission-request', tool };
    }
    default: {
      return null;
    }
  }
}

/** The subagent events, or null when the payload names no subagent. */
function subagentEvent(payload: Payload, base: HookEventBase): NormalizedHookEvent | null {
  const id = payload.agent_id ?? '';
  if (id === '') {
    return null;
  }
  const subagent = { id, type: payload.agent_type ?? '' };
  if (payload.hook_event_name === 'SubagentStart') {
    return { ...base, kind: 'subagent-start', subagent };
  }
  return payload.hook_event_name === 'SubagentStop'
    ? {
        ...base,
        kind: 'subagent-stop',
        subagent,
        subagentTranscriptPath: payload.agent_transcript_path ?? null,
      }
    : null;
}

type Converter = (payload: Payload, base: HookEventBase) => NormalizedHookEvent;

/** The events that need no tool or subagent, by Codex's name for them. */
const CONVERTERS: Readonly<Record<string, Converter>> = {
  SessionStart: (payload, base) => ({
    ...base,
    kind: 'session-start',
    source: SOURCES.get(payload.source ?? '') ?? 'other',
    model: payload.model ?? null,
    title: null,
  }),
  SessionEnd: (payload, base) => ({
    ...base,
    kind: 'session-end',
    reason: payload.reason ?? 'other',
  }),
  UserPromptSubmit: (payload, base) => ({
    ...base,
    kind: 'prompt-submit',
    prompt: payload.prompt ?? '',
    title: null,
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
    trigger: payload.trigger ?? 'auto',
  }),
  PostCompact: (payload, base) => ({
    ...base,
    kind: 'compaction',
    phase: 'after',
    trigger: payload.trigger ?? 'auto',
  }),
};

function convert(payload: Payload, base: HookEventBase): NormalizedHookEvent | null {
  const name = payload.hook_event_name;
  const simple = Object.hasOwn(CONVERTERS, name) ? CONVERTERS[name] : undefined;
  return simple?.(payload, base) ?? toolEvent(payload, base) ?? subagentEvent(payload, base);
}

/** Reads a Codex hook's stdin. Codex names the event in the payload, like Claude Code. */
export function normalizeCodexHook(raw: RawHook): HookNormalizeResult {
  const parsed = payloadSchema.safeParse(raw.payload);
  if (!parsed.success) {
    return { ok: false, error: `Codex hook payload: ${parsed.error.message}` };
  }
  const payload = parsed.data;
  const subagent = payload.agent_id ?? '';
  const base: HookEventBase = {
    agent: CODEX,
    native: payload.hook_event_name,
    sessionId: payload.session_id,
    subagentId: subagent === '' ? null : subagent,
    cwd: payload.cwd ?? null,
    transcriptPath: payload.transcript_path ?? null,
    timestamp: null,
  };
  return { ok: true, event: convert(payload, base) ?? { ...base, kind: 'other' } };
}

/**
 * The JSON a Codex hook prints. The decision and deny shapes are the same as
 * Claude Code's. Context only goes to events that take it, and a notice
 * becomes the systemMessage, which every event takes.
 */
export function answerCodexHook(event: NormalizedHookEvent, answer: HookAnswer): HookOutput {
  if (answer.decision !== undefined) {
    return permissionOutput(answer.decision);
  }
  const blocked = answer.block === undefined ? null : preToolUseDenyOutput(answer.block);
  const note = CONTEXT_EVENTS.has(event.native) ? (answer.context ?? null) : null;
  const withNote = withContext(blocked, event.native, note);
  return withSystemMessage(withNote, answer.notice ?? null) ?? {};
}

/** The relay command with this agent's flag, so the hook server reads the payload as Codex's. */
export function codexHookCommand(command: string): string {
  return `${command} --agent ${CODEX}`;
}

export const codexHooks: HooksFacet = {
  install: async (dirs, command) =>
    installHooks({
      settingsFile: hooksFile(dirs),
      hookCommand: codexHookCommand(command),
      events: CODEX_HOOK_EVENTS,
      timeoutFor: codexHookTimeout,
    }),
  uninstall: async (dirs) => uninstallHooks({ settingsFile: hooksFile(dirs) }),
  installed: async (dirs) => isInstalled({ settingsFile: hooksFile(dirs) }),
  normalize: normalizeCodexHook,
  answer: answerCodexHook,
  editTools: EDIT_TOOLS,
};
