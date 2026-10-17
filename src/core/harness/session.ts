// One Claude Code session run through the Agent SDK in streaming input mode.
// The prompt is an async queue, so follow-ups, interrupts and live model or
// mode changes all go to the same process. Every SDK message is mapped to
// Overlord events and published on the bus.

import { randomUUID } from 'node:crypto';

import { CLAUDE_CODE } from '../../shared/agents.js';
import type {
  AgentNode,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  SessionSummary,
} from '../../shared/model.js';
import type { EventBus } from '../bus.js';

import { errorMessage, type EndReason, type SessionEvent, type SessionInfo } from './events.js';
import type { PermissionBroker } from './inbox.js';
import { AsyncQueue } from './input-queue.js';
import { MessageMapper } from './mapper.js';
import { parseContextUsage, type ContextUsage } from './messages.js';
import { toSdkPermissionMode } from './options.js';
import type {
  EffortLevel,
  QueryFunction,
  SessionQuery,
  ToolPermissionContext,
  ToolPermissionResult,
  UserInput,
} from './sdk-types.js';

export interface SessionDeps {
  readonly queryFunction: QueryFunction;
  readonly bus: EventBus;
  readonly broker: PermissionBroker;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export interface SessionConfig {
  readonly cwd: string;
  readonly title: string;
  readonly model: string | null;
  readonly effort: EffortLevel | null;
  readonly permissionMode: PermissionMode | null;
  /** The full child environment (already merged onto process.env). */
  readonly env: Readonly<Record<string, string>>;
  readonly extraArgs: Readonly<Record<string, string | null>>;
  readonly maxBudgetUsd: number | null;
  readonly executablePath: string | null;
  /** Runs the session as plain chat with this system prompt. See QueryOptions. */
  readonly chatPrompt?: string | null | undefined;
  /** A UUID for the Claude session. One is generated when omitted. */
  readonly sessionId?: string | undefined;
}

export interface SessionEnd {
  readonly reason: EndReason;
  readonly error: string | null;
}

export type SessionListener = (event: SessionEvent) => void;

export function toPermissionResult(
  decision: PermissionDecision,
  input: Record<string, unknown>,
): ToolPermissionResult {
  return decision.behavior === 'allow'
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: decision.message };
}

function endReason(stopped: boolean, error: string | null): EndReason {
  if (stopped) {
    return 'stopped';
  }
  return error === null ? 'completed' : 'failed';
}

export class SdkSession {
  readonly id: string;
  private readonly deps: SessionDeps;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly mapper: MessageMapper;
  private readonly input = new AsyncQueue<UserInput>();
  private readonly abort = new AbortController();
  private readonly permissionAbort = new AbortController();
  private readonly query: SessionQuery;
  private readonly listeners = new Set<SessionListener>();
  private openPrompts = 0;
  private stopped = false;
  private run: Promise<SessionEnd> | null = null;

  /** Creates the session and starts reading the SDK stream. */
  static start(deps: SessionDeps, config: SessionConfig): SdkSession {
    const session = new SdkSession(deps, config);
    session.publish(session.mapper.started());
    void session.finished;
    return session;
  }

  private constructor(deps: SessionDeps, config: SessionConfig) {
    this.deps = deps;
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.id = config.sessionId ?? randomUUID();
    this.mapper = new MessageMapper({
      sessionId: this.id,
      cwd: config.cwd,
      title: config.title,
      model: config.model,
      effort: config.effort,
      permissionMode: config.permissionMode,
      now: this.now,
    });
    this.query = deps.queryFunction(this.input, {
      cwd: config.cwd,
      sessionId: this.id,
      env: config.env,
      abortController: this.abort,
      canUseTool: async (toolName, toolInput, context) => this.decide(toolName, toolInput, context),
      model: config.model,
      effort: config.effort,
      permissionMode:
        config.permissionMode === null ? null : toSdkPermissionMode(config.permissionMode),
      extraArgs: config.extraArgs,
      maxBudgetUsd: config.maxBudgetUsd,
      executablePath: config.executablePath,
      chatPrompt: config.chatPrompt ?? null,
    });
  }

  /** Settles when the SDK stream ends, however it ends. */
  get finished(): Promise<SessionEnd> {
    this.run ??= this.pump();
    return this.run;
  }

  summary(): SessionSummary {
    return this.mapper.summary();
  }

  agents(): readonly AgentNode[] {
    return this.mapper.agentList();
  }

  info(): SessionInfo | null {
    return this.mapper.info();
  }

  get isOpen(): boolean {
    return !this.input.ended;
  }

  onEvent(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  send(text: string): void {
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.publish(this.mapper.prompted(text));
  }

  async interrupt(): Promise<void> {
    await this.query.interrupt();
  }

  async setModel(model: string): Promise<void> {
    await this.query.setModel(model);
    this.publish(this.mapper.modelChanged(model));
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.query.setPermissionMode(toSdkPermissionMode(mode));
    this.publish(this.mapper.permissionModeChanged(mode));
  }

  async contextUsage(): Promise<ContextUsage> {
    const usage = parseContextUsage(await this.query.getContextUsage());
    this.publish(this.mapper.contextMeasured(usage.fill));
    return usage;
  }

  /** Ends the input so the CLI exits once the current turn is done. */
  close(): void {
    this.input.end();
  }

  /** Kills the session now: aborts the process and cancels open permission prompts. */
  stop(): void {
    this.stopped = true;
    this.permissionAbort.abort();
    this.input.end();
    this.abort.abort();
  }

  private async pump(): Promise<SessionEnd> {
    let error: string | null = null;
    try {
      for await (const raw of this.query) {
        this.publish(this.mapper.translate(raw));
      }
    } catch (error_) {
      error = errorMessage(error_);
    }
    this.permissionAbort.abort();
    this.input.end();
    const reason = endReason(this.stopped, error);
    this.publish(this.mapper.ended(reason));
    return { reason, error: this.stopped ? null : error };
  }

  private async decide(
    toolName: string,
    toolInput: Record<string, unknown>,
    context: ToolPermissionContext,
  ): Promise<ToolPermissionResult> {
    const request: PermissionRequest = {
      id: this.newId(),
      sessionId: this.id,
      agent: CLAUDE_CODE,
      agentId: context.agentId ?? this.id,
      toolName,
      input: toolInput,
      requestedAt: this.now(),
      source: 'sdk',
    };
    this.openPrompts += 1;
    this.publish([
      { name: 'permission.requested', payload: request },
      ...this.mapper.waiting(this.openPrompts),
    ]);
    try {
      const signal = AbortSignal.any([context.signal, this.permissionAbort.signal]);
      return toPermissionResult(await this.deps.broker.request(request, signal), toolInput);
    } catch (error) {
      return { behavior: 'deny', message: errorMessage(error) };
    } finally {
      this.openPrompts -= 1;
      this.publish(this.mapper.waiting(this.openPrompts));
    }
  }

  private publish(events: readonly SessionEvent[]): void {
    for (const event of events) {
      if (event.name !== 'turn.result') {
        this.deps.bus.emit(event.name, event.payload);
      }
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }
}
