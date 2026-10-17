// OverlordApp wires every module together. It takes all of its I/O as
// dependencies (paths, bus, clock, exec, process checks, the SDK query, the
// file system and the editor), so tests run it end to end with fakes.

import path from 'node:path';

import type { FleetState, HostToWebview, ViewId, WebviewAction } from '../../shared/protocol.js';
import { sdkPlanUsage } from '../agents/claude/runtime.js';
import { trackCustomAgents } from '../agents/custom.js';
import { agents } from '../agents/index.js';
import type { AgentCli } from '../agents/types.js';
import type { EventBus } from '../bus.js';
import { GitHubReader } from '../catalog/github.js';
import { callStdioTool } from '../connectors/stdio-mcp.js';
import { Launcher } from '../harness/launcher.js';
import { mergeEnv } from '../harness/options.js';
import type { HookAnswer } from '../hooks/normalized.js';
import { withContextNote, withNotice } from '../hooks/normalized.js';
import { socketPath } from '../hooks/socket-path.js';
import { compatSummary } from '../launch-check/note.js';
import type { ClaudePaths } from '../paths.js';
import { OverlordStore } from '../store/store.js';

import { watchProjects } from './actions-projects.js';
import { dispatch } from './actions.js';
import { agentCli } from './agent-terminal.js';
import type { AppDeps } from './app-deps.js';
import { coreDeps, launcherAgents, machineDeps } from './app-deps.js';
import type { CacheRuntime } from './caches.js';
import { createCaches } from './caches.js';
import { CatalogBrowser } from './catalog-browser.js';
import { ChangeHub } from './changes.js';
import { cliLoader, executableFor, launchBinary } from './claude-bin.js';
import { ConfigSync } from './config-sync.js';
import { createCoordinator } from './coordination.js';
import type { AppError } from './errors.js';
import { ErrorLog } from './errors.js';
import type { PanelParams } from './host-port.js';
import { BackgroundJobs } from './jobs.js';
import { createLaunchChecker } from './launch-check.js';
import { LaunchedSessions } from './launched-sessions.js';
import { paceHold, timeOfDay } from './pacing.js';
import { PermissionHub } from './permissions.js';
import type { ActiveTerminal } from './places.js';
import { SessionPlaces } from './places.js';
import type { FileWatchFunction, IntervalFunction } from './process.js';
import { toSurfacesExec } from './process.js';
import { createProjectIndex } from './projects.js';
import { RegistrySearch } from './registry-search.js';
import type { Runtime } from './runtime.js';
import { SetupCommands } from './setup.js';
import { once, readLoginShellEnv } from './shell-env.js';
import { Sources } from './sources.js';
import type { RunningItem } from './status.js';
import { runningItems, statusLine } from './status.js';
import { storagePath } from './storage.js';
import { SyncCommands } from './sync-commands.js';
import { startTimers } from './timers.js';
import { installTransferSkill } from './transfer.js';
import { createActivity } from './views/activity.js';
import { sessionBriefing } from './views/connectors.js';
import { ContextViews } from './views/context.js';
import { fleetFor } from './views/fleet.js';
import { stateFor } from './views/state.js';
import { currentPlan } from './views/usage.js';
import {
  createWorktreeRegistry,
  launcherWorktrees,
  sessionClosed,
  tidyWorktrees,
} from './worktrees.js';

export { SESSIONS_REFRESH_MS } from './timers.js';

export function concurrencyFrom(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
}

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
    const { env, clock, exec, platform, paths, bus } = coreDeps(deps);
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
    const runners = launcherAgents(deps.queryFunction);
    const launcher = new Launcher(
      {
        agents: runners,
        bus,
        broker: permissions.inbox,
        // The caches exist by the time a run reaches for a worktree.
        worktrees: launcherWorktrees(worktrees, report, () => {
          void this.rt.caches.worktrees.refresh();
        }),
        baseEnv: launchEnv,
        executablePath: (agent, runEnv): string | null =>
          launchBinary(host.settings, runners.get(agent), runEnv, platform),
        ...(host.backendEndpoint === undefined ? {} : { backendEndpoint: host.backendEndpoint }),
        now: clock,
        // The runtime exists by the time a queued run asks.
        canStart: (): string | null =>
          host.settings.paceToUsageLimit
            ? paceHold(currentPlan(this.rt), clock(), timeOfDay)
            : null,
      },
      concurrencyFrom(host.settings.maxConcurrency),
    );
    const planUsageFunction = deps.planUsageFunction ?? sdkPlanUsage;
    const surfacesExec = toSurfacesExec(exec);
    // What the background sources call when something changed or failed.
    const events = { onChange: notify, report };
    const places = new SessionPlaces({
      ...events,
      // Jobs is built below, and this only runs after start.
      onStatus: (): void => void this.rt.jobs.refresh(),
      paths,
      exec: surfacesExec,
      isAlive: machine.isAlive,
      terminalPids: host.terminalPids,
      // Sources is built below, and the keeps here and in jobs only run after start.
      keep: async (sessionIds): Promise<void> => this.sources.keepViewed(sessionIds),
    });
    const jobs = new BackgroundJobs({
      exec: surfacesExec,
      // The runtime is built below, and this only runs after start.
      cliFor: async (at): Promise<AgentCli> => agentCli(this.rt, at),
      keep: async (ids, finished): Promise<void> => this.sources.keepTranscripts(ids, finished),
      ...events,
    });
    const projects = createProjectIndex(host.storageDir, worktrees, { ...events, clock });
    const launched = new LaunchedSessions({
      ...events,
      file: storagePath(host.storageDir, 'launched'),
      // Sources is built below, and this only runs after construction.
      keep: async (ids): Promise<void> => this.sources.keepLaunched(ids),
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
      browsedFolders: [],
      permissions,
      places,
      jobs,
      projects,
      launched,
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
      openTranscript: async (id: string): Promise<boolean> => this.sources.openTranscript(id),
      dismissTranscript: async (id: string): Promise<void> => this.sources.dismissTranscript(id),
      sessionBusy: (id: string): boolean => this.sources.sessionBusy(id),
      claudeCli: deps.claudeCli ?? cliLoader(host.settings, launchEnv, platform),
      loginEnv: launchEnv,
      // The config sync is built below, once the runtime it needs exists.
      configSync: {
        status: () => this.configSync.status(),
        syncNow: async (): Promise<void> => this.configSync.syncNow(),
      },
      fetch: machine.fetch,
      callTool: deps.callTool ?? callStdioTool,
    };
    const context = new ContextViews({ ...base, onUpdate: notify, onError: report });
    const activity = createActivity(base, machine.interval);
    const registry = new RegistrySearch({ fetch: base.fetch, notify });
    const reader = new GitHubReader({
      fetch: base.fetch,
      token: async (): Promise<string | null> =>
        host.gitHubSession(false).then(
          (signIn) => signIn?.accessToken ?? null,
          () => null,
        ),
    });
    const catalogs = {
      reader,
      skill: new CatalogBrowser({ kind: 'skill', reader, fetch: base.fetch, notify }),
      agent: new CatalogBrowser({ kind: 'agent', reader, fetch: base.fetch, notify }),
    };
    this.rt = { ...base, caches: createCaches(base), context, activity, registry, catalogs };
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
      advise: (event): HookAnswer | null => {
        const note = launchCheck.noteFor(event);
        return withNotice(
          withContextNote(coordinator.handle(event), note),
          note === null ? null : compatSummary(note),
        );
      },
      report,
      notify,
      sessionContext: (): string | null =>
        host.settings.briefSessions ? sessionBriefing(this.rt) : null,
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
    await this.rt.launched.load();
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
    await this.rt.launched.idle();
    await this.sources.stop();
  }
}
