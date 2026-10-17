// The note every new session gets about its project: whether it is set up for
// Overlord, the Overlord features that will not work if not, the warnings to
// raise with the user first, then what is fine as it is.

import path from 'node:path';

import type { Finding } from './instructions.js';

export const NOT_SET_UP_RULE = [
  'Start your first reply by telling the user that this project is not fully set up for Overlord,',
  'then list each Overlord feature that is not available and each warning in a short list, with',
  'how to fix it, before other work. Where instructions conflict, ask which one applies before',
  'acting on it. The notes need no mention.',
].join(' ');

export const WARNING_RULE = [
  'Tell the user about each warning in a short list at the top of your first reply, before other work.',
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

export function compatNote(note: CompatNote, formatTime: (at: number) => string): string {
  const absent = note.findings.filter((finding) => finding.level === 'missing');
  const warnings = note.findings.filter((finding) => finding.level === 'warn');
  const notes = note.findings.filter((finding) => finding.level === 'info');
  const heading = `Overlord compatibility check for ${path.basename(note.folder)} at ${formatTime(note.checkedAt)}.`;
  const verdict =
    absent.length > 0
      ? 'This project is not fully set up for Overlord, so some Overlord features will not work in this session.'
      : 'This project is set up for Overlord.';
  const rule = absent.length > 0 ? NOT_SET_UP_RULE : WARNING_RULE;
  return [
    `${heading} ${verdict}`,
    ...section('Not available:', absent),
    ...section('Warnings:', warnings),
    ...section('Notes:', notes),
    ...(absent.length > 0 || warnings.length > 0 ? [rule] : []),
  ].join('\n');
}
