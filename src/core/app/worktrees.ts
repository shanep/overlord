// Worktrees in the app. Every Claude session Overlord starts, from the
// launcher or the New Session command, works in its own worktree, so many
// sessions can share a repository without touching each other's files or the
// main checkout. This file builds the registry, adapts it for the launcher,
// and starts and ends interactive sessions in worktrees.

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { bearerEnv, BRIDGE_ARGS, BRIDGE_BASE_URL } from '../bridge/boisestate.js';
import type { WorktreeLease, WorktreeProvider } from '../harness/launcher.js';
import type { ClaudePaths } from '../paths.js';
import { daemonJobCwds } from '../surfaces/daemon.js';
import { readSessionRegistry } from '../surfaces/live.js';
import { liveEntries } from '../surfaces/places.js';
import type { IsAlive } from '../surfaces/process.js';
import type { Exec } from '../sync/exec.js';
import { NotARepoError, WorktreeGit } from '../worktrees/git.js';
import { type Lease, WorktreeRegistry, worktreeEnv } from '../worktrees/registry.js';

import type { ClaudeTab } from './claude-tabs.js';
import { openClaudeTab } from './claude-tabs.js';
import { messageOf } from './errors.js';
import { stopIfIdle } from './idle-stop.js';
import type { Runtime } from './runtime.js';

/** How often finished worktrees are checked and the landed ones removed. */
export const WORKTREE_REFRESH_MS = 60_000;
const SOURCE = 'worktrees';
/** Starting a session in the background takes a couple of seconds, so a notification says so. */
export const STARTING = 'Starting Claude Code';

export interface RegistryInputs {
  readonly paths: ClaudePaths;
  readonly storageDir: string;
  readonly exec: Exec;
  readonly isAlive: IsAlive;
  readonly clock: () => number;
  readonly pid: number;
}

/** Worktrees live in ~/.overlord/worktrees, out of every repository. */
export function worktreeRoot(paths: ClaudePaths): string {
  return path.join(paths.home, '.overlord', 'worktrees');
}

export function createWorktreeRegistry(inputs: RegistryInputs): WorktreeRegistry {
  const root = worktreeRoot(inputs.paths);
  return new WorktreeRegistry({
    git: new WorktreeGit(inputs.exec, root),
    exec: inputs.exec,
    dir: path.join(inputs.storageDir, 'worktrees'),
    root,
    pid: inputs.pid,
    isAlive: inputs.isAlive,
    clock: inputs.clock,
    // A background job the daemon is restarting after a crash has no live
    // process for a few seconds, so its launch folder counts as well.
    liveCwds: async (): Promise<readonly string[]> => {
      const [registry, jobs] = await Promise.all([
        readSessionRegistry(inputs.paths),
        daemonJobCwds(inputs.paths, inputs.isAlive),
      ]);
      const running = liveEntries(registry.items, inputs.isAlive).flatMap((entry) =>
        entry.cwd === null ? [] : [entry.cwd],
      );
      return [...running, ...jobs];
    },
  });
}

/** The launcher's view of the registry. Setup warnings go to the error list. */
export function launcherWorktrees(
  registry: WorktreeRegistry,
  report: (source: string, message: string) => void,
  changed: () => void,
): WorktreeProvider {
  return {
    acquire: async (cwd, runId, label): Promise<WorktreeLease | null> => {
      let lease: Lease;
      try {
        lease = await registry.acquire({ cwd, id: runId, kind: 'run', label });
      } catch (error: unknown) {
        if (error instanceof NotARepoError) {
          return null;
        }
        throw error;
      }
      // A run starts working at once, so it waits for the whole setup.
      for (const warning of await lease.ready) {
        report(SOURCE, warning);
      }
      changed();
      return { path: lease.entry.path, env: lease.env };
    },
    release: async (runId): Promise<void> => {
      await registry.release(runId);
      changed();
    },
  };
}

/** Tidies finished worktrees and reloads the list. Failures go to the error list. */
export async function tidyWorktrees(rt: Runtime): Promise<void> {
  try {
    await rt.worktrees.reconcile();
  } catch (error: unknown) {
    rt.report(SOURCE, messageOf(error));
  }
  await rt.caches.worktrees.refresh();
}

async function showSetupWarnings(rt: Runtime, lease: Lease): Promise<void> {
  for (const warning of await lease.ready) {
    rt.host.showWarning(warning);
  }
}

/** A new session's tab: its title, and the first message when it should start working at once. */
export interface SessionStart {
  readonly name: string;
  readonly prompt?: string;
  /** The session this one continues as a fork, which stays as it was. */
  readonly forkOf?: string;
  /** Runs on Boise State's Opus 5.5 through this window's bridge sidecar. */
  readonly bridge?: boolean;
}

const PLAIN_START: SessionStart = { name: 'Claude Code' };
const BRIDGE_START: SessionStart = { name: 'Boise State', bridge: true };

/** What a tab adds for where its session runs: nothing, or the bridge's env and args. */
interface Backend {
  readonly env?: Readonly<Record<string, string>>;
  readonly args?: readonly string[];
  readonly foreground?: boolean;
}

const CLAUDE: Backend = {};

/**
 * The bridge's env and args, or null after saying why it cannot start. Its
 * sessions run in their tab, since the sidecar goes away with the window.
 */
async function bridgeBackend(rt: Runtime): Promise<Backend | null> {
  const resolve = rt.host.resolveBridgeEnv;
  if (resolve === undefined) {
    rt.host.showInfo('The Boise State bridge is not available in this window.');
    return null;
  }
  try {
    const env = await resolve({ ANTHROPIC_BASE_URL: BRIDGE_BASE_URL });
    return { env: bearerEnv(env), args: BRIDGE_ARGS, foreground: true };
  } catch (error: unknown) {
    rt.host.showWarning(messageOf(error));
    return null;
  }
}

/** The tab fields for a start: a new session, or a fork of forkOf. */
function tabStart(start: SessionStart): Pick<ClaudeTab, 'name' | 'prompt' | 'resume' | 'fork'> {
  const { forkOf, ...rest } = start;
  return forkOf === undefined ? { ...rest, resume: null } : { ...rest, resume: forkOf, fork: true };
}

/** What a new tab starts: the session, and where it runs. */
interface Opening {
  readonly start: SessionStart;
  readonly backend: Backend;
}

async function openSession(
  rt: Runtime,
  lease: Lease,
  newId: string,
  { start, backend }: Opening,
): Promise<void> {
  // The tab opens while setup finishes, since the user still has to type a
  // prompt. A session given its first prompt starts at once, so it waits.
  const setup = showSetupWarnings(rt, lease);
  if (start.prompt !== undefined) {
    await setup;
  }
  const sessionId = await openClaudeTab(rt, {
    ...tabStart(start),
    ...backend,
    cwd: lease.entry.path,
    env: { ...lease.env, ...backend.env },
    newId,
  });
  if (sessionId !== null) {
    rt.sessionWorktrees.set(sessionId, lease.entry.id);
  }
  void rt.caches.worktrees.refresh();
}

/**
 * Starts an interactive Claude Code session in a new worktree of the
 * repository folder is in. A folder outside git, or no folder at all, gets a
 * plain session there instead.
 */
export async function startSession(
  rt: Runtime,
  folder: string | null,
  start: SessionStart,
): Promise<void> {
  const backend = start.bridge === true ? await bridgeBackend(rt) : CLAUDE;
  if (backend === null) {
    return;
  }
  // The worktree takes this id, and so does the session when claude runs in the tab itself.
  const id = randomUUID();
  if (folder !== null) {
    try {
      const lease = await rt.worktrees.acquire({
        cwd: folder,
        id,
        kind: 'session',
        label: `Session in ${path.basename(folder)}`,
      });
      await openSession(rt, lease, id, { start, backend });
      return;
    } catch (error: unknown) {
      if (!(error instanceof NotARepoError)) {
        rt.host.showWarning(`Starting without a worktree: ${messageOf(error)}`);
      }
    }
  }
  await openClaudeTab(rt, {
    ...tabStart(start),
    ...backend,
    cwd: folder ?? rt.paths.home,
    newId: id,
  });
}

/**
 * Starts a session in a new worktree of the folder's repository, or in home
 * with no folder, on Claude Code's usual account or on the bridge.
 */
export async function newSession(
  rt: Runtime,
  folder: string | null,
  bridge = false,
): Promise<void> {
  await startSession(rt, folder, bridge ? BRIDGE_START : PLAIN_START);
}

/** Opens a new session in a worktree that is still around, to finish its work. */
export async function openWorktree(rt: Runtime, id: string): Promise<void> {
  await openSession(rt, await rt.worktrees.hold(id), randomUUID(), {
    start: PLAIN_START,
    backend: CLAUDE,
  });
}

/**
 * Makes a session's worktree again at its old path after it was tidied away,
 * since Claude Code finds a session by the folder it ran in. The worktree is
 * held for the session like a new one, so it goes again once its tab closes
 * with nothing left to land. False when the folder was never one of
 * Overlord's worktrees, or git could not make it.
 */
export async function restoreWorktree(
  rt: Runtime,
  sessionId: string,
  folder: string,
  title: string,
): Promise<boolean> {
  let lease: Lease | null;
  try {
    lease = await rt.worktrees.restore({
      path: folder,
      id: randomUUID(),
      kind: 'session',
      label: `Continued ${title}`,
    });
  } catch (error: unknown) {
    rt.report(SOURCE, messageOf(error));
    return false;
  }
  if (lease === null) {
    return false;
  }
  rt.sessionWorktrees.set(sessionId, lease.entry.id);
  void showSetupWarnings(rt, lease);
  void rt.caches.worktrees.refresh();
  return true;
}

/** The variables a session gets from the worktree this window holds for it, if any. */
export async function heldWorktreeEnv(
  rt: Runtime,
  sessionId: string,
): Promise<Readonly<Record<string, string>> | undefined> {
  const id = rt.sessionWorktrees.get(sessionId);
  const entries = id === undefined ? [] : await rt.worktrees.entries();
  const entry = entries.find((item) => item.id === id);
  return entry === undefined ? undefined : worktreeEnv(entry);
}

/**
 * A session tab closed. An idle background session stops, and its worktree
 * goes too when everything in it has landed.
 */
export async function sessionClosed(rt: Runtime, sessionId: string): Promise<void> {
  await stopIfIdle(rt, sessionId);
  const id = rt.sessionWorktrees.get(sessionId);
  if (id === undefined) {
    return;
  }
  rt.sessionWorktrees.delete(sessionId);
  try {
    await rt.worktrees.release(id);
  } catch (error: unknown) {
    rt.report(SOURCE, messageOf(error));
  }
  await rt.caches.worktrees.refresh();
}
