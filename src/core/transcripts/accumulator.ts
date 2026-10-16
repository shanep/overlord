// Turns the records of one session (main thread plus subagents) into the
// shared model. Feed it records in file order; ask for snapshots any time.

import type {
  AgentNode,
  ApiRequest,
  ContextSnapshot,
  FeedItem,
  PermissionMode,
  SessionRecap,
  SessionState,
  SessionSummary,
  Surface,
  TokenUsage,
  ToolCall,
} from '../../shared/model.js';
import { ZERO_USAGE } from '../../shared/model.js';

import { ContextTracker } from './context.js';
import type { PriceTable } from './pricing.js';
import { DEFAULT_PRICES } from './pricing.js';
import { parseTimestamp, type TranscriptRecord } from './schemas.js';
import type { SpawnLookup, SubagentMeta } from './subagents.js';
import { buildSubagentNode } from './subagents.js';
import { addUsage, preview } from './text.js';
import type { ThreadDelta } from './thread.js';
import { AgentThread } from './thread.js';

export interface SessionAccumulatorOptions {
  readonly sessionId: string;
  readonly transcriptPath?: string | null;
  readonly prices?: PriceTable;
  /** How long after the last record a session with an open turn still counts as running. */
  readonly runningWindowMs?: number;
  /** Feed items kept per agent. */
  readonly feedLimit?: number;
  /** Characters kept from each tool result. */
  readonly previewChars?: number;
}

const DEFAULT_RUNNING_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_FEED_LIMIT = 2000;
const DEFAULT_PREVIEW_CHARS = 400;
const TITLE_CHARS = 80;

export interface IngestResult extends ThreadDelta {
  readonly agentId: string;
}

const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'manual',
];

function toPermissionMode(value: string | null | undefined): PermissionMode | null {
  return PERMISSION_MODES.find((mode) => mode === value) ?? null;
}

const SURFACES: ReadonlyMap<string, Surface> = new Map([
  ['cli', 'cli'],
  ['sdk-cli', 'sdk'],
  ['sdk-ts', 'sdk'],
  ['sdk-py', 'sdk'],
  ['claude-desktop', 'desktop-code'],
]);

export function surfaceFor(entrypoint: string | null): Surface {
  return entrypoint === null ? 'cli' : (SURFACES.get(entrypoint) ?? 'cli');
}

interface SubagentInfo {
  meta: SubagentMeta | null;
  transcriptPath: string | null;
}

interface SessionFields {
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  entrypoint: string | null;
  permissionMode: PermissionMode | null;
  customTitle: string | null;
  aiTitle: string | null;
  lastPrompt: string | null;
  recap: SessionRecap | null;
}

function firstNonNull<T>(
  threads: readonly AgentThread[],
  pick: (thread: AgentThread) => T | null,
): T | null {
  for (const thread of threads) {
    const value = pick(thread);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/**
 * Sum of the requests we can price. Null only when there are requests and
 * none of them has a known model, so a single odd model does not hide the rest.
 */
export function totalCost(requests: readonly ApiRequest[]): number | null {
  let total = 0;
  let priced = 0;
  for (const request of requests) {
    if (request.costUsd !== null) {
      total += request.costUsd;
      priced += 1;
    }
  }
  return requests.length > 0 && priced === 0 ? null : total;
}

type BaseRecord = Extract<
  TranscriptRecord,
  { type: 'user' | 'assistant' | 'system' | 'attachment' }
>;

const BASE_TYPES: ReadonlySet<string> = new Set(['user', 'assistant', 'system', 'attachment']);

function hasBaseFields(record: TranscriptRecord): record is BaseRecord {
  return BASE_TYPES.has(record.type);
}

// Claude Code ends each recap with a hint that only makes sense in its own terminal.
const RECAP_HINT = '(disable recaps in /config)';

/** The recap in an away_summary record, or null for any other record. */
function recapOf(record: BaseRecord): SessionRecap | null {
  if (record.type !== 'system' || record.subtype !== 'away_summary') {
    return null;
  }
  const full = (record.content ?? '').trim();
  const text = (full.endsWith(RECAP_HINT) ? full.slice(0, -RECAP_HINT.length) : full).trim();
  const at = parseTimestamp(record.timestamp);
  return text === '' || at === null ? null : { text, at };
}

/** Title and mode records carry one field each. Returns true when the record was one of them. */
function applyMarkerRecord(fields: SessionFields, record: TranscriptRecord): boolean {
  if (record.type === 'permission-mode') {
    fields.permissionMode = toPermissionMode(record.permissionMode) ?? fields.permissionMode;
    return true;
  }
  if (record.type === 'ai-title') {
    fields.aiTitle = record.aiTitle;
    return true;
  }
  if (record.type === 'custom-title') {
    fields.customTitle = record.customTitle;
    return true;
  }
  if (record.type === 'last-prompt') {
    fields.lastPrompt = record.lastPrompt === '' ? fields.lastPrompt : record.lastPrompt;
    return true;
  }
  return false;
}

export class SessionAccumulator {
  readonly sessionId: string;
  readonly transcriptPath: string | null;
  private readonly prices: PriceTable;
  private readonly windowMs: number;
  private readonly feedLimit: number;
  private readonly previewChars: number;
  private readonly threads = new Map<string, AgentThread>();
  private readonly subagents = new Map<string, SubagentInfo>();
  private readonly fields: SessionFields = {
    cwd: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    permissionMode: null,
    customTitle: null,
    aiTitle: null,
    lastPrompt: null,
    recap: null,
  };

  constructor(options: SessionAccumulatorOptions) {
    this.sessionId = options.sessionId;
    this.transcriptPath = options.transcriptPath ?? null;
    this.prices = options.prices ?? DEFAULT_PRICES;
    this.windowMs = options.runningWindowMs ?? DEFAULT_RUNNING_WINDOW_MS;
    this.feedLimit = options.feedLimit ?? DEFAULT_FEED_LIMIT;
    this.previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
    this.thread(this.sessionId);
  }

  /** Register a subagent transcript, or update its meta once the file shows up. */
  addSubagent(agentId: string, meta: SubagentMeta | null, transcriptPath: string | null): void {
    this.subagents.set(agentId, { meta, transcriptPath });
    this.thread(agentId);
  }

  hasSubagentMeta(agentId: string): boolean {
    return (this.subagents.get(agentId)?.meta ?? null) !== null;
  }

  /** Consume one record. `agentId` is the thread the record came from; the default is the main thread. */
  ingest(record: TranscriptRecord, agentId: string = this.sessionId): IngestResult {
    if (agentId !== this.sessionId && !this.subagents.has(agentId)) {
      this.subagents.set(agentId, { meta: null, transcriptPath: null });
    }
    if (agentId === this.sessionId) {
      this.ingestSessionFields(record);
    }
    return { agentId, ...this.thread(agentId).ingest(record) };
  }

  /** True while the main thread or any subagent is mid-turn, however long ago it last wrote. */
  busy(): boolean {
    return [...this.threads.values()].some((thread) => thread.busy);
  }

  agentIds(): string[] {
    return [...this.threads.keys()];
  }

  summary(now: number): SessionSummary {
    const main = this.thread(this.sessionId);
    const requests = this.requests();
    let usage: TokenUsage = ZERO_USAGE;
    for (const request of requests) {
      usage = addUsage(usage, request.usage);
    }
    return {
      id: this.sessionId,
      surface: surfaceFor(this.fields.entrypoint),
      title: this.title(),
      cwd: this.fields.cwd ?? '',
      state: this.sessionState(now),
      startedAt: this.earliest(),
      updatedAt: this.latest(),
      usage,
      costUsd: totalCost(requests),
      model: main.model ?? main.context.snapshot(this.ids(this.sessionId), null).model,
      effort: main.effort,
      permissionMode: this.fields.permissionMode,
      pid: null,
      transcriptPath: this.transcriptPath,
      gitBranch: this.fields.gitBranch,
      version: this.fields.version,
      agentCount: this.subagents.size,
      contextFill: null,
      recap: this.fields.recap,
      lastPrompt: this.fields.lastPrompt,
      lastPromptAt: main.lastPromptAt,
    };
  }

  /** The main thread first, then subagents in the order they were seen. */
  agents(now: number): AgentNode[] {
    const main = this.thread(this.sessionId);
    const nodes: AgentNode[] = [
      {
        id: this.sessionId,
        sessionId: this.sessionId,
        parentAgentId: null,
        parentToolUseId: null,
        agentType: 'main',
        description: this.title(),
        spawnDepth: 0,
        background: false,
        state: main.state(now, this.windowMs),
        startedAt: main.firstAt ?? 0,
        endedAt: null,
        transcriptPath: this.transcriptPath,
        usage: main.usage(),
        toolCallCount: main.toolCalls().length,
        currentTool: main.currentTool(),
        model: main.model,
      },
    ];
    for (const [agentId, info] of this.subagents) {
      const thread = this.thread(agentId);
      const activity = {
        agentId,
        sessionId: this.sessionId,
        transcriptPath: info.transcriptPath,
        startedAt: thread.firstAt ?? 0,
        liveState: thread.state(now, this.windowMs),
        usage: thread.usage(),
        toolCallCount: thread.toolCalls().length,
        currentTool: thread.currentTool(),
        model: thread.model,
      };
      nodes.push(buildSubagentNode(activity, info.meta, this.lookup()));
    }
    return nodes;
  }

  toolCalls(agentId?: string): ToolCall[] {
    return this.collect(agentId, (thread) => thread.toolCalls());
  }

  /** One entry per API call, deduplicated by message id. */
  requests(agentId?: string): ApiRequest[] {
    return this.collect(agentId, (thread) => thread.requests());
  }

  feed(agentId: string, limit: number = this.feedLimit): FeedItem[] {
    return this.threads.get(agentId)?.feed(limit) ?? [];
  }

  compactions(agentId: string = this.sessionId): number[] {
    return this.threads.get(agentId)?.compactions() ?? [];
  }

  /** What the transcript shows about this agent's context. An unknown agent gives an empty snapshot. */
  observedContext(agentId: string = this.sessionId): ContextSnapshot {
    const thread = this.threads.get(agentId);
    const context = thread?.context ?? new ContextTracker();
    return context.snapshot(this.ids(agentId), thread?.model ?? null);
  }

  private ids(agentId: string): { sessionId: string; agentId: string } {
    return { sessionId: this.sessionId, agentId };
  }

  private thread(agentId: string): AgentThread {
    const existing = this.threads.get(agentId);
    if (existing !== undefined) {
      return existing;
    }
    const created = new AgentThread({
      sessionId: this.sessionId,
      agentId,
      prices: this.prices,
      feedLimit: this.feedLimit,
      previewChars: this.previewChars,
    });
    this.threads.set(agentId, created);
    return created;
  }

  private collect<T>(agentId: string | undefined, pick: (thread: AgentThread) => T[]): T[] {
    if (agentId !== undefined) {
      const thread = this.threads.get(agentId);
      return thread === undefined ? [] : pick(thread);
    }
    return [...this.threads.values()].flatMap((thread) => pick(thread));
  }

  private ingestSessionFields(record: TranscriptRecord): void {
    if (applyMarkerRecord(this.fields, record) || !hasBaseFields(record)) {
      return;
    }
    const fields = this.fields;
    if (record.type === 'user') {
      fields.permissionMode = toPermissionMode(record.permissionMode) ?? fields.permissionMode;
    }
    fields.recap = recapOf(record) ?? fields.recap;
    fields.cwd ??= record.cwd ?? null;
    fields.gitBranch = record.gitBranch ?? fields.gitBranch;
    fields.version = record.version ?? fields.version;
    fields.entrypoint = record.entrypoint ?? fields.entrypoint;
  }

  private title(): string {
    const fields = this.fields;
    const fallback = this.thread(this.sessionId).firstPrompt ?? fields.lastPrompt ?? '';
    const title = fields.customTitle ?? fields.aiTitle ?? fallback;
    return preview(title.replaceAll(/\s+/gu, ' ').trim(), TITLE_CHARS);
  }

  private sessionState(now: number): SessionState {
    const running = this.agents(now).some((agent) => agent.state === 'running');
    return running ? 'running' : this.thread(this.sessionId).state(now, this.windowMs);
  }

  private earliest(): number {
    let first: number | null = null;
    for (const thread of this.threads.values()) {
      if (thread.firstAt !== null && (first === null || thread.firstAt < first)) {
        first = thread.firstAt;
      }
    }
    return first ?? 0;
  }

  private latest(): number {
    let last = 0;
    for (const thread of this.threads.values()) {
      last = Math.max(last, thread.lastAt ?? 0);
    }
    return last;
  }

  private lookup(): SpawnLookup {
    const threads = [...this.threads.values()];
    return {
      ownerOf: (toolUseId) =>
        threads.find((thread) => thread.hasToolUse(toolUseId))?.agentId ?? null,
      resultOf: (toolUseId) => firstNonNull(threads, (thread) => thread.outcome(toolUseId)),
      notificationOf: (toolUseId) =>
        firstNonNull(threads, (thread) => thread.notification(toolUseId)),
    };
  }
}
