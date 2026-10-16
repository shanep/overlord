// The reputation view. The counts live in an index file in the extension's
// storage folder, so they survive transcript cleanup. Building the state is
// a synchronous read of that index; a rescan runs in the background when the
// last one started more than a minute ago, and the panels re-render after.

import path from 'node:path';

import type { ReputationState } from '../../../shared/protocol.js';
import { scanInto } from '../../reputation/scan.js';
import type { ReputationIndex } from '../../reputation/store.js';
import { loadIndex, saveIndex } from '../../reputation/store.js';
import { summarize } from '../../reputation/summarize.js';
import { messageOf } from '../errors.js';
import type { Runtime } from '../runtime.js';

export const EMPTY_REPUTATION: ReputationState = {
  prompts: 0,
  kind: 0,
  mean: 0,
  general: 0,
  score: 0,
  byDay: [],
  bySession: [],
  topKind: [],
  topMean: [],
  recent: [],
  scannedAt: null,
};

// The name is from when this was the Frustration view, so its counts carry over.
export const REPUTATION_FILE = 'frustration.json';
export const RESCAN_AFTER_MS = 60_000;
const SOURCE = 'reputation';

interface Entry {
  index: ReputationIndex | null;
  running: Promise<void> | null;
  startedAt: number | null;
}

// Caches are owned by caches.ts, so the index for each runtime lives here.
const entries = new WeakMap<Runtime, Entry>();

function entryFor(rt: Runtime): Entry {
  const found = entries.get(rt);
  if (found !== undefined) {
    return found;
  }
  const fresh: Entry = { index: null, running: null, startedAt: null };
  entries.set(rt, fresh);
  return fresh;
}

interface Loaded {
  readonly index: ReputationIndex;
  /** True when the file was corrupt, so it must be written even if nothing changed. */
  readonly rebuilt: boolean;
}

async function loaded(rt: Runtime, entry: Entry, file: string): Promise<Loaded> {
  if (entry.index !== null) {
    return { index: entry.index, rebuilt: false };
  }
  const result = await loadIndex(file, rt.clock());
  if (result.backup !== null) {
    rt.report(
      SOURCE,
      `The reputation index could not be read. It was copied to ${result.backup} and rebuilt.`,
    );
  }
  entry.index = result.index;
  // Show the saved counts while the scan runs.
  rt.notify();
  return { index: result.index, rebuilt: result.backup !== null };
}

async function scan(rt: Runtime, entry: Entry): Promise<void> {
  const file = path.join(rt.host.storageDir, REPUTATION_FILE);
  const { index, rebuilt } = await loaded(rt, entry, file);
  const result = await scanInto(index, {
    projectsDir: rt.paths.projectsDir,
    historyFile: path.join(rt.paths.configDir, 'history.jsonl'),
    now: rt.clock(),
  });
  // Nothing new means nothing to write, so an empty home leaves no file behind.
  if (rebuilt || result.filesRead > 0 || result.filesGone > 0) {
    await saveIndex(file, index);
  }
  rt.notify();
}

async function run(rt: Runtime, entry: Entry): Promise<void> {
  entry.startedAt = rt.clock();
  entry.running ??= scan(rt, entry).finally(() => {
    entry.running = null;
  });
  await entry.running;
}

function titles(rt: Runtime, index: ReputationIndex): (sessionId: string) => string {
  const live = new Map(
    rt.store.fleetState(rt.clock()).sessions.map((item) => [item.id, item.title]),
  );
  return (sessionId) =>
    live.get(sessionId) ??
    index.sessions.get(sessionId)?.title ??
    `Session ${sessionId.slice(0, 8)}`;
}

function stateOf(rt: Runtime, entry: Entry): ReputationState {
  return entry.index === null ? EMPTY_REPUTATION : summarize(entry.index, titles(rt, entry.index));
}

export function buildReputation(rt: Runtime): ReputationState {
  const entry = entryFor(rt);
  const stale = entry.startedAt === null || rt.clock() - entry.startedAt >= RESCAN_AFTER_MS;
  if (stale && entry.running === null) {
    run(rt, entry).catch((error: unknown) => {
      rt.report(SOURCE, messageOf(error));
    });
  }
  return stateOf(rt, entry);
}

/** Scans now, or waits for the scan already running, and returns the new state. */
export async function rescanReputation(rt: Runtime): Promise<ReputationState> {
  const entry = entryFor(rt);
  await run(rt, entry);
  return stateOf(rt, entry);
}
