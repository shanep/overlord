// Worktree actions: start a session in a new worktree, continue one in
// another folder, and land, discard or reopen a finished one.

import { LandConflictError } from '../worktrees/git.js';

import type { ActionHandlers } from './action-types.js';
import { continueInFolder } from './relocate.js';
import type { Runtime } from './runtime.js';
import { plural } from './text.js';
import { newSession, openWorktree, STARTING } from './worktrees.js';

type WorktreeActions =
  'newSession' | 'continueInFolder' | 'landWorktree' | 'discardWorktree' | 'openWorktree';

function summary(rt: Runtime, id: string): { readonly label: string; readonly lost: string } {
  const found = rt.caches.worktrees.value.find((item) => item.id === id);
  if (found === undefined) {
    return { label: 'this worktree', lost: 'everything in it' };
  }
  const parts = [
    ...(found.dirty > 0 ? [plural(found.dirty, 'uncommitted file')] : []),
    ...(found.ahead > 0 ? [plural(found.ahead, 'unlanded commit')] : []),
  ];
  return { label: found.label, lost: parts.length === 0 ? 'nothing' : parts.join(' and ') };
}

export const worktreeActions: ActionHandlers<WorktreeActions> = {
  newSession: async ({ rt }) => rt.host.withProgress(STARTING, async () => newSession(rt)),
  continueInFolder: async ({ rt }, action) => continueInFolder(rt, action.sessionId),
  landWorktree: async ({ rt }, action) => {
    const { label } = summary(rt, action.id);
    try {
      await rt.worktrees.land(action.id);
      rt.host.showInfo(`Landed ${label}.`);
    } catch (error: unknown) {
      if (!(error instanceof LandConflictError)) {
        throw error;
      }
      rt.host.showWarning(`${error.message} Open a session in it to resolve the conflict.`);
    } finally {
      await rt.caches.worktrees.refresh();
    }
  },
  discardWorktree: async ({ rt }, action) => {
    const { label, lost } = summary(rt, action.id);
    if (!(await rt.host.confirm(`Discard ${label}? This deletes ${lost}.`, 'Discard'))) {
      return;
    }
    try {
      await rt.worktrees.discard(action.id);
    } finally {
      await rt.caches.worktrees.refresh();
    }
  },
  openWorktree: async ({ rt }, action) => openWorktree(rt, action.id),
};
