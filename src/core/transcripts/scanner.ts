// Lists sessions under the projects dir from file metadata alone, and parses
// one session fully when asked. Layout:
//   <projectsDir>/<encoded-cwd>/<session-id>.jsonl
//   <projectsDir>/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl

import type { Dirent, Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { IngestResult, SessionAccumulatorOptions } from './accumulator.js';
import { SessionAccumulator } from './accumulator.js';
import { readAllLines } from './reader.js';
import { parseTranscriptLine } from './schemas.js';
import { listSubagentFiles, readSubagentMeta } from './subagents.js';

export interface SessionFileInfo {
  readonly sessionId: string;
  /** The encoded cwd folder name. */
  readonly projectDir: string;
  readonly transcriptPath: string;
  /** Folder that holds subagent transcripts. It may not exist. */
  readonly sessionDir: string;
  /** Latest of the transcript and the subagents folder, so a new subagent counts as activity. */
  readonly mtimeMs: number;
  /** Size of the main transcript in bytes. */
  readonly size: number;
}

export type SessionTarget = Pick<SessionFileInfo, 'sessionId' | 'transcriptPath' | 'sessionDir'>;

export type LoadOptions = Omit<SessionAccumulatorOptions, 'sessionId' | 'transcriptPath'>;

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

async function describeSession(
  projectPath: string,
  fileName: string,
): Promise<SessionFileInfo | null> {
  const transcriptPath = path.join(projectPath, fileName);
  const info = await statOrNull(transcriptPath);
  if (info === null) {
    return null;
  }
  const sessionId = fileName.slice(0, -'.jsonl'.length);
  const sessionDir = path.join(projectPath, sessionId);
  const subagents = await statOrNull(path.join(sessionDir, 'subagents'));
  return {
    sessionId,
    projectDir: path.basename(projectPath),
    transcriptPath,
    sessionDir,
    mtimeMs: Math.max(info.mtimeMs, subagents?.mtimeMs ?? 0),
    size: info.size,
  };
}

/** Every session transcript, newest first. Unreadable entries are skipped. */
export async function scanSessions(projectsDir: string): Promise<SessionFileInfo[]> {
  const sessions: SessionFileInfo[] = [];
  for (const project of await listDir(projectsDir)) {
    if (!project.isDirectory()) {
      continue;
    }
    const projectPath = path.join(projectsDir, project.name);
    for (const entry of await listDir(projectPath)) {
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl')) {
        const described = await describeSession(projectPath, entry.name);
        if (described !== null) {
          sessions.push(described);
        }
      }
    }
  }
  return sessions.toSorted((left, right) => right.mtimeMs - left.mtimeMs);
}

/** Parse lines into the accumulator, skipping lines that are not records we read. */
export function ingestLines(
  accumulator: SessionAccumulator,
  lines: readonly string[],
  agentId: string,
): IngestResult[] {
  const results: IngestResult[] = [];
  for (const line of lines) {
    const record = parseTranscriptLine(line);
    if (record !== null) {
      results.push(accumulator.ingest(record, agentId));
    }
  }
  return results;
}

/** Read a whole session, main thread and subagents, into a new accumulator. */
export async function loadSession(
  target: SessionTarget,
  options: LoadOptions = {},
): Promise<SessionAccumulator> {
  const accumulator = new SessionAccumulator({
    ...options,
    sessionId: target.sessionId,
    transcriptPath: target.transcriptPath,
  });
  ingestLines(accumulator, await readAllLines(target.transcriptPath), target.sessionId);
  for (const file of await listSubagentFiles(target.sessionDir)) {
    accumulator.addSubagent(
      file.agentId,
      await readSubagentMeta(file.metaPath),
      file.transcriptPath,
    );
    ingestLines(accumulator, await readAllLines(file.transcriptPath), file.agentId);
  }
  return accumulator;
}
