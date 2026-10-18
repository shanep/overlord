// Which Claude tab runs which session, kept across window reloads. A reload
// keeps the terminal processes running and VS Code reconnects the tabs to
// them, so a tab is found again by its shell pid. Overlord stores the pid and
// session id when it opens a tab, and on activation matches the stored pids
// against the terminals that came back.

import { z } from 'zod';

const tabSchema = z.object({
  sessionId: z.string().min(1),
  worktreeId: z.string().min(1).optional(),
});
const storedSchema = z.record(z.string().regex(/^\d+$/u), z.union([z.string().min(1), tabSchema]));

/** The session and, when applicable, its Overlord worktree. */
export interface StoredTab {
  readonly sessionId: string;
  readonly worktreeId?: string;
}

/** Shell pid (as a string, since it is a JSON key) to its restored tab details. */
export type StoredTabs = Readonly<Record<string, StoredTab>>;

function storedTab(sessionId: string, worktreeId?: string): StoredTab {
  return worktreeId === undefined ? { sessionId } : { sessionId, worktreeId };
}

/** The stored tabs, or none when the value is missing or not in the expected shape. */
export function parseStoredTabs(value: unknown): StoredTabs {
  const parsed = storedSchema.safeParse(value);
  if (!parsed.success) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(parsed.data).map(([pid, tab]) => [
      pid,
      typeof tab === 'string' ? storedTab(tab) : storedTab(tab.sessionId, tab.worktreeId),
    ]),
  );
}

export function rememberTab(
  stored: StoredTabs,
  pid: number,
  sessionId: string,
  worktreeId?: string,
): StoredTabs {
  return {
    ...stored,
    [String(pid)]: storedTab(sessionId, worktreeId),
  };
}

export function forgetTab(stored: StoredTabs, pid: number): StoredTabs {
  return Object.fromEntries(Object.entries(stored).filter(([key]) => key !== String(pid)));
}

export interface RestoredTabs {
  /** Tab details for the terminals that are still open, by shell pid. */
  readonly matched: ReadonlyMap<number, StoredTab>;
  /** What to store from now on: only the tabs still open. */
  readonly kept: StoredTabs;
}

/** Matches stored tabs to the shell pids of the terminals open after a reload. */
export function restoreTabs(stored: StoredTabs, openPids: readonly number[]): RestoredTabs {
  const matched = new Map<number, StoredTab>();
  for (const pid of openPids) {
    const tab = stored[String(pid)];
    if (tab !== undefined) {
      matched.set(pid, tab);
    }
  }
  const kept = Object.fromEntries([...matched].map(([pid, tab]) => [String(pid), tab]));
  return { matched, kept };
}
