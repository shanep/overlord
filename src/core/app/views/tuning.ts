// The Tuning view. Session measures live in an index file in the extension's
// storage folder, so a rescan only reads transcripts that changed, and the
// tips you are tracking live in a second file next to it. Building the state
// is a synchronous read of both; a rescan runs in the background when the
// last one started more than a minute ago, and the panels re-render after.

import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { TuningState } from '../../../shared/tuning.js';
import { EMPTY_LIMIT, EMPTY_PICKS } from '../../../shared/tuning.js';
import type { PickTopic } from '../../catalog/picks.js';
import { installKey } from '../../catalog/picks.js';
import type { AdviceStep } from '../../tuning/build.js';
import { tipsTakenBy } from '../../tuning/build.js';
import { scanInto } from '../../tuning/scan.js';
import type { TuningIndex } from '../../tuning/store.js';
import { loadIndex, saveIndex } from '../../tuning/store.js';
import type { SuggestionDefinition } from '../../tuning/suggestions.js';
import { nameOf, SUGGESTIONS } from '../../tuning/suggestions.js';
import { summarize } from '../../tuning/summarize.js';
import { topicReason, topTopics } from '../../tuning/topics.js';
import { loadTracked, saveTracked } from '../../tuning/tracked.js';
import { messageOf } from '../errors.js';
import type { Runtime } from '../runtime.js';
import { TuningPicks } from '../tuning-picks.js';

import { currentPlan } from './usage.js';

export const EMPTY_TUNING: TuningState = {
  sessions: 0,
  totalUsd: 0,
  cacheReadUsd: 0,
  averageContext: 0,
  largestContext: 0,
  tips: [],
  suggestions: [],
  picks: EMPTY_PICKS,
  limit: EMPTY_LIMIT,
  rows: [],
  scannedAt: null,
};

export const TUNING_FILE = 'tuning.json';
export const TRACKED_FILE = 'tuning-tracked.json';
export const RESCAN_AFTER_MS = 60_000;
const SOURCE = 'tuning';

/** What the two files hold, loaded together so neither is ever seen without the other. */
interface Saved {
  readonly index: TuningIndex;
  /** When tracking started, by tip id. */
  readonly tracked: Map<string, number>;
}

interface Entry {
  saved: Saved | null;
  loading: Promise<Saved> | null;
  installed: ReadonlySet<string>;
  running: Promise<void> | null;
  startedAt: number | null;
  picks: TuningPicks | null;
  /** The topics worked out at the scan time in `topicsAt`, so a render does not redo them. */
  topics: readonly PickTopic[];
  topicsAt: number | null;
}

// Caches are owned by caches.ts, so the index for each runtime lives here.
const entries = new WeakMap<Runtime, Entry>();

function entryFor(rt: Runtime): Entry {
  const found = entries.get(rt);
  if (found !== undefined) {
    return found;
  }
  const fresh: Entry = {
    saved: null,
    loading: null,
    installed: new Set(),
    running: null,
    startedAt: null,
    picks: null,
    topics: [],
    topicsAt: null,
  };
  entries.set(rt, fresh);
  return fresh;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Where a saved copy of this suggestion would be, in the user and workspace folders. */
function candidateFiles(rt: Runtime, definition: SuggestionDefinition): string[] {
  const name = nameOf(definition);
  const workspace = rt.host.workspaceFolder();
  const claudeDirs =
    definition.kind === 'skill'
      ? [
          rt.paths.userSkillsDir,
          ...(workspace === null ? [] : [path.join(workspace, '.claude', 'skills')]),
        ]
      : [
          rt.paths.userAgentsDir,
          ...(workspace === null ? [] : [path.join(workspace, '.claude', 'agents')]),
        ];
  return claudeDirs.map((dir) =>
    definition.kind === 'skill' ? path.join(dir, name, 'SKILL.md') : path.join(dir, `${name}.md`),
  );
}

async function installedSuggestions(rt: Runtime): Promise<Set<string>> {
  const installed = new Set<string>();
  for (const definition of SUGGESTIONS) {
    for (const file of candidateFiles(rt, definition)) {
      if (await exists(file)) {
        installed.add(definition.id);
      }
    }
  }
  return installed;
}

/** Looks again for saved suggestions, after one is created. */
export async function refreshInstalled(rt: Runtime): Promise<void> {
  entryFor(rt).installed = await installedSuggestions(rt);
  rt.notify();
}

function trackedFile(rt: Runtime): string {
  return path.join(rt.host.storageDir, TRACKED_FILE);
}

function indexFile(rt: Runtime): string {
  return path.join(rt.host.storageDir, TUNING_FILE);
}

/** Reads both files once. A failed read is tried again next time. */
async function load(rt: Runtime, entry: Entry): Promise<Saved> {
  entry.loading ??= Promise.all([loadIndex(indexFile(rt)), loadTracked(trackedFile(rt))]).then(
    ([index, tracked]) => {
      entry.saved = { index, tracked };
      return entry.saved;
    },
    (error: unknown) => {
      entry.loading = null;
      throw error;
    },
  );
  return entry.loading;
}

async function scan(rt: Runtime, entry: Entry): Promise<void> {
  const first = entry.saved === null;
  const { index } = await load(rt, entry);
  if (first) {
    // Show the saved measures while the scan runs.
    rt.notify();
  }
  const result = await scanInto(index, rt.paths.projectsDir, rt.clock());
  entry.installed = await installedSuggestions(rt);
  // Nothing new means nothing to write, so an empty home leaves no file behind.
  if (result.filesRead > 0 || result.filesGone > 0) {
    await saveIndex(indexFile(rt), index);
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

function picksOf(rt: Runtime, entry: Entry): TuningPicks {
  entry.picks ??= new TuningPicks({
    reader: rt.catalogs.reader,
    fetch: rt.fetch,
    notify: (): void => {
      rt.notify();
    },
    clock: rt.clock,
  });
  return entry.picks;
}

/** Skills and agents already in the config inventory, as installKey keys. */
function installedNames(rt: Runtime): Set<string> {
  return new Set(
    rt.caches.config.value.items.flatMap((item) =>
      item.kind === 'skill' || item.kind === 'agent' ? [installKey(item.kind, item.name)] : [],
    ),
  );
}

/** The kinds of work the live sessions show, to search the catalogs for. */
function topicsOf(entry: Entry): readonly PickTopic[] {
  const index = entry.saved?.index;
  if (index === undefined || (entry.topicsAt === index.scannedAt && entry.topicsAt !== null)) {
    return entry.topics;
  }
  const live = [...index.entries.values()].filter((item) => item.live);
  entry.topicsAt = index.scannedAt;
  entry.topics = topTopics(live.map((item) => item.measure)).map((score) => ({
    label: score.topic.label,
    query: score.topic.query,
    words: score.topic.words,
    reason: topicReason(score),
  }));
  return entry.topics;
}

/** Searches the catalogs when the kinds of work changed or the last search is old. */
function refreshPicks(rt: Runtime, entry: Entry, force = false): void {
  if (entry.saved !== null) {
    picksOf(rt, entry).refresh(topicsOf(entry), installedNames(rt), force);
  }
}

/** The catalog picks, for the actions that open and install them. */
export function tuningPicks(rt: Runtime): TuningPicks {
  return picksOf(rt, entryFor(rt));
}

function stateOf(rt: Runtime, entry: Entry): TuningState {
  if (entry.saved === null) {
    return EMPTY_TUNING;
  }
  const { index, tracked } = entry.saved;
  const items = [...index.entries.values()];
  return summarize({
    measures: items.filter((item) => item.live).map((item) => item.measure),
    history: items.filter((item) => !item.live).map((item) => item.measure),
    tracked,
    now: rt.clock(),
    installed: entry.installed,
    home: rt.paths.home,
    scannedAt: index.scannedAt,
    plan: currentPlan(rt),
    picks: picksOf(rt, entry).view(installedNames(rt)),
  });
}

export function buildTuning(rt: Runtime): TuningState {
  const entry = entryFor(rt);
  const stale = entry.startedAt === null || rt.clock() - entry.startedAt >= RESCAN_AFTER_MS;
  if (stale && entry.running === null) {
    run(rt, entry).catch((error: unknown) => {
      rt.report(SOURCE, messageOf(error));
    });
  }
  refreshPicks(rt, entry);
  return stateOf(rt, entry);
}

/** Scans now, or waits for the scan already running, and returns the new state. */
export async function rescanTuning(rt: Runtime): Promise<TuningState> {
  const entry = entryFor(rt);
  await run(rt, entry);
  refreshPicks(rt, entry, true);
  return stateOf(rt, entry);
}

/** Starts tracking a tip from now, or stops when `on` is false. */
export async function setTipTracked(rt: Runtime, tipId: string, on: boolean): Promise<void> {
  const { tracked } = await load(rt, entryFor(rt));
  if (on) {
    tracked.set(tipId, rt.clock());
  } else {
    tracked.delete(tipId);
  }
  await saveTracked(trackedFile(rt), tracked);
  rt.notify();
}

/**
 * Starts tracking the tips this step follows, so taking advice from Overlord
 * measures itself without a separate click. Only tips the view shows right
 * now count, and one already tracked keeps its start.
 */
export async function trackAdviceTaken(rt: Runtime, step: AdviceStep): Promise<void> {
  const entry = entryFor(rt);
  const { tracked } = await load(rt, entry);
  const shown = new Set(stateOf(rt, entry).tips.map((tip) => tip.id));
  const fresh = tipsTakenBy(step).filter((id) => shown.has(id) && !tracked.has(id));
  if (fresh.length === 0) {
    return;
  }
  for (const id of fresh) {
    tracked.set(id, rt.clock());
  }
  await saveTracked(trackedFile(rt), tracked);
  rt.notify();
}
