// The leaderboard part of the Reputation view. The board is fetched in the
// background when the view is built and the last fetch is more than five
// minutes old, and never when the overlord.leaderboard.enabled setting is off.

import type { Board, LeaderboardState } from '../../../shared/leaderboard.js';
import { fetchBoard } from '../../leaderboard/client.js';
import type { SavedEntry } from '../../leaderboard/saved.js';
import { loadSaved, saveSaved } from '../../leaderboard/saved.js';
import { messageOf } from '../errors.js';
import type { Runtime } from '../runtime.js';

export const REFRESH_AFTER_MS = 5 * 60_000;

export const EMPTY_LEADERBOARD: LeaderboardState = {
  enabled: false,
  pageUrl: '',
  board: null,
  error: null,
  fetchedAt: null,
  mine: null,
};

interface Entry {
  board: Board | null;
  error: string | null;
  fetchedAt: number | null;
  startedAt: number | null;
  running: Promise<void> | null;
  saved: SavedEntry | null;
}

const entries = new WeakMap<Runtime, Entry>();

function entryFor(rt: Runtime): Entry {
  const found = entries.get(rt);
  if (found !== undefined) {
    return found;
  }
  const fresh: Entry = {
    board: null,
    error: null,
    fetchedAt: null,
    startedAt: null,
    running: null,
    saved: null,
  };
  entries.set(rt, fresh);
  return fresh;
}

/** On, with a server to call. */
export function leaderboardReady(rt: Runtime): boolean {
  return rt.host.settings.leaderboardEnabled && rt.host.settings.leaderboardUrl !== '';
}

export async function savedEntry(rt: Runtime): Promise<SavedEntry> {
  const entry = entryFor(rt);
  entry.saved ??= await loadSaved(rt.host.storageDir);
  return entry.saved;
}

export async function rememberEntry(rt: Runtime, saved: SavedEntry): Promise<void> {
  entryFor(rt).saved = saved;
  await saveSaved(rt.host.storageDir, saved);
}

async function fetchNow(rt: Runtime, entry: Entry): Promise<void> {
  try {
    const saved = await savedEntry(rt);
    entry.board = await fetchBoard(rt.fetch, rt.host.settings.leaderboardUrl, saved.entryId);
    entry.error = null;
    entry.fetchedAt = rt.clock();
  } catch (error: unknown) {
    entry.error = messageOf(error);
  }
  rt.notify();
}

/** Fetches the board now, or waits for the fetch already running. */
export async function refreshLeaderboard(rt: Runtime): Promise<void> {
  if (!leaderboardReady(rt)) {
    return;
  }
  const entry = entryFor(rt);
  entry.startedAt = rt.clock();
  entry.running ??= fetchNow(rt, entry).finally(() => {
    entry.running = null;
  });
  await entry.running;
}

export function buildLeaderboard(rt: Runtime): LeaderboardState {
  const { leaderboardEnabled, leaderboardUrl } = rt.host.settings;
  const entry = entryFor(rt);
  if (!leaderboardReady(rt)) {
    return { ...EMPTY_LEADERBOARD, enabled: leaderboardEnabled, pageUrl: leaderboardUrl };
  }
  const stale = entry.startedAt === null || rt.clock() - entry.startedAt >= REFRESH_AFTER_MS;
  if (stale && entry.running === null) {
    void refreshLeaderboard(rt);
  }
  return {
    enabled: true,
    pageUrl: leaderboardUrl,
    board: entry.board,
    error: entry.error,
    fetchedAt: entry.fetchedAt,
    mine: entry.saved?.entryId ?? null,
  };
}
