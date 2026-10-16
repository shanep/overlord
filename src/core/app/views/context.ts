// The context view. The store holds what the transcript says; the resolver
// adds what did not load and why. Resolving reads the disk, so it runs in the
// background, once per snapshot, and the view shows the last result.

import type { ContextSnapshot, LoadedInstruction, SessionSummary } from '../../../shared/model.js';
import type { ContextState } from '../../../shared/protocol.js';
import type { InstructionLoadedEvent } from '../../hooks/mapping.js';
import { messageOf } from '../errors.js';
import type { PanelParams } from '../host-port.js';

import type { ResolveDeps } from './context-resolve.js';
import { resolveSnapshot } from './context-resolve.js';

export interface ContextViewDeps extends ResolveDeps {
  readonly onUpdate: () => void;
  readonly onError: (source: string, message: string) => void;
}

interface Job {
  readonly base: ContextSnapshot;
  readonly observedCount: number;
}

interface Result extends Job {
  readonly merged: ContextSnapshot;
}

function keyOf(sessionId: string, agentId: string): string {
  return `${sessionId}\u0000${agentId}`;
}

function sameJob(left: Job | undefined, right: Job): boolean {
  return left?.base === right.base && left.observedCount === right.observedCount;
}

function emptySnapshot(session: SessionSummary, agentId: string): ContextSnapshot {
  return {
    sessionId: session.id,
    agentId,
    at: session.startedAt,
    systemPrompt: null,
    model: session.model,
    loaded: [],
    skipped: [],
    skills: [],
    agentTypes: [],
    mcpServers: [],
    deferredTools: [],
    environment: {},
    weights: [],
  };
}

export class ContextViews {
  private readonly deps: ContextViewDeps;
  private readonly results = new Map<string, Result>();
  private readonly running = new Map<string, Job>();
  private readonly empties = new Map<string, ContextSnapshot>();
  private readonly hookLoads = new Map<string, LoadedInstruction[]>();

  constructor(deps: ContextViewDeps) {
    this.deps = deps;
  }

  build(params: PanelParams): ContextState {
    const { store } = this.deps;
    const sessionId = params.sessionId ?? '';
    const agentId = params.agentId ?? sessionId;
    const state = store.contextState(sessionId, agentId);
    const session = store
      .fleetState(this.deps.clock())
      .sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined) {
      return state;
    }
    const key = keyOf(sessionId, agentId);
    const base = state.snapshot ?? this.emptyBase(key, session, agentId);
    const observed = this.hookLoads.get(key) ?? [];
    const job: Job = { base, observedCount: observed.length };
    const done = this.results.get(key);
    if (done !== undefined && sameJob(done, job)) {
      return { ...state, snapshot: done.merged };
    }
    if (!sameJob(this.running.get(key), job)) {
      this.running.set(key, job);
      void this.compute(key, { base, session, agentId, observed: [...observed] }, job);
    }
    return { ...state, snapshot: base };
  }

  /** A load the InstructionsLoaded hook reported. */
  addObserved(event: InstructionLoadedEvent): void {
    const key = keyOf(event.sessionId, event.agentId);
    const list = this.hookLoads.get(key) ?? [];
    if (list.some((item) => item.path === event.instruction.path)) {
      return;
    }
    this.hookLoads.set(key, [...list, event.instruction]);
    this.deps.onUpdate();
  }

  /** Forget every result, for example after a settings file changed. */
  clear(): void {
    this.results.clear();
    this.deps.onUpdate();
  }

  private emptyBase(key: string, session: SessionSummary, agentId: string): ContextSnapshot {
    const existing = this.empties.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = emptySnapshot(session, agentId);
    this.empties.set(key, created);
    return created;
  }

  private async compute(
    key: string,
    input: Parameters<typeof resolveSnapshot>[1],
    job: Job,
  ): Promise<void> {
    let merged = input.base;
    try {
      merged = await resolveSnapshot(this.deps, input);
    } catch (error) {
      // Keep the plain snapshot so a broken resolve is not retried on every render.
      this.deps.onError('context', messageOf(error));
    }
    this.running.delete(key);
    this.results.set(key, { ...job, merged });
    this.deps.onUpdate();
  }
}
