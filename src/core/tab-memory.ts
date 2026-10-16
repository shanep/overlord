// Which Claude tab runs which session, kept across window reloads. A reload
// keeps the terminal processes running and VS Code reconnects the tabs to
// them, so a tab is found again by its shell pid. Overlord stores the pid and
// session id when it opens a tab, and on activation matches the stored pids
// against the terminals that came back.

import { z } from 'zod';

const storedSchema = z.record(z.string().regex(/^\d+$/u), z.string().min(1));

/** Shell pid (as a string, since it is a JSON key) to session id. */
export type StoredTabs = Readonly<Record<string, string>>;

/** The stored tabs, or none when the value is missing or not in the expected shape. */
export function parseStoredTabs(value: unknown): StoredTabs {
  const parsed = storedSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function rememberTab(stored: StoredTabs, pid: number, sessionId: string): StoredTabs {
  return { ...stored, [String(pid)]: sessionId };
}

export function forgetTab(stored: StoredTabs, pid: number): StoredTabs {
  return Object.fromEntries(Object.entries(stored).filter(([key]) => key !== String(pid)));
}

export interface RestoredTabs {
  /** Session ids for the terminals that are still open, by shell pid. */
  readonly matched: ReadonlyMap<number, string>;
  /** What to store from now on: only the tabs still open. */
  readonly kept: StoredTabs;
}

/** Matches stored tabs to the shell pids of the terminals open after a reload. */
export function restoreTabs(stored: StoredTabs, openPids: readonly number[]): RestoredTabs {
  const matched = new Map<number, string>();
  for (const pid of openPids) {
    const sessionId = stored[String(pid)];
    if (sessionId !== undefined) {
      matched.set(pid, sessionId);
    }
  }
  const kept = Object.fromEntries([...matched].map(([pid, sessionId]) => [String(pid), sessionId]));
  return { matched, kept };
}
