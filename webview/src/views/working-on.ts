// The one line a Fleet row shows on what its session is working on.

import type { SessionSummary } from '../../../src/shared/model.js';

function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim();
}

/**
 * What a session is working on: Claude Code's recap, unless the user has
 * asked for something since it was written, and then that prompt.
 */
export function workingOn(session: SessionSummary): string | null {
  const { recap, lastPrompt, lastPromptAt } = session;
  const askedSince = lastPrompt !== null && (recap === null || (lastPromptAt ?? 0) > recap.at);
  if (askedSince) {
    return `Asked: ${oneLine(lastPrompt)}`;
  }
  return recap === null ? null : oneLine(recap.text);
}
