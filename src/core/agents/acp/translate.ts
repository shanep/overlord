// Turns ACP session updates into agent events. ACP streams a reply in chunks
// and marks no model call boundaries, so the chunks are buffered and go out as
// one message each time a tool call starts or the turn ends. A tool call whose
// input is not known yet is held, since the reducer cannot change a call once
// it has started, and goes out when its input arrives or the call finishes.

import type {
  ContentBlock as AcpContentBlock,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
  ToolCall,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';

import type { TokenUsage } from '../../../shared/model.js';
import type { AgentEvent, ContentBlock } from '../shared/events.js';

import { blockText, configValue, planText, resultText, toolName } from './content.js';

export interface TranslatorOptions {
  /** Mints message ids, since ACP gives none. */
  readonly newId: () => string;
  /** The agent's mode id as Overlord shows it. */
  readonly modeName: (modeId: string) => string;
  readonly model: string;
  readonly modeId: string | null;
  readonly configOptions: readonly SessionConfigOption[];
}

export interface TurnEnd {
  readonly stopReason: StopReason;
  readonly usage: TokenUsage | null;
  readonly durationMs: number;
}

interface HeldTool {
  readonly name: string;
  readonly title: string | null;
}

type UpdateKind = SessionUpdate['sessionUpdate'];
type UpdateOf<K extends UpdateKind> = Extract<SessionUpdate, { readonly sessionUpdate: K }>;
type UpdateHandlers = { readonly [K in UpdateKind]: (update: UpdateOf<K>) => AgentEvent[] };

/** Calls the handler for one kind of update. */
function handle<K extends UpdateKind>(
  handlers: UpdateHandlers,
  kind: K,
  update: UpdateOf<K>,
): AgentEvent[] {
  const handler: UpdateHandlers[K] = handlers[kind];
  return handler(update);
}

const nothing = (): AgentEvent[] => [];

function finished(update: ToolCallUpdate): boolean {
  return update.status === 'completed' || update.status === 'failed';
}

function result(update: ToolCallUpdate): AgentEvent {
  return {
    type: 'tool_result',
    toolUseId: update.toolCallId,
    ok: update.status === 'completed',
    text: resultText(update),
  };
}

function titleInput(title: string | null | undefined): Record<string, unknown> {
  return title === null || title === undefined ? {} : { title };
}

export class AcpTranslator {
  private readonly newId: () => string;
  private readonly modeName: (modeId: string) => string;
  private blocks: ContentBlock[] = [];
  private readonly held = new Map<string, HeldTool>();
  private readonly started = new Set<string>();
  private lastMessageId: string | null = null;
  private lastText: string | null = null;
  private costUsd: number | null = null;
  private currentModel: string;
  private currentMode: string | null;
  private context: { readonly used: number; readonly size: number } | null = null;
  private options: readonly SessionConfigOption[];

  // User chunks echo what Overlord sent. Commands, titles, subagents and whole
  // session messages have no agent event yet.
  private readonly handlers: UpdateHandlers = {
    agent_message_chunk: (update) => this.append('text', update.content),
    agent_thought_chunk: (update) => this.append('thinking', update.content),
    tool_call: (update) => this.toolCall(update),
    tool_call_update: (update) => this.toolUpdate(update),
    plan: (update) => [{ type: 'notice', text: planText(update.entries) }],
    current_mode_update: (update) => this.modeReported(update.currentModeId),
    config_option_update: (update) => this.configReported(update.configOptions),
    usage_update: (update) => this.usageReported(update.used, update.size, update.cost ?? null),
    notice: (update) => {
      const detail = update.description ?? '';
      return [
        { type: 'notice', text: detail === '' ? update.title : `${update.title}: ${detail}` },
      ];
    },
    compaction_update: (update) =>
      update.status === 'completed'
        ? [{ type: 'compacted', trigger: 'auto', preTokens: null }]
        : [],
    user_message_chunk: nothing,
    available_commands_update: nothing,
    session_info_update: nothing,
    plan_update: nothing,
    plan_removed: nothing,
    compaction_summary_chunk: nothing,
    subagent_update: nothing,
    session_message: nothing,
    session_message_chunk: nothing,
  };

  constructor(options: TranslatorOptions) {
    this.newId = options.newId;
    this.modeName = options.modeName;
    this.currentModel = options.model;
    this.currentMode = options.modeId;
    this.options = options.configOptions;
  }

  get model(): string {
    return this.currentModel;
  }

  get mode(): string | null {
    return this.currentMode;
  }

  get config(): readonly SessionConfigOption[] {
    return this.options;
  }

  /** The last context window report, or null before the agent sent one. */
  get window(): { readonly used: number; readonly size: number } | null {
    return this.context;
  }

  update(update: SessionUpdate): AgentEvent[] {
    return handle(this.handlers, update.sessionUpdate, update);
  }

  /** A permission request names the call's input, so a held call can go out with it. */
  permissionAsked(call: ToolCallUpdate): AgentEvent[] {
    const held = this.held.get(call.toolCallId);
    if (held === undefined || call.rawInput === undefined) {
      return [];
    }
    return this.release(call.toolCallId, held, call.rawInput);
  }

  /** The tool name for a permission request, from the request or the call it asks about. */
  nameOf(call: ToolCallUpdate): string {
    return toolName(call) ?? this.held.get(call.toolCallId)?.name ?? call.title ?? 'tool';
  }

  /** Settings the agent sent back after Overlord changed one. */
  configChanged(options: readonly SessionConfigOption[]): void {
    this.options = options;
    this.currentModel = configValue(options, 'model')?.value ?? this.currentModel;
    this.currentMode = configValue(options, 'mode')?.value ?? this.currentMode;
  }

  modeSet(modeId: string): void {
    this.currentMode = modeId;
  }

  endTurn(end: TurnEnd): AgentEvent[] {
    const pending = [...this.flush(), ...this.releaseAll()];
    const usage: AgentEvent[] =
      end.usage === null
        ? []
        : [
            {
              type: 'usage',
              messageId: this.lastMessageId ?? this.newId(),
              requestId: null,
              model: this.currentModel,
              agentId: null,
              parentToolUseId: null,
              usage: end.usage,
              costUsd: null,
              durationMs: end.durationMs,
              ttftMs: null,
            },
          ];
    const cancelled = end.stopReason === 'cancelled';
    return [
      ...pending,
      ...usage,
      this.turnResult({
        ok: end.stopReason === 'end_turn',
        subtype: cancelled ? 'interrupted' : end.stopReason,
        text: this.lastText,
        durationMs: end.durationMs,
        usage: end.usage,
      }),
    ];
  }

  /** A prompt the agent answered with an error instead of a stop reason. */
  failTurn(message: string, durationMs: number): AgentEvent[] {
    const pending = [...this.flush(), ...this.releaseAll()];
    return [
      ...pending,
      this.turnResult({ ok: false, subtype: 'error', text: message, durationMs, usage: null }),
    ];
  }

  private turnResult(end: {
    readonly ok: boolean;
    readonly subtype: string;
    readonly text: string | null;
    readonly durationMs: number;
    readonly usage: TokenUsage | null;
  }): AgentEvent {
    this.lastMessageId = null;
    this.lastText = null;
    return { type: 'turn_result', ...end, costUsd: this.costUsd, turns: null };
  }

  private append(type: 'text' | 'thinking', content: AcpContentBlock): AgentEvent[] {
    const text = blockText(content);
    const last = this.blocks.at(-1);
    if (last?.type === type) {
      this.blocks[this.blocks.length - 1] = { type, text: last.text + text };
    } else {
      this.blocks.push({ type, text });
    }
    return [];
  }

  /** A message from the buffered chunks plus any tool calls, or nothing when both are empty. */
  private message(tools: readonly ContentBlock[]): AgentEvent[] {
    const blocks = [...this.blocks, ...tools];
    this.blocks = [];
    if (blocks.length === 0) {
      return [];
    }
    const messageId = this.newId();
    this.lastMessageId = messageId;
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (text !== '') {
      this.lastText = text;
    }
    return [
      {
        type: 'message',
        messageId,
        requestId: null,
        model: this.currentModel,
        agentId: null,
        parentToolUseId: null,
        usage: null,
        blocks,
      },
    ];
  }

  private flush(): AgentEvent[] {
    return this.message([]);
  }

  private toolUse(id: string, name: string, input: unknown): ContentBlock {
    this.started.add(id);
    return { type: 'tool_use', id, name, input };
  }

  private release(id: string, held: HeldTool, input: unknown): AgentEvent[] {
    this.held.delete(id);
    return this.message([this.toolUse(id, held.name, input)]);
  }

  /** Calls still held when the turn ends go out with what is known about them. */
  private releaseAll(): AgentEvent[] {
    return [...this.held].flatMap(([id, held]) => this.release(id, held, titleInput(held.title)));
  }

  private toolCall(call: ToolCall): AgentEvent[] {
    if (this.started.has(call.toolCallId)) {
      return finished(call) ? [result(call)] : [];
    }
    const held: HeldTool = { name: toolName(call) ?? call.title, title: call.title };
    if (call.rawInput === undefined && !finished(call)) {
      this.held.set(call.toolCallId, held);
      return this.flush();
    }
    const input = call.rawInput ?? titleInput(held.title);
    const events = this.message([this.toolUse(call.toolCallId, held.name, input)]);
    return finished(call) ? [...events, result(call)] : events;
  }

  /** The tool_use for an update, when this is the first the call can be shown. */
  private startFromUpdate(update: ToolCallUpdate): AgentEvent[] {
    const held = this.held.get(update.toolCallId);
    if (held !== undefined) {
      return update.rawInput !== undefined || finished(update)
        ? this.release(update.toolCallId, held, update.rawInput ?? titleInput(held.title))
        : [];
    }
    if (this.started.has(update.toolCallId)) {
      return [];
    }
    // A call first seen when it is done.
    const name = toolName(update) ?? update.title ?? 'tool';
    const input = update.rawInput ?? titleInput(update.title);
    return this.message([this.toolUse(update.toolCallId, name, input)]);
  }

  private toolUpdate(update: ToolCallUpdate): AgentEvent[] {
    const events = this.startFromUpdate(update);
    return finished(update) && this.started.has(update.toolCallId)
      ? [...events, result(update)]
      : events;
  }

  private modeReported(modeId: string): AgentEvent[] {
    if (modeId === this.currentMode) {
      return [];
    }
    this.currentMode = modeId;
    return [{ type: 'mode_changed', permissionMode: this.modeName(modeId) }];
  }

  private configReported(options: readonly SessionConfigOption[]): AgentEvent[] {
    this.options = options;
    const model = configValue(options, 'model')?.value;
    const modelEvents: AgentEvent[] = [];
    if (model !== undefined && model !== this.currentModel) {
      this.currentModel = model;
      modelEvents.push({ type: 'model_changed', model });
    }
    const mode = configValue(options, 'mode')?.value;
    return [...modelEvents, ...(mode === undefined ? [] : this.modeReported(mode))];
  }

  private usageReported(
    used: number,
    size: number,
    cost: { readonly amount: number; readonly currency: string } | null,
  ): AgentEvent[] {
    this.context = { used, size };
    if (cost?.currency === 'USD') {
      this.costUsd = cost.amount;
    }
    return [{ type: 'context', usedTokens: used, maxTokens: size }];
  }
}
