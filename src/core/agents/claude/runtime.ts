// Claude Code's runtime: the narrow slice of the Agent SDK that Overlord uses,
// and the translator from SDK messages to agent events. Sessions talk to the
// QueryFunction port, so tests can inject a fake query and only sdkQuery at
// the bottom touches the real SDK. Messages arrive as `unknown` and are
// parsed with zod in harness/messages.ts, which keeps the SDK's large message
// union out of the rest of the code.

import type {
  EffortLevel,
  Options,
  PermissionMode as SdkPermissionMode,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { ZERO_USAGE, type PermissionMode } from '../../../shared/model.js';
import { parsePermissionMode, toEpochMs, toTokenUsage } from '../../harness/events.js';
import { AsyncQueue } from '../../harness/input-queue.js';
import {
  assistantBlocks,
  parseContextUsage,
  parseSdkMessage,
  toolResults,
  type AssistantBlock,
  type AssistantMessage,
  type SdkEvent,
} from '../../harness/messages.js';
import type { AgentEvent, ContentBlock, ContextUsage } from '../shared/events.js';
import type {
  AgentRun,
  RuntimeFacet,
  StartOptions,
  ToolPermissionHandler,
  ToolPermissionResult,
} from '../shared/runtime.js';

/** One prompt written to the CLI in streaming input mode. */
export interface UserInput {
  readonly type: 'user';
  readonly message: { readonly role: 'user'; readonly content: string };
  readonly parent_tool_use_id: null;
}

export interface QueryOptions {
  readonly cwd: string;
  /** Null when resuming without a fork, since the CLI keeps the old id then. */
  readonly sessionId: string | null;
  readonly resume: string | null;
  readonly forkSession: boolean;
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
  /**
   * Runs with Claude Code's own prompt and built-in tools but no MCP servers,
   * as a bridge session does, since every tool's definition goes into each
   * request as text.
   */
  readonly noMcp: boolean;
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

/**
 * What the CLI loads when run from the terminal. Without these the SDK sends
 * an empty system prompt, so a launched run gets none of Claude Code's own
 * instructions. The setting sources are spelled out so a change to the SDK's
 * default cannot drop CLAUDE.md, permissions or hooks.
 */
const CLI_DEFAULTS = {
  systemPrompt: { type: 'preset', preset: 'claude_code' },
  settingSources: ['user', 'project', 'local'],
} as const satisfies Options;

/** What a session without MCP servers turns off. CLAUDE.md and hooks still load. */
function noMcpOptions(): Options {
  return { strictMcpConfig: true, mcpServers: {} };
}

/**
 * The SDK's answer for a decision. Claude requests offer no session allow, so
 * one that arrives anyway allows once. A cancel uses the SDK's interrupt.
 */
export function sdkPermissionResult(result: ToolPermissionResult): PermissionResult {
  if (result.behavior === 'allow') {
    return { behavior: 'allow', updatedInput: result.updatedInput };
  }
  return result.interrupt === true
    ? { behavior: 'deny', message: result.message, interrupt: true }
    : { behavior: 'deny', message: result.message };
}

export function toSdkOptions(options: QueryOptions): Options {
  const { canUseTool } = options;
  return {
    systemPrompt: { ...CLI_DEFAULTS.systemPrompt },
    settingSources: [...CLI_DEFAULTS.settingSources],
    ...(options.noMcp ? noMcpOptions() : {}),
    cwd: options.cwd,
    ...(options.sessionId === null ? {} : { sessionId: options.sessionId }),
    ...(options.resume === null ? {} : { resume: options.resume }),
    ...(options.forkSession ? { forkSession: true } : {}),
    env: { ...options.env },
    abortController: options.abortController,
    extraArgs: { ...options.extraArgs },
    canUseTool: async (toolName, input, context) =>
      sdkPermissionResult(
        await canUseTool(toolName, input, {
          signal: context.signal,
          toolUseId: context.toolUseID,
          agentId: context.agentID ?? null,
        }),
      ),
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
const sdkQuery: QueryFunction = (prompt, options) =>
  query({ prompt, options: toSdkOptions(options) });

export interface PlanUsageOptions {
  readonly cwd: string;
  /** The full environment for the CLI, as in QueryOptions. */
  readonly env: Readonly<Record<string, string>>;
  readonly executablePath: string | null;
}

/** Reads the plan limits /usage shows. Resolves to the raw control reply. */
export type PlanUsageFunction = (options: PlanUsageOptions) => Promise<unknown>;

export function toPlanUsageOptions(options: PlanUsageOptions): Options {
  return {
    cwd: options.cwd,
    env: { ...options.env },
    settingSources: [],
    persistSession: false,
    ...(options.executablePath === null
      ? {}
      : { pathToClaudeCodeExecutable: options.executablePath }),
  };
}

/**
 * The real adapter: starts a CLI with no prompt, asks for the usage data and
 * closes it. No settings load and nothing is written to disk, so it costs
 * about a second.
 */
export const sdkPlanUsage: PlanUsageFunction = async (options) => {
  const input = new AsyncQueue<UserInput>();
  const running = query({ prompt: input, options: toPlanUsageOptions(options) });
  try {
    return await running.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    });
  } finally {
    input.end();
    running.close();
  }
};

const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export function toEffortLevel(value: string | null): EffortLevel | null {
  if (value === null) {
    return null;
  }
  const parsed = effortSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Unknown effort level "${value}"`);
  }
  return parsed.data;
}

/** Profiles hold any agent's mode id, so a Claude run checks it is one of Claude's. */
function claudeMode(value: string): PermissionMode {
  const mode = parsePermissionMode(value);
  if (mode === null) {
    throw new Error(`Unknown permission mode "${value}"`);
  }
  return mode;
}

export function toPermissionMode(value: string | null): PermissionMode | null {
  return value === null ? null : claudeMode(value);
}

/** Overlord's `manual` mode is what the SDK calls `default`: every tool asks. */
export function toSdkPermissionMode(mode: PermissionMode): SdkPermissionMode {
  return mode === 'manual' ? 'default' : mode;
}

type SystemMessage = Extract<SdkEvent, { readonly type: 'system' }>;

function systemEvents(message: SystemMessage): AgentEvent[] {
  switch (message.subtype) {
    case 'init': {
      return [
        {
          type: 'init',
          model: message.model,
          cwd: message.cwd,
          tools: message.tools,
          permissionMode: parsePermissionMode(message.permissionMode),
          mcpServers: message.mcp_servers,
          version: message.claude_code_version ?? null,
        },
      ];
    }
    case 'task_started': {
      return [
        {
          type: 'subagent_started',
          agentId: message.task_id,
          parentAgentId: message.parent_task_id ?? null,
          parentToolUseId: message.tool_use_id ?? null,
          agentType: message.subagent_type ?? message.task_type ?? 'task',
          description: message.description,
          spawnDepth: message.spawn_depth ?? 1,
          background: message.is_backgrounded ?? false,
          model: null,
        },
      ];
    }
    case 'task_notification': {
      return [{ type: 'subagent_ended', agentId: message.task_id, outcome: message.status }];
    }
    case 'compact_boundary': {
      return [
        {
          type: 'compacted',
          trigger: message.compact_metadata.trigger,
          preTokens: message.compact_metadata.pre_tokens,
        },
      ];
    }
  }
}

function contentBlock(block: AssistantBlock): ContentBlock {
  switch (block.type) {
    case 'text': {
      return { type: 'text', text: block.text };
    }
    case 'thinking': {
      return { type: 'thinking', text: block.thinking };
    }
    case 'tool_use': {
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    }
  }
}

function messageEvent(message: AssistantMessage): AgentEvent {
  const body = message.message;
  return {
    type: 'message',
    messageId: body.id,
    requestId: message.request_id ?? null,
    model: body.model,
    agentId: message.agent_id ?? null,
    parentToolUseId: message.parent_tool_use_id,
    usage: body.usage === null || body.usage === undefined ? ZERO_USAGE : toTokenUsage(body.usage),
    blocks: assistantBlocks(body.content).map((block) => contentBlock(block)),
  };
}

/** Turns one raw SDK message into agent events. Messages Overlord does not read give none. */
export function claudeEvents(raw: unknown): AgentEvent[] {
  const message = parseSdkMessage(raw);
  if (message === null) {
    return [];
  }
  switch (message.type) {
    case 'system': {
      return systemEvents(message);
    }
    case 'assistant': {
      return [messageEvent(message)];
    }
    case 'user': {
      return toolResults(message.message.content).map((result) => ({
        type: 'tool_result',
        toolUseId: result.toolUseId,
        ok: result.ok,
        text: result.text,
      }));
    }
    case 'result': {
      return [
        {
          type: 'turn_result',
          ok: !message.is_error,
          subtype: message.subtype,
          text: message.result ?? message.errors?.join('; ') ?? null,
          costUsd: message.total_cost_usd,
          turns: message.num_turns,
          durationMs: message.duration_ms,
          usage: toTokenUsage(message.usage),
        },
      ];
    }
    case 'rate_limit_event': {
      const info = message.rate_limit_info;
      if (info.rateLimitType === undefined) {
        return [];
      }
      // utilization is a fraction of the window; the bus carries percent.
      const usedPct = info.utilization === undefined ? null : info.utilization * 100;
      return [
        {
          type: 'rate_limit',
          windows: [
            {
              id: info.rateLimitType,
              usedPct,
              resetsAt: toEpochMs(info.resetsAt),
              windowMinutes: null,
            },
          ],
        },
      ];
    }
  }
}

/** One Claude Code session in streaming input mode, so every prompt goes to the same process. */
class ClaudeRun implements AgentRun {
  readonly sessionId: string;
  private readonly input = new AsyncQueue<UserInput>();
  private readonly abort = new AbortController();
  private readonly query: SessionQuery;

  constructor(queryFunction: QueryFunction, options: StartOptions) {
    // A plain resume keeps the old id. A fork takes the one Overlord picked.
    const keepsOldId = options.resumeId !== null && !options.fork;
    this.sessionId = keepsOldId ? options.resumeId : options.sessionId;
    this.query = queryFunction(this.input, {
      cwd: options.cwd,
      sessionId: keepsOldId ? null : options.sessionId,
      resume: options.resumeId,
      forkSession: options.resumeId !== null && options.fork,
      env: options.env,
      abortController: this.abort,
      canUseTool: options.canUseTool,
      model: options.model,
      effort: toEffortLevel(options.effort),
      permissionMode:
        options.permissionMode === null
          ? null
          : toSdkPermissionMode(claudeMode(options.permissionMode)),
      extraArgs: options.extraArgs,
      maxBudgetUsd: options.maxBudgetUsd,
      executablePath: options.executablePath,
      noMcp: options.noMcp,
    });
  }

  readonly send = (text: string): void => {
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
  };

  readonly endInput = (): void => {
    this.input.end();
  };

  readonly interrupt = async (): Promise<void> => {
    await this.query.interrupt();
  };

  readonly stop = (): void => {
    this.input.end();
    this.abort.abort();
  };

  readonly setModel = async (model: string): Promise<void> => {
    await this.query.setModel(model);
  };

  readonly setPermissionMode = async (mode: string): Promise<void> => {
    await this.query.setPermissionMode(toSdkPermissionMode(claudeMode(mode)));
  };

  readonly contextUsage = async (): Promise<ContextUsage> =>
    parseContextUsage(await this.query.getContextUsage());

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent, undefined, undefined> {
    for await (const raw of this.query) {
      yield* claudeEvents(raw);
    }
    return undefined;
  }
}

/** The Claude runtime over a query function, the real SDK unless a test passes a fake. */
export function claudeRuntime(queryFunction: QueryFunction = sdkQuery): RuntimeFacet {
  return {
    start: (options) => new ClaudeRun(queryFunction, options),
    permissionSource: 'sdk',
  };
}

export { type PermissionMode as SdkPermissionMode } from '@anthropic-ai/claude-agent-sdk';
