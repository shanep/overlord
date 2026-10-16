import { describe, expect, it } from 'vitest';

import { shellCommand, shellQuote } from './shell-quote.js';

describe('shellQuote', () => {
  it('leaves safe words alone', () => {
    expect(shellQuote('claude')).toBe('claude');
    expect(shellQuote('--resume=abc-123')).toBe('--resume=abc-123');
    expect(shellQuote('/a/b.c@x%y+z:1')).toBe('/a/b.c@x%y+z:1');
  });

  it('single quotes anything else', () => {
    expect(shellQuote('fix the bug')).toBe("'fix the bug'");
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe(String.raw`'it'\''s'`);
  });
});

describe('shellCommand', () => {
  it('joins the command and quoted args', () => {
    expect(shellCommand('claude', ['--cloud', 'add tests'])).toBe("claude --cloud 'add tests'");
    expect(shellCommand('claude', [])).toBe('claude');
  });
});
