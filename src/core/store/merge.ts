// How the store folds reports of one thing from several sources. The
// transcript, the SDK, hooks and telemetry each know part of an API call or an
// agent, and a later report must not wipe what an earlier one knew.

import type { AgentNode, ApiRequest } from '../../shared/model.js';

export function requestKey(sessionId: string, id: string): string {
  return JSON.stringify([sessionId, id]);
}

/** Telemetry has no message id, so it puts the request id there. */
export function isTelemetry(request: ApiRequest): boolean {
  return request.messageId === request.requestId;
}

/** One API call as each source last reported it, and the record the views see. */
export interface CallRecord {
  readonly key: string;
  /** The copy named by message id, from the transcript or the SDK. */
  readonly message: ApiRequest | null;
  readonly telemetry: ApiRequest | null;
  readonly merged: ApiRequest;
}

/**
 * The transcript knows the message id, the thread and the thinking tokens.
 * Telemetry knows the timings and the billed cost. Pass the same copy twice
 * when only one source has reported the call.
 */
export function mergeCall(message: ApiRequest, telemetry: ApiRequest): ApiRequest {
  return {
    ...message,
    requestId: message.requestId ?? telemetry.requestId,
    usage: {
      input: Math.max(message.usage.input, telemetry.usage.input),
      output: Math.max(message.usage.output, telemetry.usage.output),
      cacheRead: Math.max(message.usage.cacheRead, telemetry.usage.cacheRead),
      cacheCreation: Math.max(message.usage.cacheCreation, telemetry.usage.cacheCreation),
      thinking: Math.max(message.usage.thinking, telemetry.usage.thinking),
    },
    ttftMs: telemetry.ttftMs ?? message.ttftMs,
    durationMs: telemetry.durationMs ?? message.durationMs,
    costUsd: telemetry.costUsd ?? message.costUsd,
  };
}

/** What a SubagentStart or SubagentStop hook says when it cannot know where the agent sits. */
function guessedPlacement(agent: AgentNode): boolean {
  return (
    agent.parentToolUseId === null &&
    agent.parentAgentId === agent.sessionId &&
    agent.spawnDepth === 1
  );
}

function hasUsage(agent: AgentNode): boolean {
  const usage = agent.usage;
  return usage.input + usage.output + usage.cacheRead + usage.cacheCreation + usage.thinking > 0;
}

/** Zero means the source did not know when the agent started. */
function earliest(left: number, right: number): number {
  if (left === 0 || right === 0) {
    return Math.max(left, right);
  }
  return Math.min(left, right);
}

type Placement = Pick<AgentNode, 'parentAgentId' | 'parentToolUseId' | 'spawnDepth'>;

/** Where the agent sits and what it is. A guess or a blank keeps the known value. */
function identity(
  known: AgentNode,
  next: AgentNode,
): Placement & Pick<AgentNode, 'agentType' | 'description'> {
  const placement = guessedPlacement(next) ? known : next;
  const typed = next.agentType !== '' && next.agentType !== 'unknown';
  return {
    parentAgentId: placement.parentAgentId,
    parentToolUseId: placement.parentToolUseId,
    spawnDepth: placement.spawnDepth,
    agentType: typed ? next.agentType : known.agentType,
    description: next.description === '' ? known.description : next.description,
  };
}

/** A hook's report of the end does not know the error, so keep the one the transcript gave. */
function failureOf(known: AgentNode, next: AgentNode): Pick<AgentNode, 'failure'> {
  if (next.state !== 'failed') {
    return {};
  }
  const failure = next.failure ?? known.failure;
  return failure === undefined ? {} : { failure };
}

/**
 * Folds a new report of an agent into the one already known. A hook only
 * knows the id, type and state, so its node has zero usage and guesses the
 * main thread as parent at depth 1. Empty and guessed fields keep what the
 * transcript or the SDK said, while state and new usage still apply.
 */
export function mergeAgent(known: AgentNode | undefined, next: AgentNode): AgentNode {
  if (known === undefined) {
    return next;
  }
  return {
    ...next,
    ...identity(known, next),
    background: known.background || next.background,
    startedAt: earliest(known.startedAt, next.startedAt),
    endedAt: next.endedAt ?? (next.state === 'running' ? null : known.endedAt),
    transcriptPath: next.transcriptPath ?? known.transcriptPath,
    usage: hasUsage(next) ? next.usage : known.usage,
    toolCallCount: next.toolCallCount === 0 ? known.toolCallCount : next.toolCallCount,
    model: next.model ?? known.model,
    ...failureOf(known, next),
  };
}
