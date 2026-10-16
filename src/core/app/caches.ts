// The background-loaded data behind the views. Each loader reads the host
// settings when it runs, so a settings change applies on the next refresh.

import type { PlanLimits } from '../../shared/protocol.js';
import { EMPTY_USAGE } from '../surfaces/usage.js';

import { AsyncValue } from './async-value.js';
import type { Caches, Runtime } from './runtime.js';
import { readDrafts, storagePath } from './storage.js';
import { configRepoDir, emptyConfig, loadConfig } from './views/config.js';
import { EMPTY_CONNECTORS, loadConnectors } from './views/connectors-data.js';
import { EMPTY_KNOBS, loadKnobs, loadProfiles } from './views/knobs.js';
import { EMPTY_SESSIONS, loadSessions, PeekCache } from './views/sessions.js';
import { loadPlanLimits, loadUsage } from './views/usage.js';

export type CacheRuntime = Omit<Runtime, 'caches' | 'context'>;

function repoDir(rt: CacheRuntime): string {
  return configRepoDir(rt.host.settings.configRepoPath, rt.paths.home);
}

export function createCaches(rt: CacheRuntime): Caches {
  const common = { onUpdate: rt.notify, onError: rt.report };
  const { host } = rt;
  const peeks = new PeekCache();
  return {
    knobs: new AsyncValue({
      ...common,
      name: 'knobs',
      initial: EMPTY_KNOBS,
      load: async () =>
        loadKnobs({
          paths: rt.paths,
          env: rt.env,
          workspace: host.workspaceFolder(),
          report: rt.report,
        }),
    }),
    profiles: new AsyncValue({
      ...common,
      name: 'profiles',
      initial: [],
      load: async () => loadProfiles(storagePath(host.storageDir, 'profiles'), rt.report),
    }),
    drafts: new AsyncValue({
      ...common,
      name: 'drafts',
      initial: [],
      load: async () => readDrafts(storagePath(host.storageDir, 'drafts')),
    }),
    sessions: new AsyncValue({
      ...common,
      name: 'sessions',
      initial: EMPTY_SESSIONS,
      load: async () =>
        loadSessions({
          paths: rt.paths,
          exec: rt.surfacesExec,
          isAlive: rt.isAlive,
          claudeBin: host.settings.claudePath,
          store: rt.store,
          clock: rt.clock,
          importFile: storagePath(host.storageDir, 'claudeAi'),
          report: rt.report,
          peeks,
        }),
    }),
    config: new AsyncValue({
      ...common,
      name: 'config',
      initial: emptyConfig(null),
      load: async () =>
        loadConfig({
          paths: rt.paths,
          exec: rt.exec,
          repoDir: repoDir(rt),
          workspace: host.workspaceFolder(),
        }),
    }),
    usage: new AsyncValue({
      ...common,
      name: 'usage',
      initial: EMPTY_USAGE,
      load: async () => loadUsage(rt.paths, rt.report),
    }),
    plan: new AsyncValue<PlanLimits | null>({
      ...common,
      name: 'plan limits',
      initial: null,
      load: async () => loadPlanLimits(rt.planUsage, rt.clock),
    }),
    worktrees: new AsyncValue({
      ...common,
      name: 'worktrees',
      initial: [],
      load: async () => rt.worktrees.summaries(),
    }),
    connectors: new AsyncValue({
      ...common,
      name: 'connectors',
      initial: EMPTY_CONNECTORS,
      load: async () =>
        loadConnectors({
          claudeCli: rt.claudeCli,
          workspace: host.workspaceFolder(),
          home: rt.paths.home,
          claudeJson: rt.paths.claudeJson,
          platform: rt.platform,
          exec: rt.exec,
          callTool: rt.callTool,
          clock: rt.clock,
        }),
    }),
  };
}
