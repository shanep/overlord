// What `codex app-server` sends, read with zod, and the translator from its
// notifications to agent events. Shapes come from `codex app-server
// generate-ts` and the recording in test/fixtures/codex/0.163.0/app-server.
// Codex reports usage once per model call apart from the items, so messages
// carry no usage and each call gets a usage event of its own.

import { z } from 'zod';

import { ZERO_USAGE, type TokenUsage } from '../../../shared/model.js';
import { addUsage } from '../../harness/events.js';
import type { AgentEvent, RateLimitWindowReport } from '../shared/events.js';

import { permissionModeId } from './capabilities.js';
import { toTokenUsage } from './convert.js';
import {
  isToolItem,
  itemSchema,
  itemTool,
  toolOutcome,
  type Item,
  type ItemTool,
  type ToolItem,
} from './items.js';

const count = z.number().catch(0);

const usageSchema = z.object({
  totalTokens: count,
  inputTokens: count,
  cachedInputTokens: count,
  cacheWriteInputTokens: count,
  outputTokens: count,
  reasoningOutputTokens: count,
});

type Usage = z.infer<typeof usageSchema>;

/** Codex counts cached input inside input, so this moves it out, as the shared model wants. */
function callUsage(usage: Usage): TokenUsage {
  return toTokenUsage({
    input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    cache_write_input_tokens: usage.cacheWriteInputTokens,
    output_tokens: usage.outputTokens,
    reasoning_output_tokens: usage.reasoningOutputTokens,
  });
}

/** The result of thread/start, thread/resume and thread/fork. */
export const threadResultSchema = z.object({
  thread: z.object({ id: z.string(), cliVersion: z.string().nullish() }),
  model: z.string(),
  cwd: z.string(),
  approvalPolicy: z.unknown(),
  sandbox: z.object({ type: z.string() }).nullish(),
});

export type ThreadResult = z.infer<typeof threadResultSchema>;

export const turnResultSchema = z.object({ turn: z.object({ id: z.string() }) });

const windowSchema = z
  .object({
    usedPercent: z.number().nullish(),
    windowDurationMins: z.number().nullish(),
    resetsAt: z.number().nullish(),
  })
  .nullish();

/** A rate limit snapshot, as account/rateLimits/updated and account/rateLimits/read give it. */
const rateLimitsSchema = z.object({
  rateLimits: z.object({ primary: windowSchema, secondary: windowSchema }),
});

const SANDBOX_MODES: Readonly<Record<string, string>> = {
  readOnly: 'read-only',
  workspaceWrite: 'workspace-write',
  dangerFullAccess: 'danger-full-access',
};

/** The started thread as an init event. The permission mode is null for a granular policy. */
export function initEvent(thread: ThreadResult, known: readonly string[]): AgentEvent {
  const sandbox =
    thread.sandbox === null || thread.sandbox === undefined
      ? undefined
      : SANDBOX_MODES[thread.sandbox.type];
  const mode =
    typeof thread.approvalPolicy === 'string' && sandbox !== undefined
      ? permissionModeId(thread.approvalPolicy, sandbox)
      : null;
  return {
    type: 'init',
    model: thread.model,
    cwd: thread.cwd,
    // Codex lists no tools up front.
    tools: [],
    permissionMode: mode !== null && known.includes(mode) ? mode : null,
    mcpServers: [],
    version: thread.thread.cliVersion ?? null,
  };
}

/** Codex's primary and secondary windows, under the ids the rollout observer uses. */
export function rateLimitEvent(raw: unknown): AgentEvent | null {
  const parsed = rateLimitsSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const { primary, secondary } = parsed.data.rateLimits;
  const windows = (
    [
      ['primary', primary],
      ['secondary', secondary],
    ] as const
  ).flatMap(([id, window]): RateLimitWindowReport[] =>
    window === null || window === undefined
      ? []
      : [
          {
            id,
            usedPct: window.usedPercent ?? null,
            // Codex sends epoch seconds.
            resetsAt:
              window.resetsAt === null || window.resetsAt === undefined
                ? null
                : window.resetsAt * 1000,
            windowMinutes: window.windowDurationMins ?? null,
          },
        ],
  );
  return windows.length === 0 ? null : { type: 'rate_limit', windows };
}

const itemNoticeSchema = z.object({ turnId: z.string(), item: z.unknown() });

const turnCompletedSchema = z.object({
  turn: z.object({
    id: z.string(),
    status: z.string(),
    error: z.object({ message: z.string() }).nullish(),
    durationMs: z.number().nullish(),
  }),
});

const tokenUsageSchema = z.object({
  turnId: z.string(),
  tokenUsage: z.object({
    total: usageSchema,
    last: usageSchema,
    modelContextWindow: z.number().nullish(),
  }),
});

const errorSchema = z.object({ error: z.object({ message: z.string() }), willRetry: z.boolean() });
const messageSchema = z.object({ message: z.string() });
const summarySchema = z.object({ summary: z.string(), details: z.string().nullish() });
const reroutedSchema = z.object({ toModel: z.string() });

/** "success" like Claude's results, "interrupted" for turn/interrupt, and "error" for a failure. */
function turnSubtype(status: string): string {
  if (status === 'completed') {
    return 'success';
  }
  return status === 'interrupted' ? 'interrupted' : 'error';
}

interface TurnState {
  /** Model calls Codex has reported usage for so far. */
  calls: number;
  usage: TokenUsage;
  lastText: string | null;
}

/** Turns one thread's notifications into agent events. Keeps per-turn call counts and usage. */
export class CodexTranslator {
  private model: string;
  private readonly turns = new Map<string, TurnState>();
  private readonly tools = new Map<string, ItemTool>();
  private threadTotal = -1;

  constructor(model: string) {
    this.model = model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  /** The tool an item started as, for the approval that asks about it. */
  tool(itemId: string): ItemTool | null {
    return this.tools.get(itemId) ?? null;
  }

  notification(method: string, params: unknown): AgentEvent[] {
    switch (method) {
      case 'item/started': {
        return this.itemStarted(params);
      }
      case 'item/completed': {
        return this.itemCompleted(params);
      }
      case 'thread/tokenUsage/updated': {
        return this.tokenUsage(params);
      }
      case 'account/rateLimits/updated': {
        const event = rateLimitEvent(params);
        return event === null ? [] : [event];
      }
      case 'turn/completed': {
        return this.turnCompleted(params);
      }
      default: {
        return this.reported(method, params);
      }
    }
  }

  /** Things outside a turn's items: warnings, retries, reroutes and compaction. */
  private reported(method: string, params: unknown): AgentEvent[] {
    switch (method) {
      case 'error': {
        // A final error also fails the turn, and turn/completed says so.
        const parsed = errorSchema.safeParse(params);
        return parsed.success && parsed.data.willRetry
          ? [{ type: 'notice', text: `Codex is retrying: ${parsed.data.error.message}` }]
          : [];
      }
      case 'warning': {
        const parsed = messageSchema.safeParse(params);
        return parsed.success ? [{ type: 'notice', text: parsed.data.message }] : [];
      }
      case 'configWarning':
      case 'deprecationNotice': {
        const parsed = summarySchema.safeParse(params);
        return parsed.success
          ? [
              {
                type: 'notice',
                text: [parsed.data.summary, parsed.data.details].filter(Boolean).join(': '),
              },
            ]
          : [];
      }
      case 'model/rerouted': {
        const parsed = reroutedSchema.safeParse(params);
        if (!parsed.success) {
          return [];
        }
        this.model = parsed.data.toModel;
        return [{ type: 'model_changed', model: parsed.data.toModel }];
      }
      case 'thread/compacted': {
        return [{ type: 'compacted', trigger: 'auto', preTokens: null }];
      }
      default: {
        return [];
      }
    }
  }

  private turn(turnId: string): TurnState {
    let state = this.turns.get(turnId);
    if (state === undefined) {
      state = { calls: 0, usage: ZERO_USAGE, lastText: null };
      this.turns.set(turnId, state);
    }
    return state;
  }

  /** The id of the model call now running in a turn, unique across the thread. */
  private callId(turnId: string): string {
    return `${turnId}:${String(this.turn(turnId).calls + 1)}`;
  }

  private message(
    turnId: string,
    blocks: Extract<AgentEvent, { type: 'message' }>['blocks'],
  ): AgentEvent {
    return {
      type: 'message',
      messageId: this.callId(turnId),
      requestId: null,
      model: this.model,
      agentId: null,
      parentToolUseId: null,
      usage: null,
      blocks,
    };
  }

  private parseItem(params: unknown): { readonly turnId: string; readonly item: Item } | null {
    const notice = itemNoticeSchema.safeParse(params);
    if (!notice.success) {
      return null;
    }
    const item = itemSchema.safeParse(notice.data.item);
    return item.success ? { turnId: notice.data.turnId, item: item.data } : null;
  }

  private toolStarted(turnId: string, item: ToolItem): AgentEvent[] {
    if (this.tools.has(item.id)) {
      return [];
    }
    const tool = itemTool(item);
    this.tools.set(item.id, tool);
    return [
      this.message(turnId, [{ type: 'tool_use', id: item.id, name: tool.name, input: tool.input }]),
    ];
  }

  private itemStarted(params: unknown): AgentEvent[] {
    const parsed = this.parseItem(params);
    if (parsed === null) {
      return [];
    }
    const { turnId, item } = parsed;
    return isToolItem(item) ? this.toolStarted(turnId, item) : [];
  }

  private itemCompleted(params: unknown): AgentEvent[] {
    const parsed = this.parseItem(params);
    if (parsed === null) {
      return [];
    }
    const { turnId, item } = parsed;
    switch (item.type) {
      case 'agentMessage': {
        this.turn(turnId).lastText = item.text;
        return item.text === '' ? [] : [this.message(turnId, [{ type: 'text', text: item.text }])];
      }
      case 'reasoning': {
        const text = [...item.summary, ...item.content].join('\n').trim();
        return text === '' ? [] : [this.message(turnId, [{ type: 'thinking', text }])];
      }
      case 'contextCompaction': {
        return [{ type: 'compacted', trigger: 'auto', preTokens: null }];
      }
      case 'commandExecution':
      case 'fileChange':
      case 'mcpToolCall': {
        const outcome = toolOutcome(item);
        return [
          ...this.toolStarted(turnId, item),
          { type: 'tool_result', toolUseId: item.id, ok: outcome.ok, text: outcome.text },
        ];
      }
    }
  }

  /** One usage event per model call. A report with no new tokens, as an interrupt sends, is skipped. */
  private tokenUsage(params: unknown): AgentEvent[] {
    const parsed = tokenUsageSchema.safeParse(params);
    if (!parsed.success) {
      return [];
    }
    const { turnId, tokenUsage } = parsed.data;
    if (tokenUsage.total.totalTokens <= this.threadTotal) {
      return [];
    }
    this.threadTotal = tokenUsage.total.totalTokens;
    const usage = callUsage(tokenUsage.last);
    const messageId = this.callId(turnId);
    const state = this.turn(turnId);
    state.calls += 1;
    state.usage = addUsage(state.usage, usage);
    const events: AgentEvent[] = [
      {
        type: 'usage',
        messageId,
        requestId: null,
        model: this.model,
        agentId: null,
        parentToolUseId: null,
        usage,
        costUsd: null,
        durationMs: null,
        ttftMs: null,
      },
    ];
    const max = tokenUsage.modelContextWindow ?? null;
    if (max !== null && max > 0) {
      events.push({ type: 'context', usedTokens: tokenUsage.last.totalTokens, maxTokens: max });
    }
    return events;
  }

  private turnCompleted(params: unknown): AgentEvent[] {
    const parsed = turnCompletedSchema.safeParse(params);
    if (!parsed.success) {
      return [];
    }
    const { turn } = parsed.data;
    const state = this.turn(turn.id);
    this.turns.delete(turn.id);
    const ok = turn.status === 'completed';
    return [
      {
        type: 'turn_result',
        ok,
        subtype: turnSubtype(turn.status),
        text: turn.error?.message ?? state.lastText,
        costUsd: null,
        turns: null,
        durationMs: turn.durationMs ?? null,
        usage: state.usage,
      },
    ];
  }
}
