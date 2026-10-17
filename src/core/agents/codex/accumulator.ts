// Folds one Codex rollout file into the shared model. Codex runs every tool
// through one "exec" tool that takes JavaScript, so the real command or edit
// comes from the CommandExecution and FileChange items Codex logs as it runs
// them. Usage is written twice per model call (token_usage_record and
// token_count), so only token_usage_record counts, once per response id.
// cspell:words rollouts

import { CODEX } from '../../../shared/agents.js';
import type {
  AgentNode,
  ApiRequest,
  FeedItem,
  SessionSummary,
  TokenUsage,
  ToolCall,
} from '../../../shared/model.js';
import { promptTokens, ZERO_USAGE } from '../../../shared/model.js';
import { plainText } from '../../../shared/plain-text.js';
import { addUsage, preview } from '../../transcripts/text.js';
import type { RecordAccumulator, RecordDelta } from '../types.js';

import { permissionModeId } from './capabilities.js';
import type { RateLimitWindow, SessionFields, ToolRun } from './convert.js';
import {
  emptyFields,
  itemTool,
  rateLimitWindows,
  scriptTool,
  toolEvents,
  toTokenUsage,
  versionNote,
} from './convert.js';
import { rememberWindow } from './models.js';
import type { CodexRecord, ContentRecord, SettingsRecord, TurnRecord } from './records.js';
import { parseRolloutLine, partsText, TESTED_CODEX_VERSIONS } from './records.js';

export interface CodexRecordsOptions {
  readonly sessionId: string;
  readonly transcriptPath?: string | null;
  /** How long after the last record a session with an open turn still counts as running. */
  readonly runningWindowMs?: number;
  /** Characters kept from each tool result. */
  readonly previewChars?: number;
}

const DEFAULT_RUNNING_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_PREVIEW_CHARS = 400;
const TITLE_CHARS = 80;
const PROMPT_CHARS = 200;

type RecordOf<K extends CodexRecord['kind']> = Extract<CodexRecord, { kind: K }>;

interface OpenCall {
  readonly callId: string;
  readonly script: string;
  readonly at: number;
  /** True once Codex logged a command or edit while this call ran. */
  ran: boolean;
}

interface Delta {
  readonly agentId: string;
  readonly tools: ToolCall[];
  readonly requests: ApiRequest[];
  readonly feed: FeedItem[];
  readonly contextChanged: boolean;
  readonly compactions: number[];
}

/** Reads a Codex rollout line by line. Codex keeps no subagent files, so every record is the main thread's. */
export class CodexRecords implements RecordAccumulator {
  private readonly sessionId: string;
  private readonly transcriptPath: string | null;
  private readonly windowMs: number;
  private readonly previewChars: number;
  private readonly fields: SessionFields = emptyFields();
  private readonly requestMap = new Map<string, ApiRequest>();
  private readonly toolMap = new Map<string, ToolCall>();
  private readonly openCalls: OpenCall[] = [];
  private limits: readonly RateLimitWindow[] = [];
  private turnOpen = false;
  private firstAt: number | null = null;
  private lastAt: number | null = null;
  private warnedVersion = false;

  constructor(options: CodexRecordsOptions) {
    this.sessionId = options.sessionId;
    this.transcriptPath = options.transcriptPath ?? null;
    this.windowMs = options.runningWindowMs ?? DEFAULT_RUNNING_WINDOW_MS;
    this.previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
  }

  ingest(line: string, agentId: string): RecordDelta | null {
    const record = parseRolloutLine(line);
    if (record === null) {
      return null;
    }
    if (record.at !== null) {
      this.firstAt ??= record.at;
      this.lastAt = Math.max(this.lastAt ?? record.at, record.at);
    }
    const delta: Delta = {
      agentId,
      tools: [],
      requests: [],
      feed: [],
      contextChanged: false,
      compactions: [],
    };
    const at = record.at ?? this.lastAt ?? 0;
    switch (record.group) {
      case 'settings': {
        this.applySettings(record, at, delta);
        break;
      }
      case 'turn': {
        this.applyTurn(record, at, delta);
        break;
      }
      case 'content': {
        this.applyContent(record, at, delta);
        break;
      }
      case 'other': {
        break;
      }
    }
    return delta;
  }

  /** Who, where and how: the session's folder, model, effort and permissions. */
  private applySettings(record: SettingsRecord, at: number, delta: Delta): void {
    switch (record.kind) {
      case 'session_meta': {
        this.applyMeta(record, at, delta);
        break;
      }
      case 'turn_context': {
        this.applyContext(record);
        break;
      }
      case 'thread_settings': {
        const { settings } = record;
        this.fields.model = settings.model ?? this.fields.model;
        this.fields.effort = settings.reasoning_effort ?? this.fields.effort;
        this.fields.approval = settings.approval_policy ?? this.fields.approval;
        break;
      }
      case 'token_count': {
        this.setWindow(record.tokens.info?.model_context_window ?? null);
        const limits = record.tokens.rate_limits;
        this.limits = limits === null ? this.limits : rateLimitWindows(limits);
        break;
      }
    }
  }

  private applyContext({ context }: RecordOf<'turn_context'>): void {
    this.fields.cwd ??= context.cwd;
    this.fields.model = context.model ?? this.fields.model;
    this.fields.effort = context.effort ?? this.fields.effort;
    this.fields.approval = context.approval_policy ?? this.fields.approval;
    this.fields.sandbox = context.sandbox_policy?.type ?? this.fields.sandbox;
  }

  /** Turns opening and closing, the calls in them, and errors Codex reports. */
  private applyTurn(record: TurnRecord, at: number, delta: Delta): void {
    switch (record.kind) {
      case 'task_started': {
        this.turnOpen = true;
        this.setWindow(record.started.model_context_window);
        break;
      }
      case 'task_complete': {
        this.endTurn();
        break;
      }
      case 'turn_aborted': {
        this.endTurn();
        const reason = record.reason === null ? '' : ` (${record.reason})`;
        delta.feed.push({
          kind: 'system',
          id: `aborted:${String(at)}`,
          at,
          text: `Turn stopped${reason}`,
        });
        break;
      }
      case 'usage': {
        this.applyUsage(record, at, delta);
        break;
      }
      case 'error': {
        delta.feed.push({
          kind: 'system',
          id: `error:${String(at)}`,
          at,
          text: plainText(record.message),
        });
        break;
      }
    }
  }

  /** What was said and done: messages, reasoning, commands and edits. */
  private applyContent(record: ContentRecord, at: number, delta: Delta): void {
    switch (record.kind) {
      case 'item': {
        this.applyItem(record, at, delta);
        break;
      }
      case 'tool_call': {
        this.openCalls.push({
          callId: record.call.call_id,
          script: record.call.input,
          at,
          ran: false,
        });
        break;
      }
      case 'tool_output': {
        this.applyOutput(record, at, delta);
        break;
      }
      case 'reasoning': {
        const text = partsText(record.reasoning.summary).trim();
        if (text !== '') {
          const id = record.reasoning.id ?? `reasoning:${String(at)}`;
          delta.feed.push({ kind: 'thinking', id, at, text });
        }
        break;
      }
    }
  }

  private endTurn(): void {
    this.turnOpen = false;
    this.openCalls.length = 0;
  }

  private applyMeta({ meta }: RecordOf<'session_meta'>, at: number, delta: Delta): void {
    this.fields.cwd = meta.cwd ?? this.fields.cwd;
    this.fields.gitBranch = meta.git?.branch ?? this.fields.gitBranch;
    this.fields.version = meta.cli_version ?? this.fields.version;
    const started = Date.parse(meta.timestamp ?? '');
    this.fields.startedAt ??= Number.isNaN(started) ? at : started;
    if (!this.warnedVersion && !this.formatVerified() && this.fields.version !== null) {
      this.warnedVersion = true;
      delta.feed.push(versionNote(this.fields.version, at));
    }
  }

  private setWindow(tokens: number | null): void {
    if (tokens === null || tokens <= 0) {
      return;
    }
    this.fields.contextWindow = tokens;
    if (this.fields.model !== null) {
      rememberWindow(this.fields.model, tokens);
    }
  }

  private applyUsage({ record }: RecordOf<'usage'>, at: number, delta: Delta): void {
    if (this.requestMap.has(record.response_id)) {
      return;
    }
    const request: ApiRequest = {
      messageId: record.response_id,
      requestId: null,
      sessionId: this.sessionId,
      agentId: this.sessionId,
      model: this.fields.model ?? 'unknown',
      timestamp: at,
      usage: toTokenUsage(record.usage),
      ttftMs: null,
      durationMs: null,
      costUsd: null,
    };
    this.requestMap.set(request.messageId, request);
    delta.requests.push(request);
  }

  private applyItem({ completed }: RecordOf<'item'>, at: number, delta: Delta): void {
    const { item } = completed;
    const endedAt = completed.completed_at_ms ?? at;
    const text = partsText(item.content);
    if (item.type === 'UserMessage') {
      this.applyPrompt(item.id, plainText(text).trim(), endedAt, delta);
      return;
    }
    if (item.type === 'AgentMessage' && text.trim() !== '') {
      delta.feed.push({ kind: 'text', id: item.id, at: endedAt, text });
      return;
    }
    const tool = itemTool(item);
    if (tool !== null) {
      const open = this.openCalls.at(-1);
      if (open !== undefined) {
        open.ran = true;
      }
      const startedAt = completed.started_at_ms ?? endedAt;
      this.pushTool(delta, { ...tool, id: item.id, startedAt, endedAt });
    }
  }

  private applyPrompt(id: string, text: string, at: number, delta: Delta): void {
    if (text === '') {
      return;
    }
    this.fields.title ??= preview(text.replaceAll(/\s+/gu, ' '), TITLE_CHARS);
    this.fields.lastPrompt = preview(text, PROMPT_CHARS);
    this.fields.lastPromptAt = at;
    delta.feed.push({ kind: 'user', id, at, text });
  }

  /** A call that ran no command or edit, like a declined approval, shows as the call itself. */
  private applyOutput({ output }: RecordOf<'tool_output'>, at: number, delta: Delta): void {
    const index = this.openCalls.findIndex((call) => call.callId === output.call_id);
    const [open] = index === -1 ? [] : this.openCalls.splice(index, 1);
    if (open === undefined || open.ran) {
      return;
    }
    const tool = scriptTool(open.script, output.output);
    this.pushTool(delta, { ...tool, id: open.callId, startedAt: open.at, endedAt: at });
  }

  private pushTool(delta: Delta, tool: ToolRun): void {
    const { call, feed } = toolEvents(this.sessionId, tool, this.previewChars);
    this.toolMap.set(call.id, call);
    delta.tools.push(call);
    delta.feed.push(...feed);
  }

  /** True between a turn's task_started and its task_complete or turn_aborted. */
  busy(): boolean {
    return this.turnOpen;
  }

  /** The newest rate limit windows the rollout reported, primary first. */
  rateLimits(): readonly RateLimitWindow[] {
    return this.limits;
  }

  /** False when a Codex version Overlord has not checked wrote the file. */
  formatVerified(): boolean {
    return this.fields.version === null || TESTED_CODEX_VERSIONS.includes(this.fields.version);
  }

  requests(): ApiRequest[] {
    return [...this.requestMap.values()];
  }

  private usage(): TokenUsage {
    let total = ZERO_USAGE;
    for (const request of this.requestMap.values()) {
      total = addUsage(total, request.usage);
    }
    return total;
  }

  private state(now: number): SessionSummary['state'] {
    if (this.lastAt === null) {
      return 'unknown';
    }
    return this.turnOpen && now - this.lastAt <= this.windowMs ? 'running' : 'idle';
  }

  private contextFill(): number | null {
    const latest = this.requests().at(-1);
    const window = this.fields.contextWindow;
    return latest === undefined || window === null ? null : promptTokens(latest.usage) / window;
  }

  private permissionMode(): string | null {
    const { approval, sandbox } = this.fields;
    return approval === null || sandbox === null ? null : permissionModeId(approval, sandbox);
  }

  summary(now: number): SessionSummary {
    return {
      id: this.sessionId,
      agent: CODEX,
      surface: 'cli',
      title: this.fields.title ?? '',
      cwd: this.fields.cwd ?? '',
      state: this.state(now),
      startedAt: this.fields.startedAt ?? this.firstAt ?? 0,
      updatedAt: this.lastAt ?? 0,
      usage: this.usage(),
      costUsd: null,
      model: this.fields.model,
      effort: this.fields.effort,
      permissionMode: this.permissionMode(),
      pid: null,
      transcriptPath: this.transcriptPath,
      gitBranch: this.fields.gitBranch,
      version: this.fields.version,
      agentCount: 0,
      contextFill: this.contextFill(),
      recap: null,
      lastPrompt: this.fields.lastPrompt,
      lastPromptAt: this.fields.lastPromptAt,
    };
  }

  agents(now: number): AgentNode[] {
    return [
      {
        id: this.sessionId,
        sessionId: this.sessionId,
        parentAgentId: null,
        parentToolUseId: null,
        agentType: 'main',
        description: this.fields.title ?? '',
        spawnDepth: 0,
        background: false,
        state: this.state(now),
        startedAt: this.fields.startedAt ?? this.firstAt ?? 0,
        endedAt: null,
        transcriptPath: this.transcriptPath,
        usage: this.usage(),
        toolCallCount: this.toolMap.size,
        // Codex logs a command only once it finishes, so nothing shows as running.
        currentTool: null,
        model: this.fields.model,
      },
    ];
  }
}
