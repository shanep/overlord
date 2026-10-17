// The config and sync view: every config item with its badge, and the state
// of the config repo clone.

import type { ConfigState, ConfigSyncStatus } from '../../../shared/protocol.js';
import type { ClaudePaths } from '../../paths.js';
import type { AgentSyncTarget } from '../../sync/agent-plan.js';
import type { Exec } from '../../sync/exec.js';
import { pathExists, realpathOrSelf } from '../../sync/files.js';
import { aheadBehind, remoteUrl, repoRootOf, statusPorcelain } from '../../sync/git.js';
import { scanInventory } from '../../sync/inventory.js';
import { expandHome } from '../../sync/layout.js';

export interface ConfigLoadDeps {
  readonly paths: ClaudePaths;
  readonly exec: Exec;
  /** The configured clone location, with ~ already expanded. */
  readonly repoDir: string;
  readonly workspace: string | null;
  /** Agents past Claude Code whose config syncs under agents/<id>/. */
  readonly agents?: readonly AgentSyncTarget[];
  readonly host?: string;
}

export const IDLE_SYNC: ConfigSyncStatus = { state: 'idle', lastSyncAt: null, message: null };

export function emptyConfig(repoDir: string | null): ConfigState {
  return {
    items: [],
    repo: { connected: false, remote: null, path: repoDir, ahead: 0, behind: 0, dirty: 0 },
    sync: IDLE_SYNC,
  };
}

export function configRepoDir(configRepoPath: string, home: string): string {
  return expandHome(configRepoPath, home);
}

/** The clone's root when `dir` is itself the top of a git work tree, else null. */
export async function connectedRoot(exec: Exec, dir: string): Promise<string | null> {
  if (!(await pathExists(dir))) {
    return null;
  }
  const root = await repoRootOf(exec, dir);
  return root !== null && root === (await realpathOrSelf(dir)) ? root : null;
}

export async function loadConfig(deps: ConfigLoadDeps): Promise<ConfigState> {
  const root = await connectedRoot(deps.exec, deps.repoDir);
  const items = await scanInventory({
    paths: deps.paths,
    exec: deps.exec,
    configRepoRoot: root,
    workspace: deps.workspace,
    agents: deps.agents ?? [],
    host: deps.host ?? '',
  });
  if (root === null) {
    return { ...emptyConfig(deps.repoDir), items };
  }
  const counts = await aheadBehind(deps.exec, root);
  const changes = await statusPorcelain(deps.exec, root);
  return {
    items,
    repo: {
      connected: true,
      remote: await remoteUrl(deps.exec, root),
      path: root,
      ahead: counts.ahead,
      behind: counts.behind,
      dirty: changes.length,
    },
    sync: IDLE_SYNC,
  };
}
