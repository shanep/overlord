import { describe, expect, it } from 'vitest';

import { fileList, topicOf } from './notes.js';

describe('topicOf', () => {
  it('keeps the first line, squeezes spaces and cuts long ones', () => {
    expect(topicOf('  Fix   the parser \n and the rest')).toBe('Fix the parser');
    expect(topicOf(' \n ')).toBeNull();
    const long = topicOf('word '.repeat(30));
    expect(long).toMatch(/^word word .*\.\.\.$/u);
    expect(long?.length).toBeLessThanOrEqual(80);
  });
});

describe('fileList', () => {
  it('lists up to eight files and counts the rest', () => {
    expect(fileList(['a', 'b'])).toBe('a, b');
    const many = Array.from({ length: 9 }, (_, index) => `f${String(index)}`);
    expect(fileList(many)).toBe('f0, f1, f2, f3, f4, f5, f6, f7 and 1 more');
  });
});
