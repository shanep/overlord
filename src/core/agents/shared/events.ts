// What a runtime reports while an agent runs, in one shape for every agent.
// Each runtime turns its own wire format into these, and the shared reducer
// folds them into bus events, so no agent needs its own mapper.

import type { TokenUsage } from '../../../shared/model.js';

/** The agent finished starting: what it runs and with which tools. */
export interface InitEvent {
  readonly type: 'init';
  readonly model: string;
  readonly cwd: string;
  readonly tools: readonly string[];
  /** One of the agent's permission mode ids, or null when it reported one Overlord does not know. */
  readonly permissionMode: string | null;
  readonly mcpServers: readonly { readonly name: string; readonly status: string }[];
  /** The agent CLI's version. */
  readonly version: string | null;
}

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

/** Who wrote a message or made a call: the main thread or a subagent. */
interface Author {
  /** The subagent, when the agent names it. Null for the main thread or when only the tool link is known. */
  readonly agentId: string | null;
  /** The tool call that started the subagent, for agents that link subagents that way. */
  readonly parentToolUseId: string | null;
}

/**
 * A finished model message. A message split over several events repeats its
 * id, and only the first one with usage counts it.
 */
export interface MessageEvent extends Author {
  readonly type: 'message';
  /** Unique per model call. Runtimes whose agent gives none mint one. */
  readonly messageId: string;
  readonly requestId: string | null;
  readonly model: string;
  /** Null when the agent reports usage apart from the message, in a usage event. */
  readonly usage: TokenUsage | null;
  readonly blocks: readonly ContentBlock[];
}

/** One model call's usage, for agents that report it apart from the message. */
export interface UsageEvent extends Author {
  readonly type: 'usage';
  readonly messageId: string;
  readonly requestId: string | null;
  readonly model: string;
  /** Input counts only uncached tokens, so subtract cache reads when the agent folds them in. */
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly durationMs: number | null;
  readonly ttftMs: number | null;
}

/** A tool call ended. A call the agent only reports once done is a message with its tool_use block, then this. */
export interface ToolResultEvent {
  readonly type: 'tool_result';
  readonly toolUseId: string;
  readonly ok: boolean;
  readonly text: string;
}

export interface SubagentStartedEvent {
  readonly type: 'subagent_started';
  readonly agentId: string;
  /** Null when the main thread started it. */
  readonly parentAgentId: string | null;
  readonly parentToolUseId: string | null;
  readonly agentType: string;
  readonly description: string;
  /** 1 for a subagent of the main thread. */
  readonly spawnDepth: number;
  readonly background: boolean;
  readonly model: string | null;
}

export interface SubagentEndedEvent {
  readonly type: 'subagent_ended';
  readonly agentId: string;
  readonly outcome: 'completed' | 'failed' | 'stopped';
}

export interface CompactedEvent {
  readonly type: 'compacted';
  /** What started it, for example "auto" or "manual". */
  readonly trigger: string;
  readonly preTokens: number | null;
}

/**
 * One usage window, for runtimes that build a rate limit event.
 * @public
 */
export interface RateLimitWindowReport {
  /**
   * The window's id, unique within the agent. Every window shows in the
   * Fleet header and the Usage view. Claude Code's "five_hour" and
   * "seven_day" also fill the Fleet's plan limits.
   */
  readonly id: string;
  readonly usedPct: number | null;
  /** Epoch milliseconds. */
  readonly resetsAt: number | null;
  readonly windowMinutes: number | null;
}

export interface RateLimitEvent {
  readonly type: 'rate_limit';
  readonly windows: readonly RateLimitWindowReport[];
}

/** The end of one turn. */
export interface TurnResultEvent {
  readonly type: 'turn_result';
  readonly ok: boolean;
  /** The agent's word for how it ended, for example "success" or "interrupted". */
  readonly subtype: string;
  readonly text: string | null;
  /** Running total for the whole session so far, or null when the agent gives no dollars. */
  readonly costUsd: number | null;
  /** Model turns so far, or null to count turn results instead. */
  readonly turns: number | null;
  readonly durationMs: number | null;
  /** This turn's usage, added to the session's total. */
  readonly usage: TokenUsage | null;
}

/**
 * The agent switched model on its own or confirmed a switch.
 * @public
 */
export interface ModelChangedEvent {
  readonly type: 'model_changed';
  readonly model: string;
}

/**
 * The agent switched permission mode on its own or confirmed a switch.
 * @public
 */
export interface ModeChangedEvent {
  readonly type: 'mode_changed';
  readonly permissionMode: string;
}

/**
 * How full the context window is, for agents that report it as they go.
 * @public
 */
export interface ContextEvent {
  readonly type: 'context';
  readonly usedTokens: number;
  readonly maxTokens: number;
}

/**
 * A warning or error from the agent that is not part of a turn result.
 * @public
 */
export interface NoticeEvent {
  readonly type: 'notice';
  readonly text: string;
}

export type AgentEvent =
  | InitEvent
  | MessageEvent
  | UsageEvent
  | ToolResultEvent
  | SubagentStartedEvent
  | SubagentEndedEvent
  | CompactedEvent
  | RateLimitEvent
  | TurnResultEvent
  | ModelChangedEvent
  | ModeChangedEvent
  | ContextEvent
  | NoticeEvent;

export interface ContextUsage {
  readonly totalTokens: number;
  readonly maxTokens: number;
  /** totalTokens / maxTokens, 0 to 1 or more when over the limit. */
  readonly fill: number;
  readonly categories: readonly {
    readonly name: string;
    readonly tokens: number;
    readonly kind: string | null;
  }[];
}
