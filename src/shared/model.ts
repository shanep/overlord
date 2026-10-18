// Normalized entities shared by the extension host and the webviews.
// Everything here is plain data (JSON safe) so it can cross postMessage.
// Times are epoch milliseconds.

import type { AgentId } from './agents.js';

export type {
  MemoryTier,
  LoadReason,
  LoadedInstruction,
  SkipReasonCode,
  SkippedCandidate,
  SkillEntry,
  ContextSnapshot,
} from './context-model.js';
export type {
  KnobKind,
  KnobValueType,
  AppliesAt,
  KnobDefinition,
  SettingsLayer,
  EffectiveValue,
  SettingsFileSummary,
} from './knob-model.js';
export type { ConfigKind, ConfigScope, ConfigStatus, ConfigItem } from './config-model.js';
export type {
  PermissionRequest,
  PermissionChoice,
  PermissionDecision,
  LaunchProfile,
  LaunchSpec,
} from './harness-model.js';
export { permissionChoices, choiceDecision } from './harness-model.js';

/** Where a session runs or came from. */
export type Surface =
  'cli' | 'sdk' | 'overlord' | 'desktop-code' | 'cowork' | 'cloud' | 'claude-ai';

/**
 * Unfinished is a transcript that stops mid-turn or mid tool call with nothing
 * running it any more, so the work was cut off rather than finished.
 */
export type SessionState =
  'running' | 'waiting' | 'idle' | 'unfinished' | 'done' | 'failed' | 'unknown';

/**
 * Where a live Claude Code process runs: a terminal in this VS Code window,
 * a terminal anywhere else, or in the background with no terminal at all.
 */
export type SessionPlace = 'vscode' | 'terminal' | 'background';

/** Claude Code's permission modes. Other agents bring their own as plain strings. */
export type PermissionMode =
  'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions' | 'manual';

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly thinking: number;
}

export const ZERO_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  thinking: 0,
};

/** Tokens sent to the model as input, cached or not. */
export function promptTokens(usage: TokenUsage): number {
  return usage.input + usage.cacheRead + usage.cacheCreation;
}

const STANDARD_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

// Family, major and minor from ids like claude-opus-4-7 or claude-haiku-5-5.
// The minor is at most two digits so a date suffix is not read as one, and it
// is empty when the id has none.
const MODEL_ID = /claude-(opus|sonnet|haiku|fable)-(\d+)-?(\d{0,2})(?!\d)/u;

/** Per Claude Code's model docs, these run a 1M window without the [1m] suffix. */
function largeByDefault(family: string, major: number, minor: number): boolean {
  switch (family) {
    case 'fable': {
      return true;
    }
    case 'sonnet': {
      return major >= 5;
    }
    case 'haiku': {
      return major > 5 || (major === 5 && minor >= 5);
    }
    default: {
      return major > 4 || (major === 4 && minor >= 7);
    }
  }
}

/**
 * Context window for a Claude model id, or null when the model is unknown. A
 * prompt bigger than the standard window proves the session has the large
 * one, which covers model ids this table does not know yet. Claude Code's
 * models facet uses it, and the webview may call it for Claude sessions
 * only, since an unknown id gets Claude's standard window.
 */
export function claudeContextWindow(model: string, observedTokens?: number): number;
export function claudeContextWindow(model: string | null, observedTokens?: number): number | null;
export function claudeContextWindow(model: string | null, observedTokens = 0): number | null {
  if (observedTokens > STANDARD_WINDOW || model?.includes('[1m]') === true) {
    return LARGE_WINDOW;
  }
  if (model === null) {
    return null;
  }
  const match = MODEL_ID.exec(model);
  if (match === null) {
    return STANDARD_WINDOW;
  }
  const large = largeByDefault(String(match[1]), Number(match[2]), Number(match[3]));
  return large ? LARGE_WINDOW : STANDARD_WINDOW;
}

/** One row in the fleet view. */
/** Claude Code's own recap of a session, written when the user comes back to it. */
export interface SessionRecap {
  readonly text: string;
  readonly at: number;
}

export interface SessionSummary {
  readonly id: string;
  /** The agent CLI that runs this session. */
  readonly agent: AgentId;
  readonly surface: Surface;
  readonly title: string;
  readonly cwd: string;
  readonly state: SessionState;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly usage: TokenUsage;
  /** Client-side estimate at list price, not billing. */
  readonly costUsd: number | null;
  readonly model: string | null;
  readonly effort: string | null;
  /** An id from the agent's permission modes. */
  readonly permissionMode: string | null;
  readonly pid: number | null;
  readonly transcriptPath: string | null;
  readonly gitBranch: string | null;
  readonly version: string | null;
  /** Number of subagents seen in this session, all depths. */
  readonly agentCount: number;
  /** Context window fill, 0 to 1, when known. */
  readonly contextFill: number | null;
  /** Claude Code's newest recap, or null before it writes one. */
  readonly recap: SessionRecap | null;
  /** The newest prompt the user typed, as Claude Code saved it (cut short when long). */
  readonly lastPrompt: string | null;
  /** When the user typed it, so a recap written before it reads as out of date. */
  readonly lastPromptAt: number | null;
}

/** The name the fleet shows for a session, and its CLI tab takes: its title, or its folder until it has one. */
export function sessionName(session: Pick<SessionSummary, 'title' | 'cwd'>): string {
  return session.title === '' ? session.cwd : session.title;
}

/** A main thread or a subagent. The main thread has `parentAgentId` null and `id` equal to the session id. */
export interface AgentNode {
  readonly id: string;
  readonly sessionId: string;
  readonly parentAgentId: string | null;
  /** Tool use id of the Agent call in the parent that started this agent. */
  readonly parentToolUseId: string | null;
  readonly agentType: string;
  readonly description: string;
  readonly spawnDepth: number;
  readonly background: boolean;
  readonly state: SessionState;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly transcriptPath: string | null;
  readonly usage: TokenUsage;
  readonly toolCallCount: number;
  readonly currentTool: string | null;
  readonly model: string | null;
  /** Why a failed agent failed, when its error came back to the parent. */
  readonly failure?: string;
}

export interface ToolCall {
  readonly id: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly name: string;
  readonly input: unknown;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly ok: boolean | null;
  /** First part of the result text, for the feed. */
  readonly resultPreview: string | null;
}

/** One model API call, deduplicated by message id. */
export interface ApiRequest {
  readonly messageId: string;
  readonly requestId: string | null;
  readonly sessionId: string;
  readonly agentId: string;
  readonly model: string;
  readonly timestamp: number;
  readonly usage: TokenUsage;
  readonly ttftMs: number | null;
  readonly durationMs: number | null;
  readonly costUsd: number | null;
}

export type FeedItem =
  | { readonly kind: 'user'; readonly id: string; readonly at: number; readonly text: string }
  | { readonly kind: 'text'; readonly id: string; readonly at: number; readonly text: string }
  | { readonly kind: 'thinking'; readonly id: string; readonly at: number; readonly text: string }
  | {
      readonly kind: 'tool_use';
      readonly id: string;
      readonly at: number;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly kind: 'tool_result';
      readonly id: string;
      readonly at: number;
      readonly toolUseId: string;
      readonly ok: boolean;
      readonly text: string;
    }
  | { readonly kind: 'system'; readonly id: string; readonly at: number; readonly text: string };

// ---- Usage history ------------------------------------------------------

export interface DailyUsage {
  readonly date: string;
  readonly messages: number;
  readonly sessions: number;
  readonly toolCalls: number;
  readonly tokensByModel: Readonly<Record<string, number>>;
}
