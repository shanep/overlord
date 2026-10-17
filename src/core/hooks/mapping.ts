// Turns hook payloads into the shared model and permission decisions into the
// JSON a PermissionRequest or PreToolUse hook prints.

import type {
  AgentNode,
  LoadReason,
  LoadedInstruction,
  MemoryTier,
  PermissionDecision,
  PermissionRequest,
} from '../../shared/model.js';
import { ZERO_USAGE } from '../../shared/model.js';

import type {
  InstructionsLoadedPayload,
  PermissionRequestPayload,
  SubagentStartPayload,
  SubagentStopPayload,
} from './payloads.js';
import type { HookOutput } from './protocol.js';

/** An InstructionsLoaded event in model terms, plus the raw memory type. */
export interface InstructionLoadedEvent {
  readonly sessionId: string;
  readonly agentId: string;
  /** The memory_type string as Claude Code sent it. `instruction.tier` falls back to Project when it is not one we know. */
  readonly memoryType: string;
  /** `bytes` is 0 and `differsFromDisk` is null, because the hook does not carry the loaded text. */
  readonly instruction: LoadedInstruction;
}

const TIERS: readonly MemoryTier[] = ['Managed', 'User', 'Project', 'Local', 'AutoMem'];
const REASONS: readonly LoadReason[] = [
  'session_start',
  'nested_traversal',
  'path_glob_match',
  'include',
  'compact',
];

function toTier(value: string): MemoryTier {
  return TIERS.find((tier) => tier === value) ?? 'Project';
}

function toReason(value: string): LoadReason {
  return REASONS.find((reason) => reason === value) ?? 'unknown';
}

/** The agent a hook fired in. The main thread uses the session id, as in the shared model. */
export function agentIdOf(payload: {
  readonly session_id: string;
  readonly agent_id?: string | null | undefined;
}): string {
  const agentId = payload.agent_id ?? '';
  return agentId === '' ? payload.session_id : agentId;
}

export function toInstructionLoaded(
  payload: InstructionsLoadedPayload,
  at: number,
): InstructionLoadedEvent {
  return {
    sessionId: payload.session_id,
    agentId: agentIdOf(payload),
    memoryType: payload.memory_type,
    instruction: {
      path: payload.file_path,
      tier: toTier(payload.memory_type),
      reason: toReason(payload.load_reason),
      triggerPath: payload.trigger_file_path ?? null,
      parentPath: payload.parent_file_path ?? null,
      globs: payload.globs ?? [],
      bytes: 0,
      differsFromDisk: null,
      loadedAt: at,
    },
  };
}

/** The fields a tool hook (PermissionRequest or PreToolUse) carries about the call. */
export type ToolCallPayload = Pick<
  PermissionRequestPayload,
  'session_id' | 'agent_id' | 'tool_name' | 'tool_input'
>;

export function toPermissionRequest(
  payload: ToolCallPayload,
  id: string,
  at: number,
): PermissionRequest {
  return {
    id,
    sessionId: payload.session_id,
    agentId: agentIdOf(payload),
    toolName: payload.tool_name,
    input: payload.tool_input,
    requestedAt: at,
    source: 'hook',
  };
}

export interface AgentTimes {
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/**
 * Agent state from SubagentStart or SubagentStop. Hooks do not say which agent
 * spawned a subagent, so the parent is the main thread and the depth is 1. The
 * transcript tailer knows better and should win when both report an agent.
 */
export function toAgentNode(
  payload: SubagentStartPayload | SubagentStopPayload,
  times: AgentTimes,
): AgentNode {
  const stopped = payload.hook_event_name === 'SubagentStop';
  return {
    id: payload.agent_id,
    sessionId: payload.session_id,
    parentAgentId: payload.session_id,
    parentToolUseId: null,
    agentType: payload.agent_type,
    description: '',
    spawnDepth: 1,
    background: false,
    state: stopped ? 'done' : 'running',
    startedAt: times.startedAt,
    endedAt: times.endedAt,
    transcriptPath: stopped ? (payload.agent_transcript_path ?? null) : null,
    usage: ZERO_USAGE,
    toolCallCount: 0,
    currentTool: null,
    model: null,
  };
}

/** The documented PermissionRequest hookSpecificOutput for a decision. */
export function permissionOutput(decision: PermissionDecision): HookOutput {
  const body =
    decision.behavior === 'allow'
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: decision.message };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: body } };
}

/** The documented PreToolUse output that blocks a tool call and tells Claude why. */
export function preToolUseDenyOutput(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export function ruleDenyMessage(ruleId: string, description: string): string {
  const detail = description.trim() === '' ? '' : `: ${description.trim()}`;
  return `Denied by Overlord auto-approve rule ${ruleId}${detail}`;
}

/** SessionStart output that adds text to the session's context. */
export function sessionStartOutput(text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
}

/** The additionalContext text an output carries, or null when it carries none. */
export function additionalContextOf(output: HookOutput | null): string | null {
  const specific = output?.['hookSpecificOutput'];
  if (typeof specific !== 'object' || specific === null) {
    return null;
  }
  const text: unknown = Reflect.get(specific, 'additionalContext');
  return typeof text === 'string' && text !== '' ? text : null;
}

/**
 * Adds text to the additionalContext an output carries, or makes an output
 * for event that carries just the text. Null text leaves output as it is.
 */
export function withContext(
  output: HookOutput | null,
  event: string,
  text: string | null,
): HookOutput | null {
  if (text === null) {
    return output;
  }
  const specific = output?.['hookSpecificOutput'];
  if (output === null || typeof specific !== 'object' || specific === null) {
    return { ...output, hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  }
  const before = additionalContextOf(output);
  return {
    ...output,
    hookSpecificOutput: {
      ...specific,
      additionalContext: before === null ? text : `${before}\n\n${text}`,
    },
  };
}
