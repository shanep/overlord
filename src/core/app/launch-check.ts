// Connects the launch check to the app: git, gh and files through the
// runtime, Overlord's worktrees from the cache, and the setting that turns it
// off. A worktree handed to a session starts its repository's check.

import { LaunchChecker } from '../launch-check/checker.js';
import { probeRepo } from '../launch-check/probe.js';

import type { Runtime } from './runtime.js';
import { clockTime } from './views/connectors.js';
import { worktreeRoot } from './worktrees.js';

export function createLaunchChecker(rt: Runtime): LaunchChecker {
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
    probe: async (target) => probeRepo(probeDeps, target),
    worktrees: () => rt.caches.worktrees.value,
    now: rt.clock,
    formatTime: clockTime,
    report: (message): void => {
      rt.report('launch check', message);
    },
  });
}
