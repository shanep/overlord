// State for one transcript thread: the main conversation or one subagent.

import type {
  ApiRequest,
  FeedItem,
  SessionState,
  TokenUsage,
  ToolCall,
} from '../../shared/model.js';
import { ZERO_USAGE } from '../../shared/model.js';

import { ContextTracker } from './context.js';
import type { PriceTable } from './pricing.js';
import { estimateCost } from './pricing.js';
import type {
  AssistantRecord,
  ContentBlock,
  SystemRecord,
  TranscriptRecord,
  UserRecord,
} from './schemas.js';
import { parseTimestamp } from './schemas.js';
import type { TaskNotification } from './text.js';
import {
  addUsage,
  isTaskNotification,
  parseTaskNotification,
  preview,
  resultText,
  usageFromRaw,
} from './text.js';

export interface ThreadOptions {
  readonly sessionId: string;
  readonly agentId: string;
  readonly prices: PriceTable;
  readonly feedLimit: number;
  readonly previewChars: number;
}

/** What one record changed, so a watcher can publish only that. */
export interface ThreadDelta {
  readonly tools: ToolCall[];
  readonly requests: ApiRequest[];
  readonly feed: FeedItem[];
  readonly compactions: number[];
  contextChanged: boolean;
}

export interface ToolOutcome {
  readonly at: number;
  readonly ok: boolean;
  /** True when the tool only launched a background task and returned at once. */
  readonly async: boolean;
}

export interface NotificationOutcome {
  readonly at: number;
  readonly status: string;
}

// Claude Code writes these for errors it raises itself, not for API calls.
const SYNTHETIC_MODEL = '<synthetic>';
const OPEN_STOP_REASONS = new Set(['tool_use', 'pause_turn']);

function emptyDelta(): ThreadDelta {
  return { tools: [], requests: [], feed: [], compactions: [], contextChanged: false };
}

export class AgentThread {
  readonly context = new ContextTracker();
  firstAt: number | null = null;
  lastAt: number | null = null;
  model: string | null = null;
  effort: string | null = null;
  firstPrompt: string | null = null;
  private turnOpen = false;
  private readonly toolMap = new Map<string, ToolCall>();
  /** Tool use id to tool name, for calls still waiting on a result, in start order. */
  private readonly openTools = new Map<string, string>();
  private readonly outcomes = new Map<string, ToolOutcome>();
  private readonly notifications = new Map<string, NotificationOutcome>();
  private readonly requestMap = new Map<string, ApiRequest>();
  private readonly feedItems: FeedItem[] = [];
  private readonly compactionTimes: number[] = [];

  constructor(private readonly options: ThreadOptions) {}

  get agentId(): string {
    return this.options.agentId;
  }

  ingest(record: TranscriptRecord): ThreadDelta {
    const delta = emptyDelta();
    switch (record.type) {
      case 'user': {
        this.ingestUser(record, this.touch(record.timestamp), delta);
        break;
      }
      case 'assistant': {
        this.ingestAssistant(record, this.touch(record.timestamp), delta);
        break;
      }
      case 'system': {
        this.ingestSystem(record, this.touch(record.timestamp), delta);
        break;
      }
      case 'attachment': {
        const at = this.touch(record.timestamp);
        if (record.attachment.type === 'queued_command') {
          this.noteNotification(parseTaskNotification(record.attachment.prompt), at);
        }
        delta.contextChanged = this.context.apply(record.attachment, at);
        break;
      }
      case 'permission-mode':
      case 'ai-title':
      case 'custom-title':
      case 'last-prompt': {
        break;
      }
    }
    for (const item of delta.feed) {
      this.feedItems.push(item);
    }
    const excess = this.feedItems.length - this.options.feedLimit;
    if (excess > 0) {
      this.feedItems.splice(0, excess);
    }
    return delta;
  }

  /** True while a turn is open or a tool call has no result yet. */
  get busy(): boolean {
    return this.turnOpen || this.openTools.size > 0;
  }

  state(now: number, windowMs: number): SessionState {
    if (this.lastAt === null) {
      return 'unknown';
    }
    const recent = now - this.lastAt <= windowMs;
    return recent && this.busy ? 'running' : 'idle';
  }

  usage(): TokenUsage {
    let total = ZERO_USAGE;
    for (const request of this.requestMap.values()) {
      total = addUsage(total, request.usage);
    }
    return total;
  }

  toolCalls(): ToolCall[] {
    return [...this.toolMap.values()];
  }

  requests(): ApiRequest[] {
    return [...this.requestMap.values()];
  }

  feed(limit: number): FeedItem[] {
    return limit <= 0 ? [] : this.feedItems.slice(-limit);
  }

  compactions(): number[] {
    return [...this.compactionTimes];
  }

  /** Name of the most recently started tool that has no result yet. */
  currentTool(): string | null {
    return [...this.openTools.values()].at(-1) ?? null;
  }

  hasToolUse(toolUseId: string): boolean {
    return this.toolMap.has(toolUseId);
  }

  outcome(toolUseId: string): ToolOutcome | null {
    return this.outcomes.get(toolUseId) ?? null;
  }

  notification(toolUseId: string): NotificationOutcome | null {
    return this.notifications.get(toolUseId) ?? null;
  }

  private touch(timestamp: string | null | undefined): number | null {
    const at = parseTimestamp(timestamp);
    if (at !== null) {
      this.firstAt ??= at;
      this.lastAt = this.lastAt === null ? at : Math.max(this.lastAt, at);
    }
    return at;
  }

  private ingestUser(record: UserRecord, at: number | null, delta: ThreadDelta): void {
    const content = record.message.content;
    const id = record.uuid ?? `user-${String(this.feedItems.length + delta.feed.length)}`;
    const meta = record.isMeta === true || record.isCompactSummary === true;
    if (typeof content === 'string') {
      this.ingestUserText({ id, text: content, meta, at: at ?? 0 }, delta);
      return;
    }
    const asyncLaunch = record.toolUseResult?.status === 'async_launched';
    for (const [index, block] of content.entries()) {
      const blockId = `${id}:${String(index)}`;
      if (block.type === 'text') {
        this.ingestUserText({ id: blockId, text: block.text, meta, at: at ?? 0 }, delta);
      } else if (block.type === 'tool_result') {
        this.ingestToolResult({ block, id: blockId, at: at ?? 0, asyncLaunch }, delta);
      }
    }
  }

  private ingestUserText(
    item: {
      readonly id: string;
      readonly text: string;
      readonly meta: boolean;
      readonly at: number;
    },
    delta: ThreadDelta,
  ): void {
    if (item.meta || isTaskNotification(item.text)) {
      this.noteNotification(parseTaskNotification(item.text), item.at);
      delta.feed.push({ kind: 'system', id: item.id, at: item.at, text: item.text });
      return;
    }
    this.turnOpen = true;
    this.firstPrompt ??= item.text;
    delta.feed.push({ kind: 'user', id: item.id, at: item.at, text: item.text });
  }

  private ingestToolResult(
    input: {
      readonly block: Extract<ContentBlock, { type: 'tool_result' }>;
      readonly id: string;
      readonly at: number;
      readonly asyncLaunch: boolean;
    },
    delta: ThreadDelta,
  ): void {
    const { block, at } = input;
    const ok = block.is_error !== true;
    const text = resultText(block.content);
    this.openTools.delete(block.tool_use_id);
    this.outcomes.set(block.tool_use_id, { at, ok, async: input.asyncLaunch });
    const call = this.toolMap.get(block.tool_use_id);
    if (call !== undefined) {
      const updated: ToolCall = {
        ...call,
        endedAt: at,
        ok,
        resultPreview: preview(text, this.options.previewChars),
      };
      this.toolMap.set(call.id, updated);
      delta.tools.push(updated);
    }
    delta.feed.push({
      kind: 'tool_result',
      id: input.id,
      at,
      toolUseId: block.tool_use_id,
      ok,
      text: preview(text, this.options.previewChars),
    });
  }

  private ingestAssistant(record: AssistantRecord, at: number | null, delta: ThreadDelta): void {
    const message = record.message;
    const when = at ?? 0;
    const synthetic = message.model === SYNTHETIC_MODEL;
    if (!synthetic) {
      this.model = message.model;
      this.effort = record.effort ?? this.effort;
      this.recordRequest(record, when, delta);
    }
    const stop = message.stop_reason ?? null;
    this.turnOpen = stop === null || OPEN_STOP_REASONS.has(stop);
    const id = record.uuid ?? message.id;
    for (const [index, block] of message.content.entries()) {
      this.ingestAssistantBlock(block, { id: `${id}:${String(index)}`, at: when }, delta);
    }
  }

  private ingestAssistantBlock(
    block: ContentBlock,
    where: { readonly id: string; readonly at: number },
    delta: ThreadDelta,
  ): void {
    if (block.type === 'text' && block.text !== '') {
      delta.feed.push({ kind: 'text', id: where.id, at: where.at, text: block.text });
    } else if (block.type === 'thinking' && block.thinking !== '') {
      delta.feed.push({ kind: 'thinking', id: where.id, at: where.at, text: block.thinking });
    } else if (block.type === 'tool_use') {
      const call: ToolCall = {
        id: block.id,
        sessionId: this.options.sessionId,
        agentId: this.options.agentId,
        name: block.name,
        input: block.input,
        startedAt: where.at,
        endedAt: null,
        ok: null,
        resultPreview: null,
      };
      this.toolMap.set(block.id, call);
      this.openTools.set(block.id, block.name);
      delta.tools.push(call);
      delta.feed.push({
        kind: 'tool_use',
        id: where.id,
        at: where.at,
        name: block.name,
        input: block.input,
      });
    }
  }

  private recordRequest(record: AssistantRecord, at: number, delta: ThreadDelta): void {
    const message = record.message;
    const usage = message.usage ?? null;
    const previous = this.requestMap.get(message.id);
    const tokens = usage === null ? (previous?.usage ?? ZERO_USAGE) : usageFromRaw(usage);
    const request: ApiRequest = {
      messageId: message.id,
      requestId: record.requestId ?? previous?.requestId ?? null,
      sessionId: this.options.sessionId,
      agentId: this.options.agentId,
      model: message.model,
      timestamp: previous?.timestamp ?? at,
      usage: tokens,
      ttftMs: null,
      durationMs: null,
      costUsd: estimateCost(message.model, tokens, this.options.prices),
    };
    this.requestMap.set(message.id, request);
    delta.requests.push(request);
  }

  private ingestSystem(record: SystemRecord, at: number | null, delta: ThreadDelta): void {
    const when = at ?? 0;
    const id = record.uuid ?? `system-${String(this.feedItems.length)}`;
    if (record.subtype === 'compact_boundary') {
      this.compactionTimes.push(when);
      delta.compactions.push(when);
      delta.feed.push({ kind: 'system', id, at: when, text: 'Conversation compacted' });
      return;
    }
    if (record.subtype === 'turn_duration') {
      this.turnOpen = false;
      return;
    }
    const text = record.content ?? '';
    if (text !== '') {
      delta.feed.push({ kind: 'system', id, at: when, text });
    }
  }

  private noteNotification(notification: TaskNotification | null, at: number | null): void {
    if (notification !== null) {
      this.notifications.set(notification.toolUseId, { at: at ?? 0, status: notification.status });
    }
  }
}
