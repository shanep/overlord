// Connects the compatibility check to the app: git, gh and files through the
// runtime, Overlord's worktrees from the cache, and the setting that turns it
// off. A worktree handed to a session starts its repository's check.

import { LaunchChecker } from '../launch-check/checker.js';
import type { ProbeTarget } from '../launch-check/probe.js';
import { probeRepo } from '../launch-check/probe.js';
import { NotARepoError, WorktreeGit } from '../worktrees/git.js';

import type { Runtime } from './runtime.js';
import { clockTime } from './views/connectors.js';
import { worktreeRoot } from './worktrees.js';

export function createLaunchChecker(rt: Runtime): LaunchChecker {
  const git = new WorktreeGit(rt.exec, worktreeRoot(rt.paths));
  const probeDeps = {
    exec: rt.exec,
    fs: rt.fs,
    home: rt.paths.home,
    userClaudeMd: rt.paths.userClaudeMd,
    projectsDir: rt.paths.projectsDir,
    worktreeRoot: worktreeRoot(rt.paths),
    now: rt.clock,
  };
  return new LaunchChecker({
    enabled: (): boolean => rt.host.settings.launchCheck,
    locate: async (cwd): Promise<ProbeTarget | null> => {
      try {
        const repoRoot = await git.repoRoot(cwd);
        return { repoRoot, target: await git.defaultBranch(repoRoot) };
      } catch (error: unknown) {
        if (error instanceof NotARepoError) {
          return null;
        }
        throw error;
      }
    },
    probe: async (target) => probeRepo(probeDeps, target),
    worktrees: () => rt.caches.worktrees.value,
    home: rt.paths.home,
    now: rt.clock,
    formatTime: clockTime,
    report: (message): void => {
      rt.report('compatibility check', message);
    },
  });
}
