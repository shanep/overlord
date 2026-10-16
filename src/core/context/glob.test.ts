import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { firstMatch } from './glob.js';

const segment = fc.stringMatching(/^[a-z0-9_-]{1,8}$/u);
const relativePath = fc
  .array(segment, { minLength: 1, maxLength: 5 })
  .map((parts) => parts.join('/'));

describe('firstMatch', () => {
  it('returns the first pattern that matches', () => {
    expect(firstMatch(['*.md', 'src/**/*.ts', '**/*.ts'], 'src/a/b.ts')).toBe('src/**/*.ts');
    expect(firstMatch(['lib/**'], 'src/a.ts')).toBeNull();
    expect(firstMatch([], 'x')).toBeNull();
  });

  it('follows the documented examples', () => {
    expect(firstMatch(['*.md'], 'README.md')).toBe('*.md');
    expect(firstMatch(['*.md'], 'docs/README.md')).toBeNull();
    expect(firstMatch(['src/**/*.{ts,tsx}'], 'src/ui/App.tsx')).toBe('src/**/*.{ts,tsx}');
    expect(firstMatch(['**/vendor/**'], '/repo/x/vendor/CLAUDE.md')).toBe('**/vendor/**');
    expect(firstMatch(['**/*.ts'], '.hidden/x.ts')).toBe('**/*.ts');
  });

  it('skips empty patterns instead of throwing', () => {
    expect(firstMatch(['', 'a'], 'a')).toBe('a');
    expect(firstMatch([''], '')).toBeNull();
  });

  it('matches a literal path with itself', () => {
    fc.assert(
      fc.property(relativePath, (target) => {
        expect(firstMatch([target], target)).toBe(target);
      }),
    );
  });

  it('matches any depth with **/*.ext and only that extension', () => {
    fc.assert(
      fc.property(relativePath, segment, (base, extension) => {
        expect(firstMatch([`**/*.${extension}`], `${base}.${extension}`)).toBe(`**/*.${extension}`);
        expect(firstMatch([`**/*.${extension}`], `${base}.${extension}x`)).toBeNull();
      }),
    );
  });

  it('keeps a single star inside one segment', () => {
    fc.assert(
      fc.property(segment, segment, segment, (a, b, c) => {
        expect(firstMatch([`${a}/*`], `${a}/${b}`)).toBe(`${a}/*`);
        expect(firstMatch([`${a}/*`], `${a}/${b}/${c}`)).toBeNull();
      }),
    );
  });
});
