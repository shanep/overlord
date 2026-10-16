// A cheap look at a transcript for list views: the folder it ran in and its
// title, read from the first and last few KB instead of the whole file.

import { open } from 'node:fs/promises';

import { parseTranscriptLine } from './schemas.js';
import type { TranscriptRecord } from './schemas.js';

export interface SessionPeek {
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  /** The user's /rename title, else Claude's generated title, else the last prompt. */
  readonly title: string | null;
}

export const PEEK_BYTES = 64 * 1024;
const TITLE_CHARS = 120;

interface PeekFields {
  cwd: string | null;
  gitBranch: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  lastPrompt: string | null;
}

async function readRange(file: string, start: number, length: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function records(text: string, dropFirst: boolean): TranscriptRecord[] {
  const lines = text.split('\n');
  // A chunk that starts mid-file begins with the tail of a cut line.
  const whole = dropFirst ? lines.slice(1) : lines;
  const parsed: TranscriptRecord[] = [];
  for (const line of whole) {
    const record = parseTranscriptLine(line);
    if (record !== null) {
      parsed.push(record);
    }
  }
  return parsed;
}

function nonEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function absorbFolder(fields: PeekFields, record: TranscriptRecord): void {
  if (fields.cwd !== null || !('cwd' in record) || typeof record.cwd !== 'string') {
    return;
  }
  fields.cwd = nonEmpty(record.cwd);
  fields.gitBranch = typeof record.gitBranch === 'string' ? nonEmpty(record.gitBranch) : null;
}

function absorbTitle(fields: PeekFields, record: TranscriptRecord): void {
  if (record.type === 'custom-title') {
    fields.customTitle = nonEmpty(record.customTitle) ?? fields.customTitle;
    return;
  }
  if (record.type === 'ai-title') {
    fields.aiTitle = nonEmpty(record.aiTitle) ?? fields.aiTitle;
    return;
  }
  if (record.type === 'last-prompt') {
    fields.lastPrompt = nonEmpty(record.lastPrompt) ?? fields.lastPrompt;
  }
}

function shorten(text: string): string {
  const line = text.replaceAll(/\s+/gu, ' ');
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 3)}...` : line;
}

export async function peekSession(
  file: string,
  size: number,
  bytes: number = PEEK_BYTES,
): Promise<SessionPeek> {
  const fields: PeekFields = {
    cwd: null,
    gitBranch: null,
    customTitle: null,
    aiTitle: null,
    lastPrompt: null,
  };
  const head = await readRange(file, 0, Math.min(bytes, size));
  const chunks = [records(head, false)];
  if (size > bytes) {
    const start = Math.max(bytes, size - bytes);
    chunks.push(records(await readRange(file, start, size - start), true));
  }
  // Later records win for titles, so read the head first and the tail last.
  for (const chunk of chunks) {
    for (const record of chunk) {
      absorbFolder(fields, record);
      absorbTitle(fields, record);
    }
  }
  const title = fields.customTitle ?? fields.aiTitle ?? fields.lastPrompt;
  return {
    cwd: fields.cwd,
    gitBranch: fields.gitBranch,
    title: title === null ? null : shorten(title),
  };
}
