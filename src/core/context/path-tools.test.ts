import { describe, expect, it } from 'vitest';

import {
  ancestorsRootFirst,
  envOff,
  envOn,
  expandHome,
  isInside,
  isInsideAny,
  joinUnder,
  relativePosix,
} from './path-tools.js';

describe('isInside', () => {
  it('accepts the same path and anything below it', () => {
    expect(isInside('/a', '/a')).toBe(true);
    expect(isInside('/a', '/a/b/c')).toBe(true);
    expect(isInside('/a', '/a/..hidden')).toBe(true);
  });

  it('rejects parents, siblings and lookalike prefixes', () => {
    expect(isInside('/a/b', '/a')).toBe(false);
    expect(isInside('/a', '/b')).toBe(false);
    expect(isInside('/a', '/ab')).toBe(false);
    expect(isInside('/a/b', '/a/c/d')).toBe(false);
  });

  it('checks a list of parents', () => {
    expect(isInsideAny(['/x', '/a'], '/a/b')).toBe(true);
    expect(isInsideAny(['/x', '/y'], '/a/b')).toBe(false);
    expect(isInsideAny([], '/a')).toBe(false);
  });
});

describe('ancestorsRootFirst', () => {
  it('walks from the root down', () => {
    expect(ancestorsRootFirst('/a/b/c')).toStrictEqual(['/', '/a', '/a/b', '/a/b/c']);
    expect(ancestorsRootFirst('/')).toStrictEqual(['/']);
    expect(ancestorsRootFirst('/a/b/../c')).toStrictEqual(['/', '/a', '/a/c']);
  });
});

describe('expandHome', () => {
  it('expands ~ and ~/ only', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/x/y.md', '/h')).toBe('/h/x/y.md');
    expect(expandHome('~other/x', '/h')).toBe('~other/x');
    expect(expandHome('/abs', '/h')).toBe('/abs');
    expect(expandHome('rel/~/x', '/h')).toBe('rel/~/x');
  });
});

describe('joinUnder', () => {
  it('keeps Windows separators for a Windows managed dir', () => {
    expect(joinUnder(String.raw`C:\Program Files\ClaudeCode`, 'CLAUDE.md')).toBe(
      String.raw`C:\Program Files\ClaudeCode\CLAUDE.md`,
    );
    expect(joinUnder(String.raw`d:\x`, '.claude', 'skills')).toBe(String.raw`d:\x\.claude\skills`);
  });

  it('uses posix joins otherwise', () => {
    expect(joinUnder('/etc/claude-code', 'CLAUDE.md')).toBe('/etc/claude-code/CLAUDE.md');
    expect(joinUnder('C:/x', 'y')).toBe('C:/x/y');
    expect(joinUnder(String.raw`xC:\y`, 'z')).toBe(String.raw`xC:\y/z`);
  });
});

describe('relativePosix', () => {
  it('gives a forward slash relative path', () => {
    expect(relativePosix('/a', '/a/b/c.ts')).toBe('b/c.ts');
    expect(relativePosix('/a', '/a')).toBe('');
  });
});

describe('envOn and envOff', () => {
  it('reads the documented words in any case, with spaces', () => {
    for (const word of ['1', 'true', 'YES', ' On ']) {
      expect(envOn(word)).toBe(true);
      expect(envOff(word)).toBe(false);
    }
    for (const word of ['0', 'False', 'no', 'OFF ']) {
      expect(envOff(word)).toBe(true);
      expect(envOn(word)).toBe(false);
    }
  });

  it('treats unset and other values as neither', () => {
    for (const word of [undefined, '', '2', 'enabled']) {
      expect(envOn(word)).toBe(false);
      expect(envOff(word)).toBe(false);
    }
  });
});
