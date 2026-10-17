// Runs batches of launch specs as agent sessions, at most maxConcurrency at a
// time. Each run sends one prompt, records the first result (cost, turns,
// duration, text) and then closes its session. Budgets are off unless a spec
// sets maxBudgetUsd, because the user chose no caps by default.

import { randomUUID } from 'node:crypto';

import { CLAUDE_CODE, type AgentId } from '../../shared/agents.js';
import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';
import type { LaunchRun, LauncherState } from '../../shared/protocol.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { AgentAdapter } from '../agents/types.js';
import type { Backend, EndpointSource } from '../bridge/backend.js';
import { chosenBackend } from '../bridge/backends.js';
import type { EventBus } from '../bus.js';
import type { ConfigOverride } from '../knobs/facet.js';

import { errorMessage, type TurnResult } from './events.js';
import type { PermissionBroker } from './inbox.js';
import { findProfile, sessionSettings } from './options.js';
import { AgentSession, type SessionEnd } from './session.js';
/** A worktree a run holds while it works. */
export interface WorktreeLease {
  readonly path: string;
  /** Variables the session gets, such as its port slot. */
  readonly env: Readonly<Record<string, string>>;
}

/** Hands out worktrees for runs and takes them back when the runs end. */
export interface WorktreeProvider {
  /** Null when cwd is not in a git repository, so the run works in cwd itself. */
  readonly acquire: (cwd: string, runId: string, label: string) => Promise<WorktreeLease | null>;
  /** Called once the run ends, whether it made a worktree or failed partway. */
  readonly release: (runId: string) => Promise<void>;
}

export interface LauncherDeps {
  /** The agents a run can use. A run takes its profile's agent, or Claude Code without one. */
  readonly agents: AgentRegistry;
  readonly bus: EventBus;
  readonly broker: PermissionBroker;
  readonly worktrees?: WorktreeProvider | null;
  /**
   * Config overrides a new session of agent in cwd takes at launch, such as
   * Overlord's notes, or null when the agent takes none.
   */
  readonly launchConfig?: (
    agent: AgentId,
    cwd: string,
  ) => Promise<readonly ConfigOverride[]> | null;
  /** Loads the environment profiles are merged onto. Defaults to process.env. */
  readonly baseEnv?: () => Promise<Readonly<Record<string, string | undefined>>>;
  /** Picks the agent's binary, given the loaded base environment. Null keeps the runtime's own. */
  readonly executablePath?: (
    agent: AgentId,
    env: Readonly<Record<string, string | undefined>>,
  ) => string | null;
  /** Starts the endpoint of the backend a profile runs on, such as the boisestate.ai bridge. */
  readonly backendEndpoint?: EndpointSource;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Why queued runs should wait for now, such as a nearly used usage limit, or null to start them. */
  readonly canStart?: () => string | null;
}

export type LauncherSnapshot = Pick<LauncherState, 'runs' | 'maxConcurrency' | 'held'>;

interface RunRecord {
  run: LaunchRun;
  readonly profiles: readonly LaunchProfile[];
  session: AgentSession | null;
  result: TurnResult | null;
  startedAt: number;
  stopRequested: boolean;
}

const TERMINAL: ReadonlySet<LaunchRun['state']> = new Set(['done', 'failed', 'stopped']);

export function isTerminal(state: LaunchRun['state']): boolean {
  return TERMINAL.has(state);
}

function checkConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `maxConcurrency must be a whole number of at least 1, got ${String(value)}`,
    );
  }
  return value;
}

export class Launcher {
  private readonly deps: LauncherDeps;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly records = new Map<string, RunRecord>();
  private readonly queue: string[] = [];
  private readonly listeners = new Set<(run: LaunchRun) => void>();
  private idleWaiters: (() => void)[] = [];
  private limit: number;
  private running = 0;
  private heldReason: string | null = null;

  constructor(deps: LauncherDeps, maxConcurrency: number) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    this.limit = checkConcurrency(maxConcurrency);
  }

  get maxConcurrency(): number {
    return this.limit;
  }

  get runningCount(): number {
    return this.running;
  }

  setMaxConcurrency(value: number): void {
    this.limit = checkConcurrency(value);
    this.pump();
  }

  /** Queues every spec and returns the batch id. */
  launch(specs: readonly LaunchSpec[], profiles: readonly LaunchProfile[]): string {
    const batchId = this.newId();
    for (const spec of specs) {
      const run: LaunchRun = {
        id: this.newId(),
        batchId,
        spec,
        sessionId: null,
        state: 'queued',
        costUsd: null,
        turns: 0,
        durationMs: 0,
        result: null,
        worktreePath: null,
      };
      this.records.set(run.id, {
        run,
        profiles,
        session: null,
        result: null,
        startedAt: 0,
        stopRequested: false,
      });
      this.queue.push(run.id);
      this.notify(run);
    }
    this.pump();
    return batchId;
  }

  runs(): readonly LaunchRun[] {
    return [...this.records.values()].map((record) => record.run);
  }

  state(): LauncherSnapshot {
    return { runs: this.runs(), maxConcurrency: this.limit, held: this.heldReason };
  }

  /** Total reported spend across every run so far. */
  spendUsd(): number {
    return this.runs().reduce((total, run) => total + (run.costUsd ?? 0), 0);
  }

  session(runId: string): AgentSession | null {
    return this.records.get(runId)?.session ?? null;
  }

  onChange(listener: (run: LaunchRun) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolves once nothing is queued or running. */
  async idle(): Promise<void> {
    if (this.isIdle()) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  stopRun(runId: string): boolean {
    const record = this.records.get(runId);
    if (record === undefined || isTerminal(record.run.state)) {
      return false;
    }
    if (record.run.state === 'queued') {
      this.queue.splice(this.queue.indexOf(runId), 1);
      this.update(record, { state: 'stopped' });
      this.settleIdle();
      return true;
    }
    record.stopRequested = true;
    record.session?.stop();
    return true;
  }

  stopAll(): number {
    return [...this.records.keys()].filter((id) => this.stopRun(id)).length;
  }

  private isIdle(): boolean {
    return this.queue.length === 0 && this.running === 0;
  }

  /** Looks again at whether queued runs may start. True when that changed. */
  recheck(): boolean {
    const before = this.heldReason;
    this.pump();
    return this.heldReason !== before;
  }

  private pump(): void {
    this.heldReason = this.queue.length === 0 ? null : (this.deps.canStart?.() ?? null);
    while (this.running < this.limit && this.heldReason === null) {
      const runId = this.queue.shift();
      const record = runId === undefined ? undefined : this.records.get(runId);
      if (record === undefined) {
        return;
      }
      this.running += 1;
      void this.execute(record);
    }
  }

  private async execute(record: RunRecord): Promise<void> {
    record.startedAt = this.now();
    this.update(record, { state: 'running' });
    try {
      await this.runSession(record);
    } catch (error) {
      this.finish(record, 'failed', errorMessage(error));
    } finally {
      await this.releaseWorktree(record);
      this.running -= 1;
      this.pump();
      this.settleIdle();
    }
  }

  private async runSession(record: RunRecord): Promise<void> {
    const { spec } = record.run;
    const baseEnv = this.deps.baseEnv === undefined ? process.env : await this.deps.baseEnv();
    const profile = findProfile(spec, record.profiles);
    const { adapter, runtime } = this.runtimeFor(profile, spec);
    const settings = sessionSettings(spec, profile, baseEnv, {
      ...adapter.modes,
      launch: adapter.config?.knobs?.launchOverrides,
    });
    const backend = chosenBackend({ backend: profile?.backend, env: settings.env }, adapter.id);
    const lease = spec.worktree ? await this.acquireWorktree(record) : null;
    const cwd = lease?.path ?? spec.cwd;
    // Only an agent that takes something at launch waits here, so other runs start as before.
    const pending = this.launchConfig(adapter.id, cwd);
    const notes = pending === null ? [] : await pending;
    if (record.stopRequested) {
      this.finish(record, 'stopped', null);
      return;
    }
    const routed = await this.onBackend(backend, adapter.id, { ...settings.env, ...lease?.env });
    const session = AgentSession.start(
      {
        runtime,
        bus: this.deps.bus,
        broker: this.deps.broker,
        newId: this.newId,
        now: this.now,
      },
      {
        ...settings,
        ...routed,
        agent: adapter.id,
        // An agent shows it has a price table by pricing its own default model.
        priced: adapter.models.price(adapter.models.defaultModel) !== null,
        cwd,
        config: [...settings.config, ...notes],
        title: spec.label,
        executablePath: this.binaryFor(adapter.id, baseEnv),
      },
    );
    record.session = session;
    this.follow(record, session);
    session.send(spec.prompt);
    this.settle(record, await session.finished);
  }

  /** What the agent takes at launch, or null when it takes nothing. */
  private launchConfig(agent: AgentId, cwd: string): Promise<readonly ConfigOverride[]> | null {
    return this.deps.launchConfig?.(agent, cwd) ?? null;
  }

  private binaryFor(
    agent: AgentId,
    env: Readonly<Record<string, string | undefined>>,
  ): string | null {
    return this.deps.executablePath?.(agent, env) ?? null;
  }

  /** A run's env and MCP choice on its backend, once the backend's endpoint is up. */
  private async onBackend(
    backend: Backend | null,
    agent: AgentId,
    env: Readonly<Record<string, string>>,
  ): Promise<{ readonly env: Record<string, string>; readonly noMcp: boolean }> {
    if (backend === null) {
      return { env: { ...env }, noMcp: false };
    }
    const source = this.deps.backendEndpoint;
    if (source === undefined) {
      throw new Error(`The ${backend.name} backend is not available here.`);
    }
    const endpoint = await source(backend.id);
    return { env: { ...env, ...backend.env(agent, endpoint, 'run') }, noMcp: backend.noMcp };
  }

  /** Records the session id once known and the first turn's result, then closes the input. */
  private follow(record: RunRecord, session: AgentSession): void {
    if (session.id !== null) {
      this.update(record, { sessionId: session.id });
    }
    session.onEvent((event) => {
      // An agent that mints its own id reports it after the start.
      if (record.run.sessionId === null && session.id !== null) {
        this.update(record, { sessionId: session.id });
      }
      if (event.name === 'turn.result' && record.result === null) {
        record.result = event.payload;
        this.update(record, {
          costUsd: event.payload.costUsd ?? record.run.costUsd,
          turns: event.payload.turns,
          result: event.payload.text,
        });
        session.close();
      }
    });
  }

  /**
   * The profile's agent, or without a profile the one the Launcher picked,
   * else Claude Code, and the runtime it runs on.
   */
  private runtimeFor(
    profile: LaunchProfile | null,
    spec: LaunchSpec,
  ): {
    readonly adapter: AgentAdapter;
    readonly runtime: NonNullable<AgentAdapter['runtime']>;
  } {
    const id = profile?.agent ?? spec.agent ?? CLAUDE_CODE;
    const adapter = this.deps.agents.get(id);
    if (adapter === null) {
      throw new Error(`Unknown agent "${id}"`);
    }
    if (adapter.runtime === undefined) {
      throw new Error(`${adapter.name} cannot run from the Launcher yet`);
    }
    return { adapter, runtime: adapter.runtime };
  }

  private settle(record: RunRecord, end: SessionEnd): void {
    if (record.stopRequested) {
      this.finish(record, 'stopped', null);
    } else if (record.result === null) {
      this.finish(record, 'failed', end.error ?? 'The session ended without a result');
    } else {
      this.finish(record, record.result.ok ? 'done' : 'failed', record.result.text);
    }
  }

  private async acquireWorktree(record: RunRecord): Promise<WorktreeLease | null> {
    const worktrees = this.deps.worktrees ?? null;
    if (worktrees === null) {
      throw new Error('Worktree runs need a WorktreeProvider');
    }
    const { spec } = record.run;
    const lease = await worktrees.acquire(spec.cwd, record.run.id, spec.label);
    if (lease !== null) {
      this.update(record, { worktreePath: lease.path });
    }
    return lease;
  }

  /** A failed release leaves the worktree for the next tidy-up, so it never fails the run. */
  private async releaseWorktree(record: RunRecord): Promise<void> {
    if (record.run.worktreePath === null) {
      return;
    }
    try {
      await this.deps.worktrees?.release(record.run.id);
    } catch (error) {
      this.deps.bus.emit('source.error', { source: 'worktrees', message: errorMessage(error) });
    }
  }

  private finish(
    record: RunRecord,
    state: 'done' | 'failed' | 'stopped',
    result: string | null,
  ): void {
    const durationMs = record.result?.durationMs ?? this.now() - record.startedAt;
    this.update(record, { state, durationMs, result });
  }

  private update(record: RunRecord, patch: Partial<LaunchRun>): void {
    record.run = { ...record.run, ...patch };
    this.notify(record.run);
  }

  private notify(run: LaunchRun): void {
    for (const listener of this.listeners) {
      listener(run);
    }
  }

  private settleIdle(): void {
    if (!this.isIdle()) {
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
