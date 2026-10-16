// One rescan: measure every session whose transcript changed since the last
// scan, mark sessions whose transcript is gone as history, and forget history
// older than a year.

import { readAllLines } from '../transcripts/reader.js';
import type { SessionFileInfo } from '../transcripts/scanner.js';
import { scanSessions } from '../transcripts/scanner.js';
import { listSubagentFiles } from '../transcripts/subagents.js';

import { measureSession } from './measure.js';
import type { FileStamp, TipsIndex } from './store.js';

/** How long a measure outlives its transcript. */
export const HISTORY_MS = 365 * 24 * 60 * 60_000;

export interface ScanResult {
  readonly filesRead: number;
  /** Transcripts that went away since the last scan, plus history that expired. */
  readonly filesGone: number;
}

function sameStamp(left: FileStamp | undefined, right: FileStamp): boolean {
  return left?.mtimeMs === right.mtimeMs && left.size === right.size;
}

async function measureFile(info: SessionFileInfo): Promise<ReturnType<typeof measureSession>> {
  const subagents: string[][] = [];
  for (const file of await listSubagentFiles(info.sessionDir)) {
    subagents.push(await readAllLines(file.transcriptPath));
  }
  return measureSession({
    sessionId: info.sessionId,
    main: await readAllLines(info.transcriptPath),
    subagents,
    fallbackAt: info.mtimeMs,
  });
}

function markGone(index: TipsIndex, seen: ReadonlySet<string>, now: number): number {
  let changed = 0;
  for (const [file, entry] of index.entries) {
    if (seen.has(file)) {
      continue;
    }
    if (now - entry.measure.updatedAt > HISTORY_MS) {
      index.entries.delete(file);
      changed += 1;
    } else if (entry.live) {
      index.entries.set(file, { ...entry, live: false });
      changed += 1;
    }
  }
  return changed;
}

/** Updates `index` in place. Running it twice on the same files reads nothing the second time. */
export async function scanInto(
  index: TipsIndex,
  projectsDir: string,
  now: number,
): Promise<ScanResult> {
  const seen = new Set<string>();
  let filesRead = 0;
  for (const info of await scanSessions(projectsDir)) {
    seen.add(info.transcriptPath);
    const stamp: FileStamp = { mtimeMs: info.mtimeMs, size: info.size };
    const known = index.entries.get(info.transcriptPath);
    if (!sameStamp(known?.stamp, stamp)) {
      index.entries.set(info.transcriptPath, {
        stamp,
        measure: await measureFile(info),
        live: true,
      });
      filesRead += 1;
    } else if (known !== undefined && !known.live) {
      // A transcript that came back, for example restored from a backup.
      index.entries.set(info.transcriptPath, { ...known, live: true });
      filesRead += 1;
    }
  }
  const filesGone = markGone(index, seen, now);
  index.scannedAt = now;
  return { filesRead, filesGone };
}
