import { describe, expect, it } from 'vitest';

import { pickTitle } from './title.js';

describe('pickTitle', () => {
  it('prefers a trimmed title', () => {
    expect(pickTitle('  Hello  ', '/a/b', 'x')).toBe('Hello');
  });

  it('falls back to the cwd basename for a blank or missing title', () => {
    expect(pickTitle(null, '/a/proj', 'x')).toBe('proj');
    expect(pickTitle(' '.repeat(3), '/a/proj/', 'x')).toBe('proj');
  });

  it('falls back to the label when there is no usable cwd', () => {
    expect(pickTitle(null, null, 'Fallback')).toBe('Fallback');
    expect(pickTitle('', '/', 'Fallback')).toBe('Fallback');
    expect(pickTitle('', '', 'Fallback')).toBe('Fallback');
  });
});
