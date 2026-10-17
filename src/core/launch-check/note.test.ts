import { describe, expect, it } from 'vitest';

import { NOT_SET_UP_RULE, WARNING_RULE, compatNote } from './note.js';

const at = (time: number): string => `t${String(time)}`;

describe('compatNote', () => {
  it('says what is not available, then warnings, notes and the rule', () => {
    const note = compatNote(
      {
        folder: '/src/wt-apps',
        checkedAt: 5,
        findings: [
          { level: 'info', text: 'Fine.' },
          { level: 'warn', text: 'Odd.' },
          { level: 'missing', text: 'Gone.' },
        ],
      },
      at,
    );
    expect(note).toBe(
      [
        'Overlord compatibility check for wt-apps at t5. This project is not fully set up for Overlord, so some Overlord features will not work in this session.',
        'Not available:',
        '- Gone.',
        'Warnings:',
        '- Odd.',
        'Notes:',
        '- Fine.',
        NOT_SET_UP_RULE,
      ].join('\n'),
    );
  });

  it('asks only for the warnings when the project is set up', () => {
    const note = compatNote(
      { folder: '/r', checkedAt: 1, findings: [{ level: 'warn', text: 'Odd.' }] },
      at,
    );
    expect(note).toBe(
      [
        'Overlord compatibility check for r at t1. This project is set up for Overlord.',
        'Warnings:',
        '- Odd.',
        WARNING_RULE,
      ].join('\n'),
    );
  });

  it('leaves out the rule when there is nothing to raise', () => {
    const note = compatNote(
      { folder: '/r', checkedAt: 1, findings: [{ level: 'info', text: 'Fine.' }] },
      at,
    );
    expect(note).toBe(
      'Overlord compatibility check for r at t1. This project is set up for Overlord.\nNotes:\n- Fine.',
    );
  });
});
