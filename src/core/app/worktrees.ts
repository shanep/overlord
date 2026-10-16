// Worktrees in the app. Every Claude session Overlord starts, from the
// launcher or the New Session command, works in its own worktree, so many
// sessions can share a repository without touching each other's files or the
// main checkout. This file builds the registry, adapts it for the launcher,
// and starts and ends interactive sessions in worktrees.

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { WorktreeLease, WorktreeProvider } from '../harness/launcher.js';
import type { ClaudePaths } from '../paths.js';
import { readSessionRegistry } from '../surfaces/live.js';
import { liveEntries } from '../surfaces/places.js';
import type { IsAlive } from '../surfaces/process.js';
import type { Exec } from '../sync/exec.js';
import { NotARepoError, WorktreeGit } from '../worktrees/git.js';
import { type Lease, WorktreeRegistry } from '../worktrees/registry.js';

import { messageOf } from './errors.js';
import type { Runtime } from './runtime.js';

/** How often finished worktrees are checked and the landed ones removed. */
export const WORKTREE_REFRESH_MS = 60_000;
const SOURCE = 'worktrees';

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
    liveCwds: async (): Promise<readonly string[]> => {
      const registry = await readSessionRegistry(inputs.paths);
      return liveEntries(registry.items, inputs.isAlive).flatMap((entry) =>
        entry.cwd === null ? [] : [entry.cwd],
      );
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
      for (const warning of lease.warnings) {
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

function openSession(rt: Runtime, lease: Lease, sessionId: string): void {
  rt.sessionWorktrees.set(sessionId, lease.entry.id);
  rt.host.runInTerminal({
    name: 'Claude Code',
    command: rt.host.settings.claudePath,
    args: ['--session-id', sessionId],
    cwd: lease.entry.path,
    sessionId,
    env: lease.env,
  });
  void rt.caches.worktrees.refresh();
}

/**
 * Starts an interactive Claude Code session in a new worktree of the
 * workspace's repository. A folder outside git, or no folder at all, gets a
 * plain session there instead.
 */
export async function newSession(rt: Runtime): Promise<void> {
  const folder = rt.host.workspaceFolder();
  const sessionId = randomUUID();
  if (folder !== null) {
    try {
      const lease = await rt.worktrees.acquire({
        cwd: folder,
        id: sessionId,
        kind: 'session',
        label: `Session in ${path.basename(folder)}`,
      });
      for (const warning of lease.warnings) {
        rt.host.showWarning(warning);
      }
      openSession(rt, lease, sessionId);
      return;
    } catch (error: unknown) {
      if (!(error instanceof NotARepoError)) {
        rt.host.showWarning(`Starting without a worktree: ${messageOf(error)}`);
      }
    }
  }
  rt.host.runInTerminal({
    name: 'Claude Code',
    command: rt.host.settings.claudePath,
    args: ['--session-id', sessionId],
    cwd: folder ?? rt.paths.home,
    sessionId,
  });
}

/** Opens a new session in a worktree that is still around, to finish its work. */
export async function openWorktree(rt: Runtime, id: string): Promise<void> {
  openSession(rt, await rt.worktrees.hold(id), randomUUID());
}

/** A session tab closed. Its worktree goes too when everything in it has landed. */
export async function sessionClosed(rt: Runtime, sessionId: string): Promise<void> {
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
