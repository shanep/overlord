// Plan limits only change while a session runs, so with none active the
// newest sessions on disk still hold the current numbers. The watcher reads
// them once at startup, so the limit tiles have data right after a reload.

import { IncrementalReader } from '../../transcripts/reader.js';
import type { RateLimitReport, RecordAccumulator, SessionObserver } from '../types.js';

import { collectBatch } from './tailing-batch.js';

/** How many of the newest sessions are read for the plan limits they last reported. */
const SEED_SESSIONS = 3;

/** The newest limits any of the newest sessions reported, or null when none did. */
export async function latestLimits<A extends RecordAccumulator>(
  observer: SessionObserver<A>,
): Promise<RateLimitReport | null> {
  let newest: RateLimitReport | null = null;
  const sessions = await observer.scan();
  for (const info of sessions.slice(0, SEED_SESSIONS)) {
    const file = { path: info.transcriptPath, agentId: info.sessionId, metaPath: null };
    const accumulator = observer.makeAccumulator(info);
    await accumulator.prepare?.(file);
    const read = await new IncrementalReader(file.path).read();
    const report = collectBatch(
      read.lines.flatMap((line) => accumulator.ingest(line, file.agentId) ?? []),
    ).rateLimits;
    if (report !== null && (newest === null || report.at > newest.at)) {
      newest = report;
    }
  }
  return newest;
}
