// Claude Code loads only the head of MEMORY.md: the first 200 lines or the
// first 25KB, whichever comes first. This finds where that cut falls.

import { Buffer } from 'node:buffer';

export const MEMORY_LINE_LIMIT = 200;
/** "25KB" in the docs. Claude Code counts it as 25,000 bytes. */
export const MEMORY_BYTE_LIMIT = 25_000;

export interface MemoryCut {
  readonly truncated: boolean;
  /** Which limit made the cut, or null when the whole file loads. */
  readonly limit: 'lines' | 'bytes' | null;
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly keptLines: number;
  readonly keptBytes: number;
  /** 1-based number of the first line that does not load, or null. */
  readonly firstDroppedLine: number | null;
  readonly detail: string;
}

function splitLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.slice(0, -1) : lines;
}

function describe(cut: Omit<MemoryCut, 'detail'>): string {
  const dropped = `lines ${String(cut.firstDroppedLine)} to ${String(cut.totalLines)}`;
  if (cut.limit === 'lines') {
    return `MEMORY.md has ${String(cut.totalLines)} lines, so ${dropped} are past the ${String(MEMORY_LINE_LIMIT)} line limit and do not load.`;
  }
  if (cut.limit === 'bytes') {
    return `MEMORY.md is ${String(cut.totalBytes)} bytes, so ${dropped} are past the ${String(MEMORY_BYTE_LIMIT)} byte limit and do not load.`;
  }
  return `MEMORY.md has ${String(cut.totalLines)} lines and ${String(cut.totalBytes)} bytes, so all of it loads.`;
}

export function checkMemoryTruncation(text: string): MemoryCut {
  const lines = splitLines(text);
  let keptLines = 0;
  let keptBytes = 0;
  let limit: MemoryCut['limit'] = null;
  for (const [index, line] of lines.entries()) {
    if (index === MEMORY_LINE_LIMIT) {
      limit = 'lines';
      break;
    }
    const isLast = index === lines.length - 1 && !text.endsWith('\n');
    const size = Buffer.byteLength(line) + (isLast ? 0 : 1);
    if (keptBytes + size > MEMORY_BYTE_LIMIT) {
      limit = 'bytes';
      break;
    }
    keptLines += 1;
    keptBytes += size;
  }
  const cut = {
    truncated: limit !== null,
    limit,
    totalLines: lines.length,
    totalBytes: Buffer.byteLength(text),
    keptLines,
    keptBytes,
    firstDroppedLine: limit === null ? null : keptLines + 1,
  };
  return { ...cut, detail: describe(cut) };
}
