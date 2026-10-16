// The narrow slice of the Agent SDK that the harness uses. Sessions talk to
// this interface, so tests can inject a fake query and only the adapter at the
// bottom touches the real SDK. Messages arrive as `unknown` and are parsed with
// zod in messages.ts, which keeps the SDK's large message union out of the
// rest of the code.

import type {
  EffortLevel,
  Options,
  PermissionMode as SdkPermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

/** One prompt written to the CLI in streaming input mode. */
export interface UserInput {
  readonly type: 'user';
  readonly message: { readonly role: 'user'; readonly content: string };
  readonly parent_tool_use_id: null;
}

export interface ToolPermissionContext {
  readonly signal: AbortSignal;
  readonly toolUseId: string;
  /** The subagent asking, or null for the main thread. */
  readonly agentId: string | null;
}

export type ToolPermissionResult =
  | { readonly behavior: 'allow'; readonly updatedInput: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string };

type ToolPermissionHandler = (
  toolName: string,
  input: Record<string, unknown>,
  context: ToolPermissionContext,
) => Promise<ToolPermissionResult>;

export interface QueryOptions {
  readonly cwd: string;
  readonly sessionId: string;
  /** The full environment for the CLI. The SDK does not merge it onto process.env. */
  readonly env: Readonly<Record<string, string>>;
  readonly abortController: AbortController;
  readonly canUseTool: ToolPermissionHandler;
  readonly model: string | null;
  readonly effort: EffortLevel | null;
  readonly permissionMode: SdkPermissionMode | null;
  readonly extraArgs: Readonly<Record<string, string | null>>;
  readonly maxBudgetUsd: number | null;
  /** A Claude Code binary or a .js/.mjs script, which the SDK runs with node. */
  readonly executablePath: string | null;
}

/** The running query: an async stream of raw SDK messages plus control calls. */
export interface SessionQuery extends AsyncIterable<unknown, unknown, undefined> {
  readonly interrupt: () => Promise<unknown>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: SdkPermissionMode) => Promise<void>;
  readonly getContextUsage: () => Promise<unknown>;
  readonly close: () => void;
}

export type QueryFunction = (
  prompt: AsyncIterable<UserInput, undefined, undefined>,
  options: QueryOptions,
) => SessionQuery;

export function toSdkOptions(options: QueryOptions): Options {
  const { canUseTool } = options;
  return {
    cwd: options.cwd,
    sessionId: options.sessionId,
    env: { ...options.env },
    abortController: options.abortController,
    extraArgs: { ...options.extraArgs },
    canUseTool: async (toolName, input, context) =>
      canUseTool(toolName, input, {
        signal: context.signal,
        toolUseId: context.toolUseID,
        agentId: context.agentID ?? null,
      }),
    ...(options.model === null ? {} : { model: options.model }),
    ...(options.effort === null ? {} : { effort: options.effort }),
    ...(options.permissionMode === null ? {} : { permissionMode: options.permissionMode }),
    // The SDK refuses bypassPermissions unless this is set too.
    ...(options.permissionMode === 'bypassPermissions'
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(options.maxBudgetUsd === null ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
    ...(options.executablePath === null
      ? {}
      : { pathToClaudeCodeExecutable: options.executablePath }),
  };
}

/** The real adapter: runs the SDK's query() in streaming input mode. */
export const sdkQuery: QueryFunction = (prompt, options) =>
  query({ prompt, options: toSdkOptions(options) });

export {
  type EffortLevel,
  type PermissionMode as SdkPermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
