// OverlordApp wires every module together. It takes all of its I/O as
// dependencies (paths, bus, clock, exec, process checks, the SDK query, the
// file system and the editor), so tests run it end to end with fakes.

import os from 'node:os';
import path from 'node:path';

import type { FleetState, HostToWebview, ViewId, WebviewAction } from '../../shared/protocol.js';
import { EventBus } from '../bus.js';
import { createNodeFileSystem, type FileSystem } from '../context/fs.js';
import { findOnPath } from '../find-on-path.js';
import { Launcher } from '../harness/launcher.js';
import { mergeEnv } from '../harness/options.js';
import type { PlanUsageFunction, QueryFunction } from '../harness/sdk-types.js';
import { sdkPlanUsage, sdkQuery } from '../harness/sdk-types.js';
import { socketPath } from '../hooks/socket-path.js';
import { defaultClaudePaths, type ClaudePaths } from '../paths.js';
import type { Scheduler } from '../store/store.js';
import { OverlordStore } from '../store/store.js';
import { makeIsAlive, type IsAlive } from '../surfaces/process.js';
import { createNodeExec, type Exec } from '../sync/exec.js';
import type { WatchFactory } from '../transcripts/watcher.js';

import { dispatch } from './actions.js';
import type { CacheRuntime } from './caches.js';
import { createCaches } from './caches.js';
import { ChangeHub } from './changes.js';
import type { AppError } from './errors.js';
import { ErrorLog } from './errors.js';
import type { HostPort, PanelParams } from './host-port.js';
import { BackgroundJobs, JOBS_REFRESH_MS } from './jobs.js';
import { PermissionHub } from './permissions.js';
import type { ActiveTerminal } from './places.js';
import { PLACES_REFRESH_MS, SessionPlaces } from './places.js';
import type { FileWatchFunction, IntervalFunction, KillFunction } from './process.js';
import { defaultInterval, defaultKill, pollingFileWatch, toSurfacesExec } from './process.js';
import type { Runtime } from './runtime.js';
import { SetupCommands } from './setup.js';
import { once, readLoginShellEnv } from './shell-env.js';
import { Sources } from './sources.js';
import type { RunningItem } from './status.js';
import { runningItems, statusLine } from './status.js';
import { SyncCommands } from './sync-commands.js';
import { installTransferSkill } from './transfer.js';
import { ContextViews } from './views/context.js';
import { fleetFor } from './views/fleet.js';
import { stateFor } from './views/state.js';
import {
  createWorktreeRegistry,
  launcherWorktrees,
  sessionClosed,
  tidyWorktrees,
  WORKTREE_REFRESH_MS,
} from './worktrees.js';

export interface AppDeps {
  readonly host: HostPort;
  readonly paths?: ClaudePaths;
  readonly bus?: EventBus;
  readonly clock?: () => number;
  /** Runs git and claude. Defaults to child_process.execFile with no shell. */
  readonly exec?: Exec;
  readonly isAlive?: IsAlive;
  readonly kill?: KillFunction;
  /** The Agent SDK query. Tests pass a fake so no real Claude session ever starts. */
  readonly queryFunction?: QueryFunction;
  /** Reads plan limits through the SDK. Tests pass a fake for the same reason. */
  readonly planUsageFunction?: PlanUsageFunction;
  readonly fs?: FileSystem;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly hostname?: string;
  readonly platform?: NodeJS.Platform;
  readonly hookSocketPath?: string;
  /** For the store's change notifications. */
  readonly scheduler?: Scheduler;
  readonly interval?: IntervalFunction;
  readonly delay?: (ms: number) => Promise<void>;
  readonly fileWatch?: FileWatchFunction;
  /** Null turns the transcript watcher's fs.watch off and leaves its poll. */
  readonly watchFactory?: WatchFactory | null;
  /** This process's id, which marks the worktrees it holds. */
  readonly pid?: number;
}

export const SESSIONS_REFRESH_MS = 30_000;
const SETTINGS_POLL_MS = 2000;

/**
 * The binary SDK runs use. The host only searched the editor's PATH, so a bare
 * name is looked up again on the login shell's. A bare `claude` found nowhere
 * leaves the SDK to its bundled CLI.
 */
export function executableFor(
  claudePath: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string | null {
  const name = claudePath.trim() === '' ? 'claude' : claudePath.trim();
  const found = findOnPath({ name, pathValue: env['PATH'], platform });
  if (found !== null) {
    return found;
  }
  return name === 'claude' ? null : name;
}

export function concurrencyFrom(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
}

interface CoreDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: () => number;
  readonly exec: Exec;
  readonly platform: NodeJS.Platform;
  readonly paths: ClaudePaths;
  readonly bus: EventBus;
}

interface MachineDeps {
  readonly isAlive: IsAlive;
  readonly kill: KillFunction;
  readonly hostname: string;
  readonly fs: FileSystem;
  readonly interval: IntervalFunction;
  readonly delay: (ms: number) => Promise<void>;
  readonly fileWatch: FileWatchFunction;
}

function coreDeps(deps: AppDeps): CoreDeps {
  return {
    env: deps.env ?? process.env,
    clock: deps.clock ?? Date.now,
    exec: deps.exec ?? createNodeExec(),
    platform: deps.platform ?? process.platform,
    paths: deps.paths ?? defaultClaudePaths(),
    bus: deps.bus ?? new EventBus(),
  };
}

export async function defaultDelay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function machineDeps(deps: AppDeps): MachineDeps {
  return {
    isAlive: deps.isAlive ?? makeIsAlive(),
    kill: deps.kill ?? defaultKill,
    hostname: deps.hostname ?? os.hostname(),
    fs: deps.fs ?? createNodeFileSystem(),
    interval: deps.interval ?? defaultInterval,
    delay: deps.delay ?? defaultDelay,
    fileWatch: deps.fileWatch ?? pollingFileWatch(SETTINGS_POLL_MS),
  };
}

export class OverlordApp {
  readonly paths: ClaudePaths;
  readonly bus: EventBus;
  readonly setup: SetupCommands;
  readonly sync: SyncCommands;
  private readonly rt: Runtime;
  private readonly errors: ErrorLog;
  private readonly changes = new ChangeHub();
  private readonly sources: Sources;
  private readonly interval: IntervalFunction;
  private readonly fileWatch: FileWatchFunction;
  private readonly cleanups: (() => void)[] = [];
  private started = false;
  private disposing: Promise<void> | null = null;

  constructor(deps: AppDeps) {
    const { host } = deps;
    const { env, clock, exec, platform, paths, bus } = coreDeps(deps);
    const machine = machineDeps(deps);
    this.paths = paths;
    this.bus = bus;
    this.interval = machine.interval;
    this.fileWatch = machine.fileWatch;
    this.errors = new ErrorLog(clock);
    this.cleanups.push(this.errors.attach(bus));
    const notify = (): void => {
      this.changes.notify();
    };
    const report = (source: string, message: string): void => {
      bus.emit('source.error', { source, message });
    };
    const store = new OverlordStore(bus, {
      notifyDelayMs: host.settings.updateThrottleMs,
      scheduler: deps.scheduler,
      clock,
    });
    const permissions = new PermissionHub({
      storageDir: host.storageDir,
      bus,
      clock,
      onChange: notify,
    });
    // Launched runs get the same PATH and variables as a terminal tab.
    const launchEnv = once(async () => readLoginShellEnv(exec, env, platform));
    const worktrees = createWorktreeRegistry({
      paths,
      storageDir: host.storageDir,
      exec,
      isAlive: machine.isAlive,
      clock,
      pid: deps.pid ?? process.pid,
    });
    const launcher = new Launcher(
      {
        queryFunction: deps.queryFunction ?? sdkQuery,
        bus,
        broker: permissions.inbox,
        // The caches exist by the time a run reaches for a worktree.
        worktrees: launcherWorktrees(worktrees, report, () => {
          void this.rt.caches.worktrees.refresh();
        }),
        baseEnv: launchEnv,
        executablePath: (runEnv): string | null =>
          executableFor(host.settings.claudePath, runEnv, platform),
        now: clock,
      },
      concurrencyFrom(host.settings.maxConcurrency),
    );
    const planUsageFunction = deps.planUsageFunction ?? sdkPlanUsage;
    const surfacesExec = toSurfacesExec(exec);
    const places = new SessionPlaces({
      paths,
      exec: surfacesExec,
      isAlive: machine.isAlive,
      terminalPids: host.terminalPids,
      onChange: notify,
      report,
    });
    const jobs = new BackgroundJobs({
      exec: surfacesExec,
      // Null means a bare claude the login shell cannot find either, so leave it to PATH.
      claudeBin: async (): Promise<string> =>
        executableFor(host.settings.claudePath, await launchEnv(), platform) ?? 'claude',
      // Sources is built below, and this only runs after start.
      keep: async (sessionIds): Promise<void> => this.sources.keepTranscripts(sessionIds),
      onChange: notify,
      report,
    });
    const base: CacheRuntime = {
      paths: this.paths,
      host,
      bus,
      clock,
      exec,
      surfacesExec,
      isAlive: machine.isAlive,
      kill: machine.kill,
      delay: machine.delay,
      env,
      hostname: machine.hostname,
      platform,
      fs: machine.fs,
      store,
      launcher,
      worktrees,
      sessionWorktrees: new Map(),
      permissions,
      places,
      jobs,
      report,
      planUsage: async (): Promise<unknown> => {
        const usageEnv = await launchEnv();
        return planUsageFunction({
          cwd: paths.home,
          env: mergeEnv(usageEnv, {}),
          executablePath: executableFor(host.settings.claudePath, usageEnv, platform),
        });
      },
      notify,
      // Sources is built below, and this only runs after construction.
      openTranscript: async (sessionId: string): Promise<boolean> =>
        this.sources.openTranscript(sessionId),
    };
    const context = new ContextViews({ ...base, onUpdate: notify, onError: report });
    this.rt = { ...base, caches: createCaches(base), context };
    this.cleanups.push(store.onChange(notify), launcher.onChange(notify));
    this.sources = new Sources({
      paths: this.paths,
      host,
      bus,
      clock,
      platform,
      socketPath: deps.hookSocketPath ?? socketPath(this.paths, platform),
      watchFactory: deps.watchFactory,
      permissions,
      context,
      report,
      notify,
    });
    this.setup = new SetupCommands({
      paths: this.paths,
      host,
      sync: async (): Promise<void> => this.sources.sync(),
      observerMode: (): boolean => this.sources.observerMode,
      errors: (): readonly AppError[] => this.errors.list(),
    });
    this.sync = new SyncCommands(this.rt);
  }

  /** Starts every source. Calling it again, or after dispose, does nothing. */
  async start(): Promise<void> {
    if (this.started || this.disposing !== null) {
      return;
    }
    this.started = true;
    await this.rt.permissions.load();
    await this.rt.worktrees.load();
    await this.sources.startWatcher();
    await this.sources.sync();
    this.cleanups.push(
      this.interval(() => {
        void this.rt.caches.sessions.refresh();
      }, SESSIONS_REFRESH_MS),
      this.interval(() => {
        void this.rt.places.refresh();
      }, PLACES_REFRESH_MS),
      this.interval(() => {
        void this.rt.jobs.refresh();
      }, JOBS_REFRESH_MS),
      this.interval(() => {
        void tidyWorktrees(this.rt);
      }, WORKTREE_REFRESH_MS),
    );
    await Promise.all([this.rt.places.refresh(), this.rt.jobs.refresh()]);
    void tidyWorktrees(this.rt);
    for (const file of this.settingsFiles()) {
      this.cleanups.push(
        this.fileWatch(file, () => {
          void this.settingsChanged();
        }),
      );
    }
  }

  /** The port the local OTLP receiver listens on, or null when telemetry is off. */
  get telemetryPort(): number | null {
    return this.sources.telemetryPort;
  }

  /** The shared wiring, for the host's tree views and for tests. */
  get runtime(): Runtime {
    return this.rt;
  }

  stateFor(view: ViewId, params: PanelParams): HostToWebview {
    return stateFor(this.rt, view, params);
  }

  onChange(listener: () => void): () => void {
    return this.changes.on(listener);
  }

  async dispatch(action: WebviewAction, params: PanelParams): Promise<void> {
    await dispatch(this.rt, action, params);
  }

  /** Adds the /overlord command to Claude Code, after asking. */
  async installTransferSkill(uriScheme: string): Promise<void> {
    await installTransferSkill(this.rt, uriScheme);
  }

  /** Continues a session here, stopping a copy open in another terminal first. */
  async continueSession(sessionId: string): Promise<void> {
    await this.dispatch({ type: 'handoff', sessionId, kind: 'resume-local' }, {});
  }

  /** The host calls this when the focused terminal changes, so the fleet can follow it. */
  setActiveTerminal(terminal: ActiveTerminal | null): void {
    this.rt.places.setActiveTerminal(terminal);
  }

  /** The session in the focused terminal, for the Session Properties view, or null. */
  activeSession(): string | null {
    return this.rt.places.activeSession();
  }

  /** A session tab this window opened has closed. */
  async sessionClosed(sessionId: string): Promise<void> {
    await sessionClosed(this.rt, sessionId);
  }

  /** Text for the status bar item. */
  statusLine(): string {
    return statusLine(this.fleet());
  }

  /** Items for the "Running" tree view. */
  runningItems(): readonly RunningItem[] {
    return runningItems(this.fleet());
  }

  /** Recent source errors, oldest first. */
  errorList(): readonly AppError[] {
    return this.errors.list();
  }

  /** Reloads every cache and rereads transcripts and rules. */
  async refresh(): Promise<void> {
    const { caches } = this.rt;
    await Promise.all([
      this.sources.refreshWatcher(),
      this.rt.permissions.load(),
      caches.knobs.refresh(),
      caches.profiles.refresh(),
      caches.drafts.refresh(),
      caches.sessions.refresh(),
      caches.config.refresh(),
      caches.usage.refresh(),
      caches.plan.refresh(),
      tidyWorktrees(this.rt),
      this.rt.places.refresh(),
      this.rt.jobs.refresh(),
    ]);
    this.rt.context.clear();
  }

  /** Call when the overlord.* settings change. */
  applySettings(): void {
    this.rt.launcher.setMaxConcurrency(concurrencyFrom(this.rt.host.settings.maxConcurrency));
    this.changes.notify();
  }

  /** Stops every source and run. Safe to call more than once. */
  async dispose(): Promise<void> {
    this.disposing ??= this.teardown();
    return this.disposing;
  }

  private async settingsChanged(): Promise<void> {
    this.rt.context.clear();
    await Promise.all([this.rt.caches.knobs.refresh(), this.sources.sync()]);
  }

  private settingsFiles(): string[] {
    const workspace = this.rt.host.workspaceFolder();
    const project =
      workspace === null
        ? []
        : [
            path.join(workspace, '.claude', 'settings.json'),
            path.join(workspace, '.claude', 'settings.local.json'),
          ];
    return [this.paths.userSettings, ...project];
  }

  private fleet(): FleetState {
    return fleetFor(this.rt);
  }

  private async teardown(): Promise<void> {
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
    this.rt.launcher.stopAll();
    this.rt.permissions.inbox.cancelAll();
    this.rt.store.dispose();
    this.changes.clear();
    await this.sources.stop();
  }
}
