// The tips view. Session measures live in an index file in the extension's
// storage folder, so a rescan only reads transcripts that changed. Building
// the state is a synchronous read of that index; a rescan runs in the
// background when the last one started more than a minute ago, and the panels
// re-render after.

import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { TipsState } from '../../../shared/protocol.js';
import { scanInto } from '../../tips/scan.js';
import type { TipsIndex } from '../../tips/store.js';
import { loadIndex, saveIndex } from '../../tips/store.js';
import type { SuggestionDefinition } from '../../tips/suggestions.js';
import { nameOf, SUGGESTIONS } from '../../tips/suggestions.js';
import { summarize } from '../../tips/summarize.js';
import { messageOf } from '../errors.js';
import type { Runtime } from '../runtime.js';

export const EMPTY_TIPS: TipsState = {
  sessions: 0,
  totalUsd: 0,
  cacheReadUsd: 0,
  averageContext: 0,
  largestContext: 0,
  tips: [],
  suggestions: [],
  rows: [],
  scannedAt: null,
};

export const TIPS_FILE = 'tips.json';
export const RESCAN_AFTER_MS = 60_000;
const SOURCE = 'tips';

interface Entry {
  index: TipsIndex | null;
  installed: ReadonlySet<string>;
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
  const fresh: Entry = { index: null, installed: new Set(), running: null, startedAt: null };
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

async function scan(rt: Runtime, entry: Entry): Promise<void> {
  const file = path.join(rt.host.storageDir, TIPS_FILE);
  if (entry.index === null) {
    entry.index = await loadIndex(file);
    // Show the saved measures while the scan runs.
    rt.notify();
  }
  const result = await scanInto(entry.index, rt.paths.projectsDir, rt.clock());
  entry.installed = await installedSuggestions(rt);
  // Nothing new means nothing to write, so an empty home leaves no file behind.
  if (result.filesRead > 0 || result.filesGone > 0) {
    await saveIndex(file, entry.index);
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

function stateOf(rt: Runtime, entry: Entry): TipsState {
  if (entry.index === null) {
    return EMPTY_TIPS;
  }
  return summarize({
    measures: [...entry.index.entries.values()].map((item) => item.measure),
    installed: entry.installed,
    home: rt.paths.home,
    scannedAt: entry.index.scannedAt,
  });
}

export function buildTips(rt: Runtime): TipsState {
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
export async function rescanTips(rt: Runtime): Promise<TipsState> {
  const entry = entryFor(rt);
  await run(rt, entry);
  return stateOf(rt, entry);
}
