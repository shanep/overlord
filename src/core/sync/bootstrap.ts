// New machine setup: clone the config repo and its external repos, read the
// manifest, and return the plan for the UI to show as a dry run. Applying it
// is a separate, explicit call to applyPlan.

import type { ClaudePaths } from '../paths.js';

import { summarizePlan, type Action } from './actions.js';
import type { AgentSyncTarget } from './agent-plan.js';
import type { Exec } from './exec.js';
import { listDir, pathExists, realpathOrSelf } from './files.js';
import { clone, remoteUrl, repoRootOf, type GitAuth } from './git.js';
import { remoteSlug } from './layout.js';
import { readManifest, type Manifest } from './manifest.js';
import { checkoutOf, planAll } from './plan.js';

export interface BootstrapOptions {
  readonly repoUrl: string;
  /** Where the config repo is cloned. */
  readonly dest: string;
  readonly paths: ClaudePaths;
  readonly host: string;
  /** Credentials for cloning the config repo. Null leaves it to the user's git setup. */
  readonly deps: { readonly exec: Exec; readonly auth?: GitAuth };
  /** Agents past Claude Code whose agents/<id>/ part of the repo applies too. */
  readonly agents?: readonly AgentSyncTarget[];
}

export interface BootstrapResult {
  readonly manifest: Manifest;
  readonly actions: readonly Action[];
  /** The dry run text for the confirmation screen. */
  readonly summary: string;
  /** False when `dest` already held a clone of the repo. */
  readonly cloned: boolean;
  readonly externalsCloned: readonly string[];
}

function sameRemote(a: string, b: string): boolean {
  const slugA = remoteSlug(a);
  return slugA === null ? a === b : slugA === remoteSlug(b);
}

async function ensureClone(
  exec: Exec,
  repoUrl: string,
  destination: string,
  auth: GitAuth,
): Promise<boolean> {
  const entries = await listDir(destination);
  if (entries.length === 0) {
    await clone(exec, repoUrl, destination, auth);
    return true;
  }
  // The folder itself must be the clone, not some folder inside another repo.
  const root = await repoRootOf(exec, destination);
  const isRoot = root !== null && root === (await realpathOrSelf(destination));
  const url = isRoot ? await remoteUrl(exec, root) : null;
  if (url === null || !sameRemote(url, repoUrl)) {
    throw new Error(`${destination} already exists and is not a clone of ${repoUrl}`);
  }
  return false;
}

export async function bootstrapNewMachine(options: BootstrapOptions): Promise<BootstrapResult> {
  const { exec } = options.deps;
  const cloned = await ensureClone(exec, options.repoUrl, options.dest, options.deps.auth ?? null);
  const read = await readManifest(options.dest);
  if (!read.ok) {
    throw new Error(`The config repo has no usable manifest: ${read.error}`);
  }
  const externalsCloned: string[] = [];
  for (const external of read.manifest.external) {
    const destination = checkoutOf(external, options.paths.home);
    if (!(await pathExists(destination))) {
      await clone(exec, external.repoUrl, destination);
      externalsCloned.push(destination);
    }
  }
  const actions = await planAll(read.manifest, options.dest, {
    paths: options.paths,
    host: options.host,
    agents: options.agents ?? [],
  });
  return {
    manifest: read.manifest,
    actions,
    summary: summarizePlan(actions, options.paths.home),
    cloned,
    externalsCloned,
  };
}
