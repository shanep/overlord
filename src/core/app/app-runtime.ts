// Builds the Runtime that OverlordApp shares with every view and action.
// Sources, the config sync and the runtime itself are made after the pieces
// that call them, so those calls go through the getters in `links`, and none
// of them runs before construction ends.

import { CLAUDE_CODE } from '../../shared/agents.js';
import { sdkPlanUsage } from '../agents/claude/runtime.js';
import type { AgentCli } from '../agents/types.js';
import { GitHubReader } from '../catalog/github.js';
import { callStdioTool } from '../connectors/stdio-mcp.js';
import { Launcher } from '../harness/launcher.js';
import { mergeEnv } from '../harness/options.js';
import { OverlordStore } from '../store/store.js';

import { agentCli } from './agent-terminal.js';
import type { AppDeps, CoreDeps, MachineDeps } from './app-deps.js';
import { launcherAgents } from './app-deps.js';
import { TokenBudgets } from './budgets.js';
import type { CacheRuntime } from './caches.js';
import { createCaches } from './caches.js';
import { CatalogBrowser } from './catalog-browser.js';
import { cliLoader, executableFor, launchBinary } from './claude-bin.js';
import type { ConfigSync } from './config-sync.js';
import { BackgroundJobs } from './jobs.js';
import { LaunchNotes } from './launch-notes.js';
import { LaunchedSessions } from './launched-sessions.js';
import { paceHold, timeOfDay } from './pacing.js';
import { PermissionHub } from './permissions.js';
import { SessionPlaces } from './places.js';
import { toSurfacesExec } from './process.js';
import { createProjectIndex } from './projects.js';
import { RegistrySearch } from './registry-search.js';
import type { Runtime } from './runtime.js';
import { once, readLoginShellEnv } from './shell-env.js';
import type { Sources } from './sources.js';
import { storagePath } from './storage.js';
import { createActivity } from './views/activity.js';
import { ContextViews } from './views/context.js';
import { currentPlan } from './views/usage.js';
import { createWorktreeRegistry, launcherWorktrees } from './worktrees.js';

export interface RuntimeLinks {
  readonly notify: () => void;
  readonly runtime: () => Runtime;
  readonly sources: () => Sources;
  readonly configSync: () => ConfigSync;
}

export function concurrencyFrom(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
}

export function buildRuntime(
  deps: AppDeps,
  core: CoreDeps,
  machine: MachineDeps,
  links: RuntimeLinks,
): Runtime {
  const { host } = deps;
  const { notify } = links;
  const { env, clock, exec, platform, paths, bus } = core;
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
  const launchNotes = new LaunchNotes();
  const launcher = new Launcher(
    {
      agents: runners,
      bus,
      broker: permissions.inbox,
      worktrees: launcherWorktrees(worktrees, report, () => {
        void links.runtime().caches.worktrees.refresh();
      }),
      baseEnv: launchEnv,
      launchConfig: launchNotes.config,
      executablePath: (agent, runEnv): string | null =>
        launchBinary(host.settings, runners.get(agent), runEnv, platform),
      ...(host.backendEndpoint === undefined ? {} : { backendEndpoint: host.backendEndpoint }),
      now: clock,
      canStart: (): string | null =>
        host.settings.paceToUsageLimit
          ? paceHold(currentPlan(links.runtime()), clock(), timeOfDay)
          : null,
    },
    concurrencyFrom(host.settings.maxConcurrency),
  );
  const planUsageFunction = deps.planUsageFunction ?? sdkPlanUsage;
  const surfacesExec = toSurfacesExec(exec);
  const events = { onChange: notify, report };
  const places = new SessionPlaces({
    ...events,
    onStatus: (): void => void links.runtime().jobs.refresh(),
    paths,
    exec: surfacesExec,
    isAlive: machine.isAlive,
    terminalPids: host.terminalPids,
    keep: async (sessionIds): Promise<void> => links.sources().keepViewed(sessionIds),
  });
  const jobs = new BackgroundJobs({
    exec: surfacesExec,
    cliFor: async (at): Promise<AgentCli> => agentCli(links.runtime(), at),
    keep: async (ids, finished): Promise<void> => links.sources().keepTranscripts(ids, finished),
    ...events,
  });
  const projects = createProjectIndex(host.storageDir, worktrees, { ...events, clock });
  const launched = new LaunchedSessions({
    ...events,
    file: storagePath(host.storageDir, 'launched'),
    keep: async (ids): Promise<void> => links.sources().keepLaunched(ids),
  });
  const base: CacheRuntime = {
    paths,
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
    knobsPick: { agent: CLAUDE_CODE },
    browsedFolders: [],
    permissions,
    places,
    jobs,
    projects,
    launched,
    budgets: new TokenBudgets({ ...events, file: storagePath(host.storageDir, 'budgets') }),
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
    openTranscript: async (id: string): Promise<boolean> => links.sources().openTranscript(id),
    dismissTranscript: async (id: string): Promise<void> => links.sources().dismissTranscript(id),
    sessionBusy: (id: string): boolean => links.sources().sessionBusy(id),
    claudeCli: deps.claudeCli ?? cliLoader(host.settings, launchEnv, platform),
    loginEnv: launchEnv,
    configSync: {
      status: () => links.configSync().status(),
      syncNow: async (): Promise<void> => links.configSync().syncNow(),
    },
    fetch: machine.fetch,
    callTool: deps.callTool ?? callStdioTool,
    launchNotes,
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
  return { ...base, caches: createCaches(base), context, activity, registry, catalogs };
}
