// The note a new session in an Overlord worktree gets about its repository:
// the warnings to raise with the user first, then what is fine as it is.

import path from 'node:path';

import type { LaunchCheck } from './probe.js';

export const LAUNCH_RULE = [
  'Tell the user about each warning in a short list at the top of your first reply, before other work.',
  'Where instructions conflict, ask which one applies before acting on it.',
  'The notes need no mention.',
].join(' ');

export function launchNote(check: LaunchCheck, formatTime: (at: number) => string): string {
  const warnings = check.findings.filter((finding) => finding.level === 'warn');
  const notes = check.findings.filter((finding) => finding.level === 'info');
  const heading = `Overlord launch check for ${path.basename(check.repoRoot)} at ${formatTime(check.checkedAt)}.`;
  return [
    heading,
    ...(warnings.length === 0
      ? ['No warnings.']
      : ['Warnings:', ...warnings.map((finding) => `- ${finding.text}`)]),
    ...(notes.length === 0 ? [] : ['Notes:', ...notes.map((finding) => `- ${finding.text}`)]),
    ...(warnings.length === 0 ? [] : [LAUNCH_RULE]),
  ].join('\n');
}
