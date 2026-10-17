// The runtime contract: how the Launcher starts an agent from code, talks to
// it while it runs and reads what it does. Each agent's runtime fills it in
// over its own driver (the Agent SDK for Claude, JSON-RPC for the others).

import type { PermissionRequest } from '../../../shared/model.js';

import type { AgentEvent, ContextUsage } from './events.js';

export interface ToolPermissionContext {
  readonly signal: AbortSignal;
  readonly toolUseId: string;
  /** The subagent asking, or null for the main thread. */
  readonly agentId: string | null;
}

export type ToolPermissionResult =
  | { readonly behavior: 'allow'; readonly updatedInput: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string };

/** Asks the permission inbox about one tool call. The runtime answers the agent with the result. */
export type ToolPermissionHandler = (
  toolName: string,
  input: Record<string, unknown>,
  context: ToolPermissionContext,
) => Promise<ToolPermissionResult>;

export interface StartOptions {
  readonly cwd: string;
  /**
   * The id Overlord picked for the session. A runtime whose agent mints its
   * own reports that one through AgentRun.sessionId instead.
   */
  readonly sessionId: string;
  /** Continue this session instead of starting a new one. */
  readonly resumeId: string | null;
  /** With resumeId, copy the session into a new one under sessionId. */
  readonly fork: boolean;
  /** The full environment for the agent, already merged onto the base one. */
  readonly env: Readonly<Record<string, string>>;
  readonly model: string | null;
  /** One of the agent's effort ids. */
  readonly effort: string | null;
  /** One of the agent's permission mode ids. */
  readonly permissionMode: string | null;
  /** CLI style flags, where null marks a flag with no value. */
  readonly extraArgs: Readonly<Record<string, string | null>>;
  readonly maxBudgetUsd: number | null;
  /** The agent binary, or null for the runtime's own default. */
  readonly executablePath: string | null;
  /** Runs without MCP servers, as a boisestate.ai bridge session does. */
  readonly noMcp: boolean;
  readonly canUseTool: ToolPermissionHandler;
}

/**
 * One running agent session. Iterating it yields what the agent does until
 * the agent exits, and throws if the agent fails.
 */
export interface AgentRun extends AsyncIterable<AgentEvent, unknown, undefined> {
  /**
   * The agent's id for the session, or null until the agent reports it. A
   * runtime must set it before it yields its first event or asks about a tool.
   */
  readonly sessionId: string | null;
  /** Sends a prompt. A prompt sent mid turn waits for the turn to end. */
  readonly send: (text: string) => void;
  /** No more prompts, so the agent exits once the current turn is done. */
  readonly endInput: () => void;
  /** Stops the current turn and keeps the session. */
  readonly interrupt: () => Promise<void>;
  /** Kills the agent now. */
  readonly stop: () => void;
  readonly setModel?: (model: string) => Promise<void>;
  /** Takes one of the agent's permission mode ids. */
  readonly setPermissionMode?: (mode: string) => Promise<void>;
  readonly contextUsage?: () => Promise<ContextUsage>;
}

/** Runs the agent from code for the Launcher. */
export interface RuntimeFacet {
  readonly start: (options: StartOptions) => AgentRun;
  /** What the permission inbox says asked: the Claude SDK or any other runtime. */
  readonly permissionSource: Exclude<PermissionRequest['source'], 'hook'>;
}
