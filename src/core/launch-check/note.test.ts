import { describe, expect, it } from 'vitest';

import { LAUNCH_RULE, launchNote } from './note.js';

const at = (time: number): string => `t${String(time)}`;

describe('launchNote', () => {
  it('lists warnings, then notes, then the rule', () => {
    const note = launchNote(
      {
        repoRoot: '/src/wt-apps',
        checkedAt: 5,
        findings: [
          { level: 'info', text: 'Fine.' },
          { level: 'warn', text: 'Broken.' },
        ],
      },
      at,
    );
    expect(note).toBe(
      [
        'Overlord launch check for wt-apps at t5.',
        'Warnings:',
        '- Broken.',
        'Notes:',
        '- Fine.',
        LAUNCH_RULE,
      ].join('\n'),
    );
  });

  it('says there are no warnings and leaves out the rule', () => {
    const note = launchNote({ repoRoot: '/r', checkedAt: 1, findings: [] }, at);
    expect(note).toBe('Overlord launch check for r at t1.\nNo warnings.');
  });
});
