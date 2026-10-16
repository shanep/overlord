import { describe, expect, it } from 'vitest';

import { checkMemoryTruncation, MEMORY_BYTE_LIMIT, MEMORY_LINE_LIMIT } from './memory.js';

function lines(count: number, width = 1): string {
  return Array.from({ length: count }, () => 'x'.repeat(width)).join('\n');
}

describe('checkMemoryTruncation', () => {
  it('uses the documented limits', () => {
    expect(MEMORY_LINE_LIMIT).toBe(200);
    expect(MEMORY_BYTE_LIMIT).toBe(25_000);
  });

  it('handles an empty file', () => {
    expect(checkMemoryTruncation('')).toStrictEqual({
      truncated: false,
      limit: null,
      totalLines: 0,
      totalBytes: 0,
      keptLines: 0,
      keptBytes: 0,
      firstDroppedLine: null,
      detail: 'MEMORY.md has 0 lines and 0 bytes, so all of it loads.',
    });
  });

  it('keeps a file inside both limits whole', () => {
    expect(checkMemoryTruncation('a\nbb\n')).toStrictEqual({
      truncated: false,
      limit: null,
      totalLines: 2,
      totalBytes: 5,
      keptLines: 2,
      keptBytes: 5,
      firstDroppedLine: null,
      detail: 'MEMORY.md has 2 lines and 5 bytes, so all of it loads.',
    });
    const noFinalNewline = checkMemoryTruncation('a\nbb');
    expect(noFinalNewline.keptBytes).toBe(4);
    expect(noFinalNewline.totalLines).toBe(2);
  });

  it('keeps exactly 200 lines and cuts the 201st', () => {
    expect(checkMemoryTruncation(lines(200)).truncated).toBe(false);
    expect(checkMemoryTruncation(`${lines(200)}\n`).truncated).toBe(false);
    const cut = checkMemoryTruncation(lines(260));
    expect(cut).toStrictEqual({
      truncated: true,
      limit: 'lines',
      totalLines: 260,
      totalBytes: 519,
      keptLines: 200,
      keptBytes: 400,
      firstDroppedLine: 201,
      detail:
        'MEMORY.md has 260 lines, so lines 201 to 260 are past the 200 line limit and do not load.',
    });
  });

  it('cuts at the byte limit before the line limit', () => {
    // 100 lines of 299 characters plus a newline is 30,000 bytes.
    const cut = checkMemoryTruncation(lines(100, 299));
    expect(cut.limit).toBe('bytes');
    expect(cut.keptLines).toBe(83);
    expect(cut.keptBytes).toBe(24_900);
    expect(cut.firstDroppedLine).toBe(84);
    expect(cut.totalBytes).toBe(29_999);
    expect(cut.detail).toBe(
      'MEMORY.md is 29999 bytes, so lines 84 to 100 are past the 25000 byte limit and do not load.',
    );
  });

  it('keeps a file that ends exactly on the byte limit', () => {
    // 100 lines of 249 characters plus a newline is exactly 25,000 bytes.
    const exact = checkMemoryTruncation(`${lines(100, 249)}\n`);
    expect(exact.truncated).toBe(false);
    expect(exact.keptBytes).toBe(25_000);
    const over = checkMemoryTruncation(`${lines(100, 249)}\nx`);
    expect(over.limit).toBe('bytes');
    expect(over.keptLines).toBe(100);
  });

  it('counts bytes, not characters', () => {
    const cut = checkMemoryTruncation('é\n');
    expect(cut.totalBytes).toBe(3);
    expect(cut.keptBytes).toBe(3);
  });
});
