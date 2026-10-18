// OverlordApp wires every module together. It takes all of its I/O as
// dependencies (paths, bus, clock, exec, process checks, the SDK query, the
// file system and the editor), so tests run it end to end with fakes.

import path from 'node:path';

import type { FleetState, HostToWebview, ViewId, WebviewAction } from '../../shared/protocol.js';
import { trackCustomAgents } from '../agents/custom.js';
import { agents } from '../agents/index.js';
import type { EventBus } from '../bus.js';
import { socketPath } from '../hooks/socket-path.js';
import type { ClaudePaths } from '../paths.js';

import { watchProjects } from './actions-projects.js';
import { dispatch } from './actions.js';
import type { AppDeps } from './app-deps.js';
import { coreDeps, machineDeps } from './app-deps.js';
import { buildRuntime, concurrencyFrom } from './app-runtime.js';
import { ChangeHub } from './changes.js';
import { ConfigSync } from './config-sync.js';
import { createCoordinator } from './coordination.js';
import type { AppError } from './errors.js';
import { ErrorLog } from './errors.js';
import { hookAnswers } from './hook-answers.js';
import type { PanelParams } from './host-port.js';
import { createLaunchChecker } from './launch-check.js';
import type { ActiveTerminal } from './places.js';
import type { FileWatchFunction, IntervalFunction } from './process.js';
import type { Runtime } from './runtime.js';
import { SetupCommands } from './setup.js';
import { Sources } from './sources.js';
import type { RunningItem } from './status.js';
import { runningItems, statusLine } from './status.js';
import { SyncCommands } from './sync-commands.js';
import { startTimers } from './timers.js';
import { installTransferSkill } from './transfer.js';
import { fleetFor } from './views/fleet.js';
import { stateFor } from './views/state.js';
import { sessionClosed, tidyWorktrees } from './worktrees.js';

export { concurrencyFrom } from './app-runtime.js';
export { SESSIONS_REFRESH_MS } from './timers.js';

export class OverlordApp {
  readonly paths: ClaudePaths;
  readonly bus: EventBus;
  readonly setup: SetupCommands;
  readonly sync: SyncCommands;
  private readonly rt: Runtime;
  private readonly configSync: ConfigSync;
  private readonly errors: ErrorLog;
  private readonly changes = new ChangeHub();
  private readonly sources: Sources;
  private readonly interval: IntervalFunction;
  private readonly fileWatch: FileWatchFunction;
  private readonly cleanups: (() => void)[] = [];
  /** Rereads overlord.customAgents into the agent registry. */
  private readonly updateCustomAgents: () => void;
  private started = false;
  private disposing: Promise<void> | null = null;

  constructor(deps: AppDeps) {
    const { host } = deps;
    const core = coreDeps(deps);
    const { env, clock, platform, paths, bus } = core;
    const machine = machineDeps(deps);
    this.paths = paths;
    this.bus = bus;
    this.interval = machine.interval;
    this.fileWatch = machine.fileWatch;
    this.updateCustomAgents = trackCustomAgents(agents, host);
    this.errors = new ErrorLog(clock);
    this.cleanups.push(this.errors.attach(bus));
    const notify = (): void => {
      this.changes.notify();
    };
    this.rt = buildRuntime(deps, core, machine, {
      notify,
      runtime: () => this.rt,
      sources: () => this.sources,
      configSync: () => this.configSync,
    });
    const { store, launcher, launched, permissions, context, launchNotes, report } = this.rt;
    this.cleanups.push(store.onChange(notify), launcher.onChange(notify), launched.track(launcher));
    const coordinator = createCoordinator(this.rt);
    const launchCheck = createLaunchChecker(this.rt);
    this.cleanups.push(this.rt.worktrees.onHeld(launchCheck.prime.bind(launchCheck)));
    this.sources = new Sources({
      paths: this.paths,
      env,
      host,
      bus,
      clock,
      platform,
      socketPath: deps.hookSocketPath ?? socketPath(this.paths, platform),
      watchFactory: deps.watchFactory,
      permissions,
      context,
      ...hookAnswers(this.rt, {
        coordinator,
        launchCheck,
        notes: launchNotes,
        telemetryPort: () => this.sources.telemetryPort,
      }),
      report,
      notify,
    });
    this.setup = new SetupCommands({
      paths: this.paths,
      host,
      sync: async (): Promise<void> => this.sources.sync(),
      observerMode: (): boolean => this.sources.observerMode,
      errors: (): readonly AppError[] => this.errors.list(),
      env,
    });
    this.sync = new SyncCommands(this.rt);
    this.configSync = new ConfigSync(this.rt);
  }

  /** Starts every source. Calling it again, or after dispose, does nothing. */
  async start(): Promise<void> {
    if (this.started || this.disposing !== null) {
      return;
    }
    this.started = true;
    await this.rt.permissions.load();
    await this.rt.worktrees.load();
    await Promise.all([this.rt.launched.load(), this.rt.budgets.load()]);
    await this.sources.startWatcher();
    await this.sources.sync();
    this.cleanups.push(...startTimers(this.rt, this.interval));
    await Promise.all([this.rt.places.refresh(), this.rt.jobs.refresh()]);
    void tidyWorktrees(this.rt);
    for (const file of this.settingsFiles()) {
      this.cleanups.push(
        this.fileWatch(file, () => {
          void this.settingsChanged();
        }),
      );
    }
    this.cleanups.push(
      ...(await watchProjects(this.rt, this.interval, this.fileWatch)),
      this.configSync.start(this.interval),
    );
  }

  /** The window came to the front: point the Fleet here and catch up on config changes. */
  windowFocused(): void {
    this.rt.places.windowFocused();
    void this.configSync.windowFocused();
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
    return { ...stateFor(this.rt, view, params), agents: this.rt.caches.agents.value };
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
      Promise.all([caches.config.refresh(), caches.library.refresh()]),
      caches.usage.refresh(),
      caches.plan.refresh(),
      caches.connectors.refresh(),
      tidyWorktrees(this.rt),
      this.rt.places.refresh(),
      this.rt.jobs.refresh(),
      this.rt.projects.load(),
    ]);
    this.rt.context.clear();
  }

  /** Call when the overlord.* settings change. */
  applySettings(): void {
    this.rt.launcher.setMaxConcurrency(concurrencyFrom(this.rt.host.settings.maxConcurrency));
    this.updateCustomAgents();
    void this.rt.caches.agents.refresh();
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
    this.rt.activity.stop();
    this.rt.permissions.inbox.cancelAll();
    this.rt.store.dispose();
    this.changes.clear();
    await Promise.all([this.rt.launched.idle(), this.rt.budgets.idle()]);
    await this.sources.stop();
  }
}
