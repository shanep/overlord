// Folds one Copilot CLI session's events.jsonl into the shared model. The
// main agent and its subagents share the file, and a subagent's events name
// it in agentId. ledger.ts has how tokens and cost add up.
// cspell:words Aiu

import { stat } from 'node:fs/promises';

import { COPILOT } from '../../../shared/agents.js';
import type {
  AgentNode,
  ApiRequest,
  FeedItem,
  SessionState,
  SessionSummary,
  ToolCall,
} from '../../../shared/model.js';
import { preview } from '../../transcripts/text.js';
import type { RecordAccumulator, RecordDelta, TailedFile } from '../types.js';

import type { Envelope } from './events.js';
import {
  assistantMessageSchema,
  assistantUsageSchema,
  checkpointSchema,
  compactionSchema,
  parseEnvelope,
  parseTime,
  requestIdSchema,
  shutdownSchema,
  subagentEndSchema,
  subagentStartSchema,
  toolCompleteSchema,
  toolStartSchema,
  usageInfoSchema,
  userMessageSchema,
} from './events.js';
import { CallLedger, shutdownBuckets } from './ledger.js';
import { ContextGauge } from './models.js';
import { quotaLimits } from './quota.js';
import { SESSION_FIELD_EVENTS, SessionFields } from './session-fields.js';
import { ThreadSet } from './thread-set.js';
import type { Thread, ToolContext } from './threads.js';
import {
  endSubagent,
  finishTool,
  messageItems,
  pushFeed,
  startTool,
  threadState,
} from './threads.js';
import type { Workspace } from './workspace.js';
import { readWorkspace } from './workspace.js';

export interface CopilotRecordsOptions {
  readonly sessionId: string;
  readonly transcriptPath: string | null;
  /** The session's workspace.yaml, read for its name. Null leaves it out. */
  readonly workspacePath?: string | null;
  /** How long after the last event a session with an open turn still counts as running. */
  readonly runningWindowMs?: number;
  /** Feed items kept per thread. */
  readonly feedLimit?: number;
  /** Characters kept from each tool result. */
  readonly previewChars?: number;
}

const DEFAULT_RUNNING_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_FEED_LIMIT = 2000;
const DEFAULT_PREVIEW_CHARS = 400;
const TITLE_CHARS = 80;

/** The ephemeral events worth reading when a stream or a later version writes them to the file. */
const USEFUL_EPHEMERAL: ReadonlySet<string> = new Set([
  'assistant.usage',
  'session.idle',
  'session.title_changed',
  'session.usage_info',
]);

interface Delta extends Pick<RecordDelta, 'rateLimits'> {
  tools: ToolCall[];
  requests: ApiRequest[];
  feed: FeedItem[];
  contextChanged: boolean;
  compactions: number[];
}

function delta(parts: Partial<Delta> = {}): Delta {
  return { tools: [], requests: [], feed: [], contextChanged: false, compactions: [], ...parts };
}

type Handler = (event: Envelope, thread: Thread, at: number) => Delta | null;

export class CopilotRecords implements RecordAccumulator {
  readonly sessionId: string;
  readonly transcriptPath: string | null;
  private readonly workspacePath: string | null;
  private readonly windowMs: number;
  private readonly feedLimit: number;
  private readonly previewChars: number;
  private readonly threads: ThreadSet;
  private readonly ledger: CallLedger;
  private readonly fields = new SessionFields();
  private readonly pending = new Set<string>();
  private readonly handlers: Readonly<Record<string, Handler>>;
  private workspace: Workspace | null = null;
  private workspaceMtime = -1;
  private firstPrompt: string | null = null;
  private lastPrompt: string | null = null;
  private lastPromptAt: number | null = null;
  private ended: 'done' | 'failed' | null = null;
  private readonly context = new ContextGauge();

  constructor(options: CopilotRecordsOptions) {
    this.sessionId = options.sessionId;
    this.transcriptPath = options.transcriptPath;
    this.workspacePath = options.workspacePath ?? null;
    this.windowMs = options.runningWindowMs ?? DEFAULT_RUNNING_WINDOW_MS;
    this.feedLimit = options.feedLimit ?? DEFAULT_FEED_LIMIT;
    this.previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
    this.ledger = new CallLedger(this.sessionId);
    this.threads = new ThreadSet(this.sessionId);
    this.handlers = this.makeHandlers();
  }

  /** Picks up the session's name from workspace.yaml whenever the file changes. */
  async prepare(file: TailedFile): Promise<void> {
    if (this.workspacePath === null || file.agentId !== this.sessionId) {
      return;
    }
    let mtime: number;
    try {
      const info = await stat(this.workspacePath);
      mtime = info.mtimeMs;
    } catch {
      return;
    }
    if (mtime !== this.workspaceMtime) {
      this.workspaceMtime = mtime;
      this.workspace = (await readWorkspace(this.workspacePath)) ?? this.workspace;
    }
  }

  ingest(line: string, agentId: string): RecordDelta | null {
    const event = parseEnvelope(line);
    if (event === null || (event.ephemeral === true && !USEFUL_EPHEMERAL.has(event.type))) {
      return null;
    }
    const at = parseTime(event.timestamp);
    if (at === null) {
      return null;
    }
    const thread = this.threads.resolve(event, agentId);
    thread.firstAt ??= at;
    thread.lastAt = Math.max(thread.lastAt ?? at, at);
    const handler = this.handlers[event.type];
    const result = handler === undefined ? null : handler(event, thread, at);
    return result === null ? null : { agentId: thread.id, ...result };
  }

  busy(): boolean {
    if (this.ended !== null) {
      return false;
    }
    return this.pending.size > 0 || this.threads.anyOpen();
  }

  summary(now: number): SessionSummary {
    const fields = this.fields;
    return {
      id: this.sessionId,
      agent: COPILOT,
      surface: 'cli',
      title: this.title(),
      cwd: fields.cwd ?? this.workspace?.cwd ?? '',
      state: this.sessionState(now),
      startedAt: this.threads.edge('first'),
      updatedAt: this.threads.edge('last'),
      usage: this.ledger.usage(),
      costUsd: this.ledger.cost(),
      model: fields.model ?? this.threads.main().model,
      effort: fields.effort,
      permissionMode: fields.mode,
      pid: null,
      transcriptPath: this.transcriptPath,
      gitBranch: fields.gitBranch ?? this.workspace?.branch ?? null,
      version: fields.version,
      agentCount: this.threads.subagentCount,
      contextFill: this.context.fill(fields.model),
      recap: null,
      lastPrompt: this.lastPrompt,
      lastPromptAt: this.lastPromptAt,
    };
  }

  /** The main thread first, then subagents in the order they started. */
  agents(now: number): AgentNode[] {
    return this.threads.list().map((thread) => this.node(thread, now));
  }

  toolCalls(agentId?: string): ToolCall[] {
    return this.threads
      .list()
      .filter((thread) => agentId === undefined || thread.id === agentId)
      .flatMap((thread) => [...thread.tools.values()]);
  }

  requests(agentId?: string): ApiRequest[] {
    return this.ledger.requests(agentId);
  }

  feed(agentId: string): FeedItem[] {
    return [...(this.threads.get(agentId)?.feed ?? [])];
  }

  private makeHandlers(): Record<string, Handler> {
    const fields: Handler = (event) => {
      this.fields.apply(event);
      if (event.type === 'session.start' || event.type === 'session.resume') {
        this.ended = null;
      }
      return delta();
    };
    const close: Handler = () => {
      this.threads.closeTurns('all');
      return delta();
    };
    const handlers: Record<string, Handler> = {
      'user.message': (event, thread, at) => this.onUserMessage(event, thread, at),
      'assistant.turn_start': (_event, thread) => {
        thread.open = true;
        return delta();
      },
      'assistant.message': (event, thread, at) => this.onAssistantMessage(event, thread, at),
      'assistant.usage': (event, thread) => this.onAssistantUsage(event, thread),
      'assistant.turn_end': (_event, thread) => {
        thread.open = thread.wantsTools;
        return delta();
      },
      abort: close,
      'session.idle': close,
      'tool.execution_start': (event, thread, at) => this.onToolStart(event, thread, at),
      'tool.user_requested': (event, thread, at) => this.onToolStart(event, thread, at),
      'tool.execution_complete': (event, thread, at) => this.onToolComplete(event, thread, at),
      'permission.requested': (event) => this.onPermission(event),
      'permission.completed': (event) => this.onPermission(event),
      'session.usage_checkpoint': (event, _thread, at) => this.onCheckpoint(event, at),
      'session.shutdown': (event, _thread, at) => this.onShutdown(event, at),
      'session.usage_info': (event) => this.onUsageInfo(event),
      'model.model_call_success': (event, _thread, at) => delta(quotaLimits(event.data, at)),
      'session.compaction_complete': (event, _thread, at) => {
        const parsed = compactionSchema.safeParse(event.data);
        return delta({ compactions: parsed.success && parsed.data.success ? [at] : [] });
      },
      'subagent.started': (event, thread, at) => this.onSubagentStart(event, thread, at),
      'subagent.completed': (event, _thread, at) => this.onSubagentEnd(event, at),
      'subagent.failed': (event, _thread, at) => this.onSubagentEnd(event, at),
    };
    for (const type of SESSION_FIELD_EVENTS) {
      handlers[type] = fields;
    }
    return handlers;
  }

  private onUserMessage(event: Envelope, thread: Thread, at: number): Delta | null {
    const parsed = userMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      return null;
    }
    const text = parsed.data.content;
    thread.open = true;
    thread.wantsTools = false;
    if (thread.id === this.sessionId) {
      this.ended = null;
      this.firstPrompt ??= text;
      this.lastPrompt = text;
      this.lastPromptAt = at;
    }
    const id = parsed.data.messageId ?? event.id ?? `user:${String(at)}`;
    return delta({ feed: pushFeed(thread, [{ kind: 'user', id, at, text }], this.feedLimit) });
  }

  private onAssistantMessage(event: Envelope, thread: Thread, at: number): Delta | null {
    const parsed = assistantMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      return null;
    }
    const data = parsed.data;
    thread.model = data.model ?? thread.model;
    const items = messageItems(thread, data, at);
    thread.wantsTools = items.some((item) => item.kind === 'tool_use');
    const request = this.ledger.recordMessage({
      messageId: data.messageId,
      apiCallId: data.apiCallId,
      agentId: thread.id,
      model: thread.model ?? this.fields.model,
      outputTokens: data.outputTokens,
      at,
    });
    return delta({ feed: pushFeed(thread, items, this.feedLimit), requests: [request] });
  }

  private onAssistantUsage(event: Envelope, thread: Thread): Delta | null {
    const parsed = assistantUsageSchema.safeParse(event.data);
    if (!parsed.success) {
      return null;
    }
    const request = this.ledger.applyUsage(parsed.data, thread.id);
    return delta({ requests: request === null ? [] : [request] });
  }

  private onToolStart(event: Envelope, thread: Thread, at: number): Delta | null {
    const parsed = toolStartSchema.safeParse(event.data);
    if (!parsed.success) {
      return null;
    }
    const { tool, items } = startTool(thread, parsed.data, this.toolContext(at));
    return delta({ tools: [tool], feed: pushFeed(thread, items, this.feedLimit) });
  }

  private onToolComplete(event: Envelope, thread: Thread, at: number): Delta | null {
    const parsed = toolCompleteSchema.safeParse(event.data);
    if (!parsed.success) {
      return null;
    }
    const { tool, item } = finishTool(thread, parsed.data, this.toolContext(at));
    return delta({ tools: [tool], feed: pushFeed(thread, [item], this.feedLimit) });
  }

  private toolContext(at: number): ToolContext {
    return { sessionId: this.sessionId, at, previewChars: this.previewChars };
  }

  /** Only permission prompts persist in 1.0.89, so they are what makes a session wait. */
  private onPermission(event: Envelope): Delta | null {
    const parsed = requestIdSchema.safeParse(event.data);
    if (!parsed.success) {
      return null;
    }
    if (event.type === 'permission.requested') {
      this.pending.add(parsed.data.requestId);
    } else {
      this.pending.delete(parsed.data.requestId);
    }
    return delta();
  }

  private onCheckpoint(event: Envelope, at: number): Delta | null {
    const parsed = checkpointSchema.safeParse(event.data);
    if (!parsed.success) {
      return null;
    }
    this.threads.closeTurns('main');
    const total = parsed.data.totalNanoAiu ?? null;
    return delta({ requests: this.ledger.settle([], total, at, this.fields.model) });
  }

  private onShutdown(event: Envelope, at: number): Delta | null {
    const parsed = shutdownSchema.safeParse(event.data);
    if (!parsed.success) {
      return null;
    }
    const data = parsed.data;
    const buckets = shutdownBuckets(data, (key) => this.threads.forMetrics(key));
    const model = data.currentModel ?? this.fields.model;
    const requests = this.ledger.settle(buckets, data.totalNanoAiu ?? null, at, model);
    this.threads.endAll(at);
    this.pending.clear();
    this.ended = data.shutdownType === 'error' ? 'failed' : 'done';
    this.context.closed(data.currentTokens, data.currentModel);
    return delta({ requests });
  }

  private onUsageInfo(event: Envelope): Delta | null {
    const parsed = usageInfoSchema.safeParse(event.data);
    if (!parsed.success) {
      return null;
    }
    this.context.measured(parsed.data.currentTokens, parsed.data.tokenLimit);
    return delta();
  }

  /** subagent.started comes from the agent that spawned it, so that thread is the parent. */
  private onSubagentStart(event: Envelope, parent: Thread, at: number): Delta | null {
    const parsed = subagentStartSchema.safeParse(event.data);
    if (!parsed.success) {
      return null;
    }
    this.threads.start(parent, parsed.data, at);
    return delta();
  }

  private onSubagentEnd(event: Envelope, at: number): Delta | null {
    const parsed = subagentEndSchema.safeParse(event.data);
    if (!parsed.success) {
      return null;
    }
    const thread = this.threads.get(parsed.data.toolCallId);
    if (thread === undefined) {
      return null;
    }
    endSubagent(thread, parsed.data, event.type === 'subagent.failed', at);
    return delta();
  }

  private title(): string {
    const workspace = this.workspace;
    const named = workspace?.userNamed === true ? workspace.name : null;
    const title = named ?? this.fields.title ?? this.firstPrompt ?? workspace?.name ?? '';
    return preview(title.replaceAll(/\s+/gu, ' ').trim(), TITLE_CHARS);
  }

  private sessionState(now: number): SessionState {
    if (this.ended !== null) {
      return this.ended;
    }
    if (this.pending.size > 0) {
      return 'waiting';
    }
    const states = this.threads.list().map((thread) => threadState(thread, now, this.windowMs));
    return states.includes('running')
      ? 'running'
      : threadState(this.threads.main(), now, this.windowMs);
  }

  private node(thread: Thread, now: number): AgentNode {
    const isMain = thread.id === this.sessionId;
    const tools = [...thread.tools.values()];
    return {
      id: thread.id,
      sessionId: this.sessionId,
      parentAgentId: thread.parentAgentId,
      parentToolUseId: thread.parentToolUseId,
      agentType: thread.agentType,
      description: isMain ? this.title() : thread.description,
      spawnDepth: thread.spawnDepth,
      background: thread.background,
      state: isMain ? this.sessionState(now) : threadState(thread, now, this.windowMs),
      startedAt: thread.firstAt ?? 0,
      endedAt: thread.endedAt,
      transcriptPath: this.transcriptPath,
      usage: this.ledger.usage(thread.id),
      toolCallCount: tools.length,
      currentTool: tools.findLast((tool) => tool.endedAt === null)?.name ?? null,
      model: thread.model ?? (isMain ? this.fields.model : null),
    };
  }
}
