// One rescan: read every main session transcript that changed since the last
// scan, then the prompt history, and merge what they hold into the index.
// Subagent transcripts are skipped, since a person never types into them.

import { stat } from 'node:fs/promises';

import { peekSession } from '../transcripts/peek.js';
import { readAllLines } from '../transcripts/reader.js';
import type { SessionFileInfo } from '../transcripts/scanner.js';
import { scanSessions } from '../transcripts/scanner.js';

import { historyPrompts, transcriptPrompts } from './prompts.js';
import type { FileStamp, FrustrationIndex } from './store.js';
import { addHistoryPrompt, addPrompt, claimSession } from './store.js';

export interface ScanInputs {
  readonly projectsDir: string;
  /** ~/.claude/history.jsonl. */
  readonly historyFile: string;
  readonly now: number;
}

export interface ScanResult {
  /** Transcripts and history files read because they changed. */
  readonly filesRead: number;
  readonly newPrompts: number;
  /** Stamps dropped for files that are gone. */
  readonly filesGone: number;
}

function sameStamp(left: FileStamp | undefined, right: FileStamp): boolean {
  return left?.mtimeMs === right.mtimeMs && left.size === right.size;
}

async function titleOf(info: SessionFileInfo): Promise<string | null> {
  try {
    const peek = await peekSession(info.transcriptPath, info.size);
    return peek.title;
  } catch {
    return null;
  }
}

async function readTranscript(index: FrustrationIndex, info: SessionFileInfo): Promise<number> {
  const lines = await readAllLines(info.transcriptPath);
  claimSession(index, info.sessionId, await titleOf(info));
  const prompts = transcriptPrompts(lines, {
    sessionId: info.sessionId,
    fallbackAt: info.mtimeMs,
  });
  return prompts.filter((prompt) => addPrompt(index, prompt)).length;
}

async function stampOf(file: string): Promise<FileStamp | null> {
  try {
    const info = await stat(file);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
}

async function readHistory(index: FrustrationIndex, file: string): Promise<number | null> {
  const stamp = await stampOf(file);
  if (stamp === null || sameStamp(index.files.get(file), stamp)) {
    return null;
  }
  const prompts = historyPrompts(await readAllLines(file));
  index.files.set(file, stamp);
  return prompts.filter((prompt) => addHistoryPrompt(index, prompt)).length;
}

/** Merges new prompts into `index` in place. Running it twice on the same files adds nothing. */
export async function scanInto(index: FrustrationIndex, inputs: ScanInputs): Promise<ScanResult> {
  const seen = new Set<string>([inputs.historyFile]);
  let filesRead = 0;
  let newPrompts = 0;
  for (const info of await scanSessions(inputs.projectsDir)) {
    seen.add(info.transcriptPath);
    const stamp: FileStamp = { mtimeMs: info.mtimeMs, size: info.size };
    if (!sameStamp(index.files.get(info.transcriptPath), stamp)) {
      newPrompts += await readTranscript(index, info);
      index.files.set(info.transcriptPath, stamp);
      filesRead += 1;
    }
  }
  const fromHistory = await readHistory(index, inputs.historyFile);
  // Deleted transcripts keep their prompts and sessions; only the file stamps go.
  const gone = [...index.files.keys()].filter((file) => !seen.has(file));
  for (const file of gone) {
    index.files.delete(file);
  }
  index.scannedAt = inputs.now;
  return {
    filesRead: filesRead + (fromHistory === null ? 0 : 1),
    newPrompts: newPrompts + (fromHistory ?? 0),
    filesGone: gone.length,
  };
}
