// One agent session run from code. The runtime starts the agent and turns
// what it does into agent events, the reducer folds those into Overlord
// events, and the session publishes them on the bus. Follow-ups, interrupts
// and live model or mode changes all go to the same run.

import { randomUUID } from 'node:crypto';

import type { AgentId } from '../../shared/agents.js';
import type {
  AgentNode,
  PermissionDecision,
  PermissionRequest,
  SessionSummary,
} from '../../shared/model.js';
import type { ContextUsage } from '../agents/shared/events.js';
import { SessionReducer } from '../agents/shared/reducer.js';
import type {
  AgentRun,
  RuntimeFacet,
  ToolPermissionContext,
  ToolPermissionResult,
} from '../agents/shared/runtime.js';
import type { EventBus } from '../bus.js';

import { errorMessage, type EndReason, type SessionEvent, type SessionInfo } from './events.js';
import type { PermissionBroker } from './inbox.js';

export interface SessionDeps {
  readonly runtime: RuntimeFacet;
  readonly bus: EventBus;
  readonly broker: PermissionBroker;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export interface SessionConfig {
  readonly agent: AgentId;
  readonly cwd: string;
  readonly title: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode: string | null;
  /** The full child environment (already merged onto process.env). */
  readonly env: Readonly<Record<string, string>>;
  readonly extraArgs: Readonly<Record<string, string | null>>;
  readonly maxBudgetUsd: number | null;
  readonly executablePath: string | null;
  /** Runs the session without MCP servers. See StartOptions. */
  readonly noMcp?: boolean | undefined;
  /** A UUID for the session. One is generated when omitted. */
  readonly sessionId?: string | undefined;
}

export interface SessionEnd {
  readonly reason: EndReason;
  readonly error: string | null;
}

export type SessionListener = (event: SessionEvent) => void;

type Step = (reducer: SessionReducer) => readonly SessionEvent[];

export function toPermissionResult(
  decision: PermissionDecision,
  input: Record<string, unknown>,
): ToolPermissionResult {
  if (decision.behavior === 'allow') {
    return decision.scope === 'session'
      ? { behavior: 'allow', updatedInput: input, scope: 'session' }
      : { behavior: 'allow', updatedInput: input };
  }
  return decision.interrupt === true
    ? { behavior: 'deny', message: decision.message, interrupt: true }
    : { behavior: 'deny', message: decision.message };
}

function endReason(stopped: boolean, error: string | null): EndReason {
  if (stopped) {
    return 'stopped';
  }
  return error === null ? 'completed' : 'failed';
}

export class AgentSession {
  private readonly deps: SessionDeps;
  private readonly config: SessionConfig;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly run: AgentRun;
  private reducer: SessionReducer | null = null;
  /** What happened before the agent reported its id, replayed once it does. */
  private readonly pending: Step[] = [];
  private readonly permissionAbort = new AbortController();
  private readonly listeners = new Set<SessionListener>();
  private openPrompts = 0;
  private inputOpen = true;
  private stopped = false;
  private pumping: Promise<SessionEnd> | null = null;

  /** Creates the session and starts reading the run. */
  static start(deps: SessionDeps, config: SessionConfig): AgentSession {
    const session = new AgentSession(deps, config);
    session.step((reducer) => reducer.started());
    void session.finished;
    return session;
  }

  private constructor(deps: SessionDeps, config: SessionConfig) {
    this.deps = deps;
    this.config = config;
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.run = deps.runtime.start({
      cwd: config.cwd,
      sessionId: config.sessionId ?? randomUUID(),
      resumeId: null,
      fork: false,
      env: config.env,
      canUseTool: async (toolName, toolInput, context) => this.decide(toolName, toolInput, context),
      model: config.model,
      effort: config.effort,
      permissionMode: config.permissionMode,
      extraArgs: config.extraArgs,
      maxBudgetUsd: config.maxBudgetUsd,
      executablePath: config.executablePath,
      noMcp: config.noMcp ?? false,
    });
    this.adopt();
  }

  /** The agent's id for the session, or null until it reports one. */
  get id(): string | null {
    return this.adopt()?.sessionId ?? null;
  }

  /** Settles when the run ends, however it ends. */
  get finished(): Promise<SessionEnd> {
    this.pumping ??= this.pump();
    return this.pumping;
  }

  /** Null until the agent reports its id. */
  summary(): SessionSummary | null {
    return this.adopt()?.summary() ?? null;
  }

  agents(): readonly AgentNode[] {
    return this.adopt()?.agentList() ?? [];
  }

  info(): SessionInfo | null {
    return this.adopt()?.info() ?? null;
  }

  get isOpen(): boolean {
    return this.inputOpen;
  }

  onEvent(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  send(text: string): void {
    this.run.send(text);
    this.step((reducer) => reducer.prompted(text));
  }

  async interrupt(): Promise<void> {
    await this.run.interrupt();
  }

  async setModel(model: string): Promise<void> {
    const { setModel } = this.run;
    if (setModel === undefined) {
      throw new Error('This agent cannot change model while it runs');
    }
    await setModel(model);
    this.step((reducer) => reducer.modelChanged(model));
  }

  async setPermissionMode(mode: string): Promise<void> {
    const { setPermissionMode } = this.run;
    if (setPermissionMode === undefined) {
      throw new Error('This agent cannot change permission mode while it runs');
    }
    await setPermissionMode(mode);
    this.step((reducer) => reducer.permissionModeChanged(mode));
  }

  async contextUsage(): Promise<ContextUsage> {
    const { contextUsage } = this.run;
    if (contextUsage === undefined) {
      throw new Error('This agent does not report its context use');
    }
    const usage = await contextUsage();
    this.step((reducer) => reducer.contextMeasured(usage.fill));
    return usage;
  }

  /** Ends the input so the agent exits once the current turn is done. */
  close(): void {
    this.inputOpen = false;
    this.run.endInput();
  }

  /** Kills the session now: stops the agent and cancels open permission prompts. */
  stop(): void {
    this.stopped = true;
    this.permissionAbort.abort();
    this.inputOpen = false;
    this.run.stop();
  }

  /** Makes the reducer once the run knows its id, and replays what came before. */
  private adopt(): SessionReducer | null {
    if (this.reducer !== null || this.run.sessionId === null) {
      return this.reducer;
    }
    const reducer = new SessionReducer({
      agent: this.config.agent,
      sessionId: this.run.sessionId,
      cwd: this.config.cwd,
      title: this.config.title,
      model: this.config.model,
      effort: this.config.effort,
      permissionMode: this.config.permissionMode,
      now: this.now,
    });
    this.reducer = reducer;
    for (const step of this.pending.splice(0)) {
      this.publish(step(reducer));
    }
    return reducer;
  }

  private step(step: Step): void {
    const reducer = this.adopt();
    if (reducer === null) {
      this.pending.push(step);
    } else {
      this.publish(step(reducer));
    }
  }

  private async pump(): Promise<SessionEnd> {
    let error: string | null = null;
    try {
      for await (const event of this.run) {
        this.step((reducer) => reducer.apply(event));
      }
    } catch (error_) {
      error = errorMessage(error_);
    }
    this.permissionAbort.abort();
    this.inputOpen = false;
    this.run.endInput();
    const reason = endReason(this.stopped, error);
    this.step((reducer) => reducer.ended(reason));
    return { reason, error: this.stopped ? null : error };
  }

  private async decide(
    toolName: string,
    toolInput: Record<string, unknown>,
    context: ToolPermissionContext,
  ): Promise<ToolPermissionResult> {
    const reducer = this.adopt();
    if (reducer === null) {
      return {
        behavior: 'deny',
        message: 'The agent asked about a tool before it named its session',
      };
    }
    const request: PermissionRequest = {
      id: this.newId(),
      sessionId: reducer.sessionId,
      agent: this.config.agent,
      agentId: context.agentId ?? reducer.sessionId,
      toolName,
      input: toolInput,
      requestedAt: this.now(),
      source: this.deps.runtime.permissionSource,
      ...(context.choices === undefined ? {} : { choices: context.choices }),
    };
    this.openPrompts += 1;
    this.publish([
      { name: 'permission.requested', payload: request },
      ...reducer.waiting(this.openPrompts),
    ]);
    try {
      const signal = AbortSignal.any([context.signal, this.permissionAbort.signal]);
      return toPermissionResult(await this.deps.broker.request(request, signal), toolInput);
    } catch (error) {
      return { behavior: 'deny', message: errorMessage(error) };
    } finally {
      this.openPrompts -= 1;
      this.publish(reducer.waiting(this.openPrompts));
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
