// Turns normalized hook events into the shared model, and holds the Claude
// Code output builders: the JSON a PermissionRequest, PreToolUse or context
// hook prints.

import type {
  AgentNode,
  LoadReason,
  LoadedInstruction,
  MemoryTier,
  PermissionDecision,
  PermissionRequest,
} from '../../shared/model.js';
import { ZERO_USAGE } from '../../shared/model.js';

import type { HookEventOf } from './normalized.js';
import { hookAgentId } from './normalized.js';
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

export function toInstructionLoaded(
  event: HookEventOf<'instructions-loaded'>,
  at: number,
): InstructionLoadedEvent {
  return {
    sessionId: event.sessionId,
    agentId: hookAgentId(event),
    memoryType: event.memoryType,
    instruction: {
      path: event.file,
      tier: toTier(event.memoryType),
      reason: toReason(event.loadReason),
      triggerPath: event.triggerPath,
      parentPath: event.parentPath,
      globs: event.globs,
      bytes: 0,
      differsFromDisk: null,
      loadedAt: at,
    },
  };
}

/** A hook event that carries a tool call: a permission request or a PreToolUse. */
export type ToolCallEvent = HookEventOf<'permission-request'> | HookEventOf<'pre-tool-use'>;

export function toPermissionRequest(
  event: ToolCallEvent,
  id: string,
  at: number,
): PermissionRequest {
  return {
    id,
    sessionId: event.sessionId,
    agent: event.agent,
    agentId: hookAgentId(event),
    toolName: event.tool.name,
    input: event.tool.input,
    requestedAt: at,
    source: 'hook',
  };
}

export interface AgentTimes {
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/**
 * Agent state from a subagent start or stop. Hooks do not say which agent
 * spawned a subagent, so the parent is the main thread and the depth is 1.
 * The transcript tailer knows better and should win when both report an
 * agent.
 */
export function toAgentNode(
  event: HookEventOf<'subagent-start'> | HookEventOf<'subagent-stop'>,
  times: AgentTimes,
): AgentNode {
  const stopped = event.kind === 'subagent-stop';
  return {
    id: event.subagent.id,
    sessionId: event.sessionId,
    parentAgentId: event.sessionId,
    parentToolUseId: null,
    agentType: event.subagent.type,
    description: '',
    spawnDepth: 1,
    background: false,
    state: stopped ? 'done' : 'running',
    startedAt: times.startedAt,
    endedAt: times.endedAt,
    transcriptPath: stopped ? event.subagentTranscriptPath : null,
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
function additionalContextOf(output: HookOutput | null): string | null {
  const specific = output?.['hookSpecificOutput'];
  if (typeof specific !== 'object' || specific === null) {
    return null;
  }
  const text: unknown = Reflect.get(specific, 'additionalContext');
  return typeof text === 'string' && text !== '' ? text : null;
}

/**
 * Adds text to the systemMessage an output carries, which Claude Code shows
 * the user rather than the model. Null text leaves output as it is.
 */
export function withSystemMessage(
  output: HookOutput | null,
  text: string | null,
): HookOutput | null {
  if (text === null) {
    return output;
  }
  const before: unknown = output?.['systemMessage'];
  const message = typeof before === 'string' && before !== '' ? `${before}\n\n${text}` : text;
  return { ...output, systemMessage: message };
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
