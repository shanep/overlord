// What Overlord remembers about your leaderboard entry, in the extension's
// storage folder: the entry's random id and the name you last chose.

import path from 'node:path';

import { writeFileAtomic } from '../knobs/atomic-file.js';
import { readJsonOrUndefined } from '../sync/files.js';

export const SAVED_FILE = 'leaderboard.json';

export interface SavedEntry {
  /** Null until the first upload, and again after removing it. */
  readonly entryId: string | null;
  /** The name you last uploaded under. Empty is anonymous, null is never chosen. */
  readonly name: string | null;
}

const NO_ENTRY: SavedEntry = { entryId: null, name: null };

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export async function loadSaved(storageDir: string): Promise<SavedEntry> {
  const data = await readJsonOrUndefined(path.join(storageDir, SAVED_FILE));
  if (typeof data !== 'object' || data === null) {
    return NO_ENTRY;
  }
  return {
    entryId: textOrNull(Reflect.get(data, 'entryId')),
    name: textOrNull(Reflect.get(data, 'name')),
  };
}

export async function saveSaved(storageDir: string, saved: SavedEntry): Promise<void> {
  await writeFileAtomic({
    target: path.join(storageDir, SAVED_FILE),
    content: `${JSON.stringify(saved, null, 2)}\n`,
    backup: null,
  });
}
