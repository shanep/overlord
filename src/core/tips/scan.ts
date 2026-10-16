// One rescan: measure every session whose transcript changed since the last
// scan, and forget sessions whose transcript is gone.

import { readAllLines } from '../transcripts/reader.js';
import type { SessionFileInfo } from '../transcripts/scanner.js';
import { scanSessions } from '../transcripts/scanner.js';
import { listSubagentFiles } from '../transcripts/subagents.js';

import { measureSession } from './measure.js';
import type { FileStamp, TipsIndex } from './store.js';

export interface ScanResult {
  readonly filesRead: number;
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
    if (!sameStamp(index.entries.get(info.transcriptPath)?.stamp, stamp)) {
      index.entries.set(info.transcriptPath, { stamp, measure: await measureFile(info) });
      filesRead += 1;
    }
  }
  const gone = [...index.entries.keys()].filter((file) => !seen.has(file));
  for (const file of gone) {
    index.entries.delete(file);
  }
  index.scannedAt = now;
  return { filesRead, filesGone: gone.length };
}
