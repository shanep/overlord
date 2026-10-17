// Claude Code's sessions for the Tuning view: the transcripts under
// ~/.claude/projects with their subagent transcripts beside them, measured by
// tuning/measure.ts, which reads Claude's denial text, model ids and cache
// fields.

import { readAllLines } from '../../transcripts/reader.js';
import { scanSessions } from '../../transcripts/scanner.js';
import { listSubagentFiles } from '../../transcripts/subagents.js';
import type { SessionMeasure } from '../../tuning/measure.js';
import { measureSession } from '../../tuning/measure.js';
import type { TuningFacet, TuningSession } from '../types.js';

const JSONL = '.jsonl';

/** Every session under projectsDir, newest first. */
export async function claudeTuningSessions(projectsDir: string): Promise<TuningSession[]> {
  const found = await scanSessions(projectsDir);
  return found.map((info) => ({
    sessionId: info.sessionId,
    path: info.transcriptPath,
    mtimeMs: info.mtimeMs,
    size: info.size,
  }));
}

/** Reads a session's transcript and its subagents' and measures them. */
export async function measureClaudeSession(session: TuningSession): Promise<SessionMeasure> {
  // The subagents sit in a folder named like the transcript without .jsonl.
  const sessionDir = session.path.slice(0, -JSONL.length);
  const subagents: string[][] = [];
  for (const file of await listSubagentFiles(sessionDir)) {
    subagents.push(await readAllLines(file.transcriptPath));
  }
  return measureSession({
    sessionId: session.sessionId,
    main: await readAllLines(session.path),
    subagents,
    fallbackAt: session.mtimeMs,
  });
}

export const claudeTuning: TuningFacet = {
  sessions: async (context) => claudeTuningSessions(context.claude.projectsDir),
  measure: measureClaudeSession,
};
