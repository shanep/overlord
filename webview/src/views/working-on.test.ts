import { describe, expect, it } from 'vitest';

import { NOW, session } from '../../test/fixtures.js';

import { workingOn } from './working-on.js';

describe('workingOn', () => {
  const recap = { text: 'Built the panel.\n\nneeds input: land it?', at: NOW - 60_000 };

  it("uses Claude Code's recap on one line until the user asks for something newer", () => {
    expect(workingOn(session({ id: 's' }))).toBeNull();
    expect(workingOn(session({ id: 's', recap }))).toBe('Built the panel. needs input: land it?');
    const asked = { lastPrompt: 'Add  a\nsummary', lastPromptAt: NOW - 120_000 };
    expect(workingOn(session({ id: 's', recap, ...asked }))).toBe(
      'Built the panel. needs input: land it?',
    );
    expect(workingOn(session({ id: 's', recap, ...asked, lastPromptAt: NOW }))).toBe(
      'Asked: Add a summary',
    );
    expect(workingOn(session({ id: 's', ...asked, lastPromptAt: null }))).toBe(
      'Asked: Add a summary',
    );
    // A prompt with no time cannot be newer than the recap.
    expect(workingOn(session({ id: 's', recap, ...asked, lastPromptAt: null }))).toBe(
      'Built the panel. needs input: land it?',
    );
  });
});
