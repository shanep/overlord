// The note every new session gets about its project: whether it is set up for
// Overlord, the Overlord features that will not work if not, the warnings to
// raise with the user first, then what is fine as it is. Every session tells
// the user it ran the check, even when there is nothing to raise.

import path from 'node:path';

import type { Finding } from './instructions.js';

const CHECKED =
  'Start your first reply with one line saying you checked this project for Overlord compatibility';

export const SET_UP_RULE = `${CHECKED} and it is set up. The notes need no mention.`;

export const NOT_SET_UP_RULE = [
  `${CHECKED} and it is not fully set up for Overlord,`,
  'then list each Overlord feature that is not available and each warning in a short list, with',
  'how to fix it, before other work. Where instructions conflict, ask which one applies before',
  'acting on it. The notes need no mention.',
].join(' ');

export const WARNING_RULE = [
  `${CHECKED} and it is set up, then list each warning in a short list, before other work.`,
  'Where instructions conflict, ask which one applies before acting on it.',
  'The notes need no mention.',
].join(' ');

export interface CompatNote {
  /** The project's folder: the main checkout, or the session's folder outside git. */
  readonly folder: string;
  readonly checkedAt: number;
  readonly findings: readonly Finding[];
}

function section(title: string, findings: readonly Finding[]): string[] {
  return findings.length === 0 ? [] : [title, ...findings.map((finding) => `- ${finding.text}`)];
}

function ruleFor(absent: readonly Finding[], warnings: readonly Finding[]): string {
  if (absent.length > 0) {
    return NOT_SET_UP_RULE;
  }
  return warnings.length > 0 ? WARNING_RULE : SET_UP_RULE;
}

export function compatNote(note: CompatNote, formatTime: (at: number) => string): string {
  const absent = note.findings.filter((finding) => finding.level === 'missing');
  const warnings = note.findings.filter((finding) => finding.level === 'warn');
  const notes = note.findings.filter((finding) => finding.level === 'info');
  const heading = `Overlord compatibility check for ${path.basename(note.folder)} at ${formatTime(note.checkedAt)}.`;
  const verdict =
    absent.length > 0
      ? 'This project is not fully set up for Overlord, so some Overlord features will not work in this session.'
      : 'This project is set up for Overlord.';
  return [
    `${heading} ${verdict}`,
    ...section('Not available:', absent),
    ...section('Warnings:', warnings),
    ...section('Notes:', notes),
    ruleFor(absent, warnings),
  ].join('\n');
}
