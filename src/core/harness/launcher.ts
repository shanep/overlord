// Runs batches of launch specs as SDK sessions, at most maxConcurrency at a
// time. Each run sends one prompt, records the first result (cost, turns,
// duration, text) and then closes its session. Budgets are off unless a spec
// sets maxBudgetUsd, because the user chose no caps by default.

import { randomUUID } from 'node:crypto';

import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';
import type { LaunchRun, LauncherState } from '../../shared/protocol.js';
import { needsBridge } from '../bridge/boisestate.js';
import type { EventBus } from '../bus.js';

import { errorMessage, type TurnResult } from './events.js';
import type { PermissionBroker } from './inbox.js';
import { findProfile, sessionSettings } from './options.js';
import type { QueryFunction } from './sdk-types.js';
import { SdkSession, type SessionEnd } from './session.js';
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
  readonly queryFunction: QueryFunction;
  readonly bus: EventBus;
  readonly broker: PermissionBroker;
  readonly worktrees?: WorktreeProvider | null;
  /** Loads the environment profiles are merged onto. Defaults to process.env. */
  readonly baseEnv?: () => Promise<Readonly<Record<string, string | undefined>>>;
  /** Picks the claude binary, given the loaded base environment. Defaults to the SDK's own. */
  readonly executablePath?: (env: Readonly<Record<string, string | undefined>>) => string | null;
  /** Rewrites a session's env to point at the boisestate.ai bridge when it opts in. */
  readonly resolveBridgeEnv?: (
    env: Readonly<Record<string, string>>,
  ) => Promise<Record<string, string>>;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export type LauncherSnapshot = Pick<LauncherState, 'runs' | 'maxConcurrency'>;

interface RunRecord {
  run: LaunchRun;
  readonly profiles: readonly LaunchProfile[];
  session: SdkSession | null;
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
        costUsd: 0,
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
    return { runs: this.runs(), maxConcurrency: this.limit };
  }

  /** Total reported spend across every run so far. */
  spendUsd(): number {
    return this.runs().reduce((total, run) => total + run.costUsd, 0);
  }

  session(runId: string): SdkSession | null {
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

  private pump(): void {
    while (this.running < this.limit) {
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
    const settings = sessionSettings(spec, findProfile(spec, record.profiles), baseEnv);
    const lease = spec.worktree ? await this.acquireWorktree(record) : null;
    if (record.stopRequested) {
      this.finish(record, 'stopped', null);
      return;
    }
    const mergedEnv = { ...settings.env, ...lease?.env };
    const env =
      this.deps.resolveBridgeEnv === undefined
        ? mergedEnv
        : await this.deps.resolveBridgeEnv(mergedEnv);
    const session = SdkSession.start(
      {
        queryFunction: this.deps.queryFunction,
        bus: this.deps.bus,
        broker: this.deps.broker,
        newId: this.newId,
        now: this.now,
      },
      {
        ...settings,
        env,
        cwd: lease?.path ?? spec.cwd,
        title: spec.label,
        executablePath: this.deps.executablePath?.(baseEnv) ?? null,
        // Checked before the rewrite, which swaps the placeholder for the real URL.
        noMcp: needsBridge(mergedEnv),
      },
    );
    record.session = session;
    this.update(record, { sessionId: session.id });
    session.onEvent((event) => {
      if (event.name === 'turn.result' && record.result === null) {
        record.result = event.payload;
        this.update(record, {
          costUsd: event.payload.costUsd,
          turns: event.payload.turns,
          result: event.payload.text,
        });
        session.close();
      }
    });
    session.send(spec.prompt);
    this.settle(record, await session.finished);
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
